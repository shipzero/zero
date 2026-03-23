#!/usr/bin/env bun
import { login } from './commands/login.ts'
import { list } from './commands/list.ts'
import { deploy } from './commands/deploy.ts'
import { logs } from './commands/logs.ts'
import { metrics } from './commands/metrics.ts'
import { rollback } from './commands/rollback.ts'
import { history } from './commands/history.ts'
import { env } from './commands/env.ts'
import { remove } from './commands/remove.ts'
import { stop } from './commands/stop.ts'
import { start } from './commands/start.ts'
import { status } from './commands/status.ts'
import { registry } from './commands/registry.ts'
import { upgrade } from './commands/upgrade.ts'
import { webhook } from './commands/webhook.ts'
import { VERSION } from './version.ts'
import { bold, cyan, dim, logInfo, logError } from './ui.ts'

interface ParsedArgs {
  command: string
  subcommand: string | null
  positionals: string[]
  flags: Record<string, string | true>
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  const command = args[0] ?? 'help'
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}

  let subcommand: string | null = null
  let isFirstPositional = true

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=')
      if (equalsIndex !== -1) {
        flags[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1)
      } else {
        const next = args[i + 1]
        if (next && !next.startsWith('--')) {
          flags[arg.slice(2)] = next
          i++
        } else {
          flags[arg.slice(2)] = true
        }
      }
    } else if (isFirstPositional && (command === 'env' || command === 'registry' || command === 'webhook')) {
      subcommand = arg
      isFirstPositional = false
    } else {
      positionals.push(arg)
      isFirstPositional = false
    }
  }

  return { command, subcommand, positionals, flags }
}

function formatHelp(): string {
  const commands = [
    ['deploy <image-or-app> [options]', 'Deploy an app (creates if new)'],
    ['env <set|list|remove> <app> [args]', 'Manage environment variables'],
    ['history <app>', 'Show deployment history'],
    ['list', 'List all apps'],
    ['login <user@server>', 'Authenticate via SSH'],
    ['logs <app> [--preview <label>]', 'Stream app logs'],
    ['metrics <app> [--preview <label>]', 'Show live resource usage'],
    ['registry <login|logout|list> [server]', 'Manage registry credentials'],
    ['remove <app> [--preview <label>] [--force]', 'Remove an app or preview'],
    ['rollback <app> [--force]', 'Roll back to previous deployment'],
    ['start <app>', 'Start a stopped app'],
    ['status', 'Show server connection info'],
    ['stop <app> [--force]', 'Stop a running app'],
    ['upgrade [--server] [--all]', 'Upgrade CLI and/or server'],
    ['version', 'Show CLI and server version'],
    ['webhook url <app>', 'Show and rotate webhook URL']
  ]

  const maxCmd = Math.max(...commands.map(([cmd]) => cmd.length))
  const lines = commands.map(([cmd, desc]) => `  ${cyan(cmd.padEnd(maxCmd))}  ${dim(desc)}`)

  return [
    bold('zero') + ' — from Docker image to live HTTPS app in minutes',
    '',
    `Usage: ${cyan('zero <command>')} [options]`,
    '',
    ...lines
  ].join('\n')
}

async function main() {
  const parsed = parseArgs(process.argv)

  try {
    switch (parsed.command) {
      case 'deploy':
        await deploy(parsed.positionals, parsed.flags)
        break
      case 'history':
      case 'deployments':
        await history(parsed.positionals)
        break
      case 'env':
        await env(parsed.subcommand, parsed.positionals, parsed.flags)
        break
      case 'help':
      case '--help':
      case '-h':
        console.log(formatHelp())
        break
      case 'login':
        await login(parsed.positionals, parsed.flags)
        break
      case 'logs':
        await logs(parsed.positionals, parsed.flags)
        break
      case 'list':
      case 'ls':
        await list()
        break
      case 'metrics':
        await metrics(parsed.positionals, parsed.flags)
        break
      case 'registry':
        await registry(parsed.subcommand, parsed.positionals, parsed.flags)
        break
      case 'remove':
      case 'rm':
        await remove(parsed.positionals, parsed.flags)
        break
      case 'rollback':
        await rollback(parsed.positionals, parsed.flags)
        break
      case 'start':
        await start(parsed.positionals)
        break
      case 'status':
        await status()
        break
      case 'stop':
        await stop(parsed.positionals, parsed.flags)
        break
      case 'upgrade':
        await upgrade(parsed.flags)
        break
      case 'webhook':
        await webhook(parsed.subcommand, parsed.positionals)
        break
      case 'version':
      case '--version':
      case '-v': {
        logInfo(`CLI: ${VERSION}`)
        try {
          const { createClient } = await import('./client.ts')
          const client = createClient()
          const { data } = await client.get<{ version: string }>('/version')
          logInfo(`Server: ${'version' in data ? data.version : 'unknown'}`)
        } catch {
          logInfo('Server: not connected')
        }
        break
      }
      default:
        logError(`Unknown command: ${parsed.command}`)
        console.log(formatHelp())
        process.exit(1)
    }
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
