import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getRegistryAuths } from './state.ts'
import { COMPOSE_BASE_DIR } from './env.ts'
import { ensureDir } from './fs.ts'

export function composeDir(appName: string): string {
  return path.join(COMPOSE_BASE_DIR, appName)
}

/** Extracts service names so the override can set unique container_name per service, avoiding conflicts across deploys and previews. */
function parseServiceNames(composeContent: string): string[] {
  const services: string[] = []
  let inServices = false
  let serviceIndent = -1
  for (const line of composeContent.split('\n')) {
    if (/^services\s*:/.test(line)) {
      inServices = true
      serviceIndent = -1
      continue
    }
    if (!inServices) continue

    const stripped = line.replace(/\t/g, '  ')
    if (stripped.trim() === '' || stripped.trim().startsWith('#')) continue
    const indent = stripped.search(/\S/)
    if (indent === 0) break

    if (serviceIndent === -1) serviceIndent = indent
    if (indent === serviceIndent) {
      const name = stripped.trim().replace(/:.*$/, '')
      if (name) services.push(name)
    }
  }
  return services
}

const VALID_TAG_PATTERN = /^[a-zA-Z0-9._-]+$/

function imagePrefixPattern(imagePrefix: string): string {
  const escaped = imagePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `image:\\s*${escaped}/[^:]+`
}

/** Extracts the tag from the first image matching the prefix, or null if none found. */
export function extractImageTag(composeContent: string, imagePrefix: string): string | null {
  const match = composeContent.match(new RegExp(`${imagePrefixPattern(imagePrefix)}:([^\\s]+)`))
  return match?.[1] ?? null
}

/** Replaces image tags for all images matching the image prefix. Throws on invalid tags. */
export function substituteImageTags(composeContent: string, imagePrefix: string, tag: string): string {
  if (!VALID_TAG_PATTERN.test(tag)) {
    throw new Error(`Invalid image tag: "${tag}"`)
  }
  return composeContent.replace(new RegExp(`(${imagePrefixPattern(imagePrefix)}):[^\\s]+`, 'g'), `$1:${tag}`)
}

/** Writes the compose file and an override that binds the entry service to a host port. */
export function writeComposeFiles(
  appName: string,
  composeContent: string,
  entryService: string,
  hostPort: number,
  internalPort: number,
  env?: Record<string, string>
): string {
  const projectDir = composeDir(appName)
  ensureDir(projectDir)

  fs.writeFileSync(path.join(projectDir, 'docker-compose.yml'), composeContent, 'utf8')

  if (env && Object.keys(env).length > 0) {
    const envContent =
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n'
    fs.writeFileSync(path.join(projectDir, '.env'), envContent, 'utf8')
  }

  const serviceNames = parseServiceNames(composeContent)
  const overrideLines = ['services:']
  let entryHandled = false
  for (const service of serviceNames) {
    overrideLines.push(`  ${service}:`, `    container_name: ${appName}-${service}`)
    if (service === entryService) {
      overrideLines.push('    ports:', `      - "127.0.0.1:${hostPort}:${internalPort}"`)
      entryHandled = true
    }
  }
  if (!entryHandled) {
    overrideLines.push(`  ${entryService}:`, `    container_name: ${appName}-${entryService}`)
    overrideLines.push('    ports:', `      - "127.0.0.1:${hostPort}:${internalPort}"`)
  }

  fs.writeFileSync(path.join(projectDir, 'docker-compose.override.yml'), overrideLines.join('\n') + '\n', 'utf8')

  return projectDir
}

/** Runs `docker compose pull` in the project directory. */
export function composePull(projectDir: string, onProgress?: (line: string) => void): Promise<void> {
  return runCompose(projectDir, ['pull'], onProgress)
}

/** Runs `docker compose up -d` in the project directory. */
export function composeUp(projectDir: string, onProgress?: (line: string) => void): Promise<void> {
  return runCompose(projectDir, ['up', '-d', '--remove-orphans'], onProgress)
}

/** Runs `docker compose stop` in the project directory. */
export function composeStop(projectDir: string): Promise<void> {
  return runCompose(projectDir, ['stop'])
}

/** Runs `docker compose start` in the project directory. */
export function composeStart(projectDir: string): Promise<void> {
  return runCompose(projectDir, ['start'])
}

/** Runs `docker compose down --remove-orphans` in the project directory. */
export function composeDown(projectDir: string, removeVolumes = false): Promise<void> {
  const args = ['down', '--remove-orphans']
  if (removeVolumes) args.push('-v')
  return runCompose(projectDir, args)
}

/** Streams `docker compose logs -f` as an async generator. */
export async function* composeLogs(projectDir: string, tail = 100): AsyncGenerator<string> {
  const proc = execFile('docker', ['compose', 'logs', '-f', '--tail', String(tail), '--timestamps'], {
    cwd: projectDir
  })

  let buffer = ''

  const lines = (data: Buffer): string[] => {
    buffer += data.toString()
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    return parts.filter(Boolean)
  }

  const queue: string[] = []
  let resolve: (() => void) | null = null
  let done = false

  const push = (line: string) => {
    queue.push(line)
    resolve?.()
  }

  proc.stdout?.on('data', (data: Buffer) => {
    for (const line of lines(data)) push(line)
  })

  proc.stderr?.on('data', (data: Buffer) => {
    for (const line of lines(data)) push(line)
  })

  proc.on('close', () => {
    done = true
    resolve?.()
  })

  proc.on('error', () => {
    done = true
    resolve?.()
  })

  while (true) {
    while (queue.length > 0) {
      yield queue.shift()!
    }
    if (done) break
    await new Promise<void>((r) => {
      resolve = r
    })
    resolve = null
  }
}

/** Removes the compose project directory. */
export function removeComposeDir(appName: string): void {
  const projectDir = composeDir(appName)
  fs.rmSync(projectDir, { recursive: true, force: true })
}

/** Builds a Docker config.json from stored registry credentials. */
function writeDockerConfig(projectDir: string): string | undefined {
  const auths = getRegistryAuths()
  if (Object.keys(auths).length === 0) return undefined

  const configDir = path.join(projectDir, '.docker')
  ensureDir(configDir)

  const config: Record<string, Record<string, { auth: string }>> = { auths: {} }
  for (const [server, creds] of Object.entries(auths)) {
    config.auths[server] = { auth: Buffer.from(`${creds.username}:${creds.password}`).toString('base64') }
  }

  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config), 'utf8')
  return configDir
}

function runCompose(projectDir: string, args: string[], onProgress?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const dockerConfigDir = writeDockerConfig(projectDir)
    const env = dockerConfigDir ? { ...process.env, DOCKER_CONFIG: dockerConfigDir } : process.env

    const proc = execFile('docker', ['compose', ...args], { cwd: projectDir, env })

    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) onProgress?.(line)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) onProgress?.(line)
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Docker compose ${args[0]} failed (exit ${code}): ${stderr.trim()}`))
      }
    })

    proc.on('error', reject)
  })
}
