import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type {
  AppDetail,
  AppSummary,
  DeploymentInfo,
  MessageResponse,
  RollbackResponse,
  StartResponse,
  StopResponse,
  VersionResponse
} from '../../../src/types.ts'
import { createClient, type ErrorResponse } from '../client.ts'
import { logError, logHint, logInfo, logSuccess } from '../ui.ts'
import { VERSION } from '../version.ts'

const LOGS_DEFAULT_TIMEOUT_MS = 2000
const METRICS_DEFAULT_TIMEOUT_MS = 1500

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  [key: string]: unknown
}

interface ApiResponseLike<T> {
  status: number
  data: T | ErrorResponse
}

function ok(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return { content: [{ type: 'text', text }] }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

function unwrap<T>(response: ApiResponseLike<T>): T {
  if (response.status >= 400 || response.status === 0) {
    const error = (response.data as ErrorResponse)?.error ?? `HTTP ${response.status}`
    throw new Error(error)
  }
  return response.data as T
}

async function run<T>(operation: () => Promise<T>, format?: (value: T) => unknown): Promise<ToolResult> {
  try {
    const value = await operation()
    return ok(format ? format(value) : value)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

type Client = ReturnType<typeof createClient>

const confirmField = z
  .literal(true)
  .describe(
    'Required acknowledgment. Set to true only after the user has explicitly approved this state-changing action.'
  )

const readOnly = { readOnlyHint: true, openWorldHint: false }
const mutating = { readOnlyHint: false, openWorldHint: false }
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

function registerTools(server: McpServer, client: Client): void {
  server.registerTool(
    'list_apps',
    {
      title: 'List apps',
      description: 'List all apps deployed on the Zero server in the current project.',
      inputSchema: {},
      annotations: readOnly
    },
    async () =>
      run(
        async () => unwrap(await client.get<AppSummary[]>('/apps')),
        (apps) =>
          apps.map((app) => ({
            name: app.name,
            status: app.status,
            image: app.currentImage ?? app.image,
            trackTag: app.trackTag,
            domains: app.domains,
            deployedAt: app.deployedAt,
            previews: app.previews.length
          }))
      )
  )

  server.registerTool(
    'get_app',
    {
      title: 'Get app details',
      description: 'Show details of a single app: image, domains, env keys (masked), and current deployment.',
      inputSchema: { name: z.string().describe('App name') },
      annotations: readOnly
    },
    async ({ name }) => run(async () => unwrap(await client.get<AppDetail>(`/apps/${encodeURIComponent(name)}`)))
  )

  server.registerTool(
    'get_deployments',
    {
      title: 'Deployment history',
      description: 'List deployment history for an app (most recent first).',
      inputSchema: { name: z.string().describe('App name') },
      annotations: readOnly
    },
    async ({ name }) =>
      run(async () => unwrap(await client.get<DeploymentInfo[]>(`/apps/${encodeURIComponent(name)}/deployments`)))
  )

  server.registerTool(
    'deploy_app',
    {
      title: 'Deploy app',
      description:
        'Redeploy an existing app, optionally pinning an image tag. Replaces the current container after health checks pass. Requires confirm=true.',
      inputSchema: {
        name: z.string().describe('App name'),
        tag: z.string().optional().describe("Optional image tag to deploy (defaults to the app's tracked tag)"),
        confirm: confirmField
      },
      annotations: mutating
    },
    async ({ name, tag }) =>
      run(async () =>
        unwrap(
          await client.post<{ success: boolean; image?: string; port?: number; error?: string }>(
            `/apps/${encodeURIComponent(name)}/deploy`,
            tag ? { tag } : {}
          )
        )
      )
  )

  server.registerTool(
    'start_app',
    {
      title: 'Start app',
      description: 'Start a stopped app. Requires confirm=true.',
      inputSchema: {
        name: z.string().describe('App name'),
        confirm: confirmField
      },
      annotations: mutating
    },
    async ({ name }) =>
      run(async () => unwrap(await client.post<StartResponse>(`/apps/${encodeURIComponent(name)}/start`)))
  )

  server.registerTool(
    'stop_app',
    {
      title: 'Stop app',
      description: 'Stop a running app (container is preserved). Causes downtime — requires confirm=true.',
      inputSchema: {
        name: z.string().describe('App name'),
        confirm: confirmField
      },
      annotations: mutating
    },
    async ({ name }) =>
      run(async () => unwrap(await client.post<StopResponse>(`/apps/${encodeURIComponent(name)}/stop`)))
  )

  server.registerTool(
    'rollback_app',
    {
      title: 'Rollback app',
      description: 'Roll back an app to the previous successful deployment. Requires confirm=true.',
      inputSchema: {
        name: z.string().describe('App name'),
        confirm: confirmField
      },
      annotations: mutating
    },
    async ({ name }) =>
      run(async () => unwrap(await client.post<RollbackResponse>(`/apps/${encodeURIComponent(name)}/rollback`)))
  )

  server.registerTool(
    'remove_app',
    {
      title: 'Remove app',
      description:
        'Permanently remove an app, all its containers, and previews. Irreversible — requires confirm=true.',
      inputSchema: {
        name: z.string().describe('App name'),
        confirm: confirmField
      },
      annotations: destructive
    },
    async ({ name }) =>
      run(async () => unwrap(await client.del<MessageResponse>(`/apps/${encodeURIComponent(name)}`)))
  )

  server.registerTool(
    'set_env',
    {
      title: 'Set environment variables',
      description:
        'Set or update environment variables for an app. Redeploy (deploy_app) for changes to take effect. Requires confirm=true.',
      inputSchema: {
        name: z.string().describe('App name'),
        env: z.record(z.string()).describe('Map of env var names to values'),
        confirm: confirmField
      },
      annotations: mutating
    },
    async ({ name, env }) =>
      run(async () => unwrap(await client.patch<MessageResponse>(`/apps/${encodeURIComponent(name)}/env`, env)))
  )

  server.registerTool(
    'unset_env',
    {
      title: 'Remove environment variables',
      description: 'Remove one or more environment variables from an app. Requires confirm=true.',
      inputSchema: {
        name: z.string().describe('App name'),
        keys: z.array(z.string()).min(1).describe('List of env var names to remove'),
        confirm: confirmField
      },
      annotations: destructive
    },
    async ({ name, keys }) => {
      const query = keys.map((k) => `key=${encodeURIComponent(k)}`).join('&')
      return run(async () =>
        unwrap(await client.del<MessageResponse>(`/apps/${encodeURIComponent(name)}/env?${query}`))
      )
    }
  )

  server.registerTool(
    'get_logs',
    {
      title: 'Fetch app logs',
      description:
        "Fetch the last N lines of an app's logs. Briefly attaches to the log stream and returns lines emitted within the timeout window.",
      inputSchema: {
        name: z.string().describe('App name'),
        tail: z.number().int().positive().max(1000).optional().describe('Number of lines to retrieve (default 100)'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(15000)
          .optional()
          .describe(`How long to wait collecting log lines (default ${LOGS_DEFAULT_TIMEOUT_MS}ms)`)
      },
      annotations: readOnly
    },
    async ({ name, tail, timeoutMs }) => {
      const query = tail ? `?tail=${tail}` : ''
      return run(async () => {
        const lines = await collectSSE(
          client,
          `/apps/${encodeURIComponent(name)}/logs${query}`,
          timeoutMs ?? LOGS_DEFAULT_TIMEOUT_MS
        )
        return lines.join('\n') || '(no log output)'
      })
    }
  )

  server.registerTool(
    'get_metrics',
    {
      title: 'Get container metrics',
      description: 'Get a single snapshot of container resource usage (CPU, memory, network) for an app.',
      inputSchema: {
        name: z.string().describe('App name'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(10000)
          .optional()
          .describe(`How long to wait for a metrics sample (default ${METRICS_DEFAULT_TIMEOUT_MS}ms)`)
      },
      annotations: readOnly
    },
    async ({ name, timeoutMs }) =>
      run(async () => {
        const lines = await collectSSE(
          client,
          `/apps/${encodeURIComponent(name)}/metrics`,
          timeoutMs ?? METRICS_DEFAULT_TIMEOUT_MS
        )
        const last = lines[lines.length - 1]
        if (!last) return '(no metrics emitted within timeout)'
        try {
          return JSON.parse(last)
        } catch {
          return last
        }
      })
  )

  server.registerTool(
    'get_version',
    {
      title: 'Server version',
      description: 'Show the Zero server version this MCP is connected to.',
      inputSchema: {},
      annotations: readOnly
    },
    async () => run(async () => unwrap(await client.get<VersionResponse>('/version')))
  )

  server.registerTool(
    'get_status',
    {
      title: 'Connection status',
      description: 'Show which Zero server this MCP is bound to (from .zero/config.json in the current project).',
      inputSchema: {},
      annotations: readOnly
    },
    async () => {
      try {
        const response = await client.get<VersionResponse>('/version')
        const version = unwrap(response)
        return ok({ host: client.config.host, serverVersion: version.version, connected: true })
      } catch (err) {
        return ok({
          host: client.config.host,
          connected: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  )
}

async function collectSSE(client: Client, path: string, timeoutMs: number): Promise<string[]> {
  const lines: string[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await client.streamSSE(path, (line) => lines.push(line), controller.signal)
  } finally {
    clearTimeout(timer)
  }
  return lines
}

async function runServer(): Promise<void> {
  const client = createClient()

  const server = new McpServer({ name: 'zero-mcp', version: VERSION })
  registerTools(server, client)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write(`[zero mcp] Connected to ${client.config.host}\n`)
}

function claudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA']
    if (!appData) throw new Error('APPDATA env var not set')
    return path.join(appData, 'Claude', 'claude_desktop_config.json')
  }
  throw new Error(
    `Claude Desktop is not available on ${process.platform}. Use Claude Code with the project .mcp.json instead.`
  )
}

function resolveZeroBinary(): string | null {
  const execPath = process.execPath
  const basename = path
    .basename(execPath)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (basename === 'zero') return execPath

  try {
    const found = execSync('command -v zero', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (found && fs.existsSync(found)) return found
  } catch {}

  return null
}

function defaultEntryName(cwd: string): string {
  const base = path
    .basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!base || base === 'zero') return 'zero'
  if (base.startsWith('zero-')) return base
  return `zero-${base}`
}

interface McpConfig extends Record<string, unknown> {
  mcpServers?: Record<string, unknown>
}

function readJsonConfig(configPath: string): McpConfig {
  if (!fs.existsSync(configPath)) return {}
  const raw = fs.readFileSync(configPath, 'utf-8')
  try {
    return JSON.parse(raw) as McpConfig
  } catch {
    logError(`Cannot parse ${configPath} — fix the JSON or delete the file first`)
    process.exit(1)
  }
}

function writeJsonConfig(configPath: string, config: unknown): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

function installClaudeCode(name: string, cwd: string): 'added' | 'exists' {
  const configPath = path.join(cwd, '.mcp.json')
  const config = readJsonConfig(configPath)
  config.mcpServers = config.mcpServers ?? {}
  if (name in config.mcpServers) return 'exists'
  config.mcpServers[name] = { command: 'zero', args: ['mcp'] }
  writeJsonConfig(configPath, config)
  return 'added'
}

function uninstallClaudeCode(name: string, cwd: string): 'removed' | 'missing' {
  const configPath = path.join(cwd, '.mcp.json')
  if (!fs.existsSync(configPath)) return 'missing'
  const config = readJsonConfig(configPath)
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  if (!(name in servers)) return 'missing'
  delete servers[name]
  if (Object.keys(servers).length === 0 && Object.keys(config).length === 1) {
    fs.unlinkSync(configPath)
  } else {
    config.mcpServers = servers
    writeJsonConfig(configPath, config)
  }
  return 'removed'
}

function isClaudeDesktopAvailable(): boolean {
  try {
    return fs.existsSync(path.dirname(claudeDesktopConfigPath()))
  } catch {
    return false
  }
}

function installClaudeDesktop(name: string, binary: string, cwd: string): 'added' | 'exists' {
  const configPath = claudeDesktopConfigPath()
  const config = readJsonConfig(configPath)
  config.mcpServers = config.mcpServers ?? {}
  if (name in config.mcpServers) return 'exists'
  config.mcpServers[name] = { command: binary, args: ['mcp'], cwd }
  writeJsonConfig(configPath, config)
  return 'added'
}

function uninstallClaudeDesktop(name: string): 'removed' | 'missing' {
  const configPath = claudeDesktopConfigPath()
  if (!fs.existsSync(configPath)) return 'missing'
  const config = readJsonConfig(configPath)
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  if (!(name in servers)) return 'missing'
  delete servers[name]
  config.mcpServers = servers
  writeJsonConfig(configPath, config)
  return 'removed'
}

async function mcpAdd(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const cwd = process.cwd()
  if (!fs.existsSync(path.join(cwd, '.zero', 'config.json'))) {
    logError('Not linked — run "zero login user@server" in this directory first')
    process.exit(1)
  }

  const customName = positionals[0] ?? (typeof flags['name'] === 'string' ? flags['name'] : undefined)
  const name = customName ?? defaultEntryName(cwd)

  const codeResult = installClaudeCode(name, cwd)
  if (codeResult === 'added') {
    logSuccess(`Registered "${name}" in .mcp.json (Claude Code)`)
  } else {
    logInfo(`"${name}" already in .mcp.json — skipped`)
  }

  if (!isClaudeDesktopAvailable()) {
    logInfo('Claude Desktop not detected — skipped')
    return
  }

  const binary = resolveZeroBinary()
  if (!binary) {
    logError('Could not locate the zero binary for Claude Desktop registration')
    logHint('Install zero via: curl -fsSL https://shipzero.sh/cli/install.sh | bash')
    return
  }

  const desktopResult = installClaudeDesktop(name, binary, cwd)
  if (desktopResult === 'added') {
    logSuccess(`Registered "${name}" with Claude Desktop`)
    logHint('Restart Claude Desktop, then ask it: "list my zero apps"')
  } else {
    logInfo(`"${name}" already in Claude Desktop config — skipped`)
  }
}

async function mcpRemove(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const cwd = process.cwd()
  const customName = positionals[0] ?? (typeof flags['name'] === 'string' ? flags['name'] : undefined)
  const name = customName ?? defaultEntryName(cwd)

  const codeResult = uninstallClaudeCode(name, cwd)
  if (codeResult === 'removed') {
    logSuccess(`Removed "${name}" from .mcp.json (Claude Code)`)
  }

  const desktopResult = isClaudeDesktopAvailable() ? uninstallClaudeDesktop(name) : 'missing'
  if (desktopResult === 'removed') {
    logSuccess(`Removed "${name}" from Claude Desktop`)
    logHint('Restart Claude Desktop to apply the change')
  }

  if (codeResult === 'missing' && desktopResult === 'missing') {
    logInfo(`No entry "${name}" found in Claude Code or Claude Desktop`)
  }
}

export async function mcp(
  subcommand: string | null,
  positionals: string[],
  flags: Record<string, string | true>
): Promise<void> {
  if (subcommand === 'add') return mcpAdd(positionals, flags)
  if (subcommand === 'remove' || subcommand === 'rm') return mcpRemove(positionals, flags)
  if (subcommand === null) return runServer()
  logError(`Unknown mcp subcommand: ${subcommand}`)
  logHint('Usage: zero mcp <add|remove> [name]')
  process.exit(1)
}
