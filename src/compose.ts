import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getRegistryAuths } from './state.ts'

const IS_DEV = process.env.NODE_ENV !== 'production'
const COMPOSE_BASE_DIR = process.env.COMPOSE_DIR ?? (IS_DEV ? '.zero/compose' : '/data/compose')

export function composeDir(appName: string): string {
  return path.join(COMPOSE_BASE_DIR, appName)
}

/** Writes the compose file and an override that binds the entry service to a host port. */
export function writeComposeFiles(appName: string, composeContent: string, entryService: string, hostPort: number, internalPort: number): string {
  const projectDir = composeDir(appName)
  fs.mkdirSync(projectDir, { recursive: true })

  fs.writeFileSync(path.join(projectDir, 'docker-compose.yml'), composeContent, 'utf8')
  const override = [
    'services:',
    `  ${entryService}:`,
    '    ports:',
    `      - "127.0.0.1:${hostPort}:${internalPort}"`
  ].join('\n') + '\n'

  fs.writeFileSync(path.join(projectDir, 'docker-compose.override.yml'), override, 'utf8')

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
export function composeDown(projectDir: string): Promise<void> {
  return runCompose(projectDir, ['down', '--remove-orphans'])
}

/** Streams `docker compose logs -f` as an async generator. */
export async function* composeLogs(projectDir: string): AsyncGenerator<string> {
  const proc = execFile('docker', ['compose', 'logs', '-f', '--tail', '100', '--timestamps'], { cwd: projectDir })

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
    await new Promise<void>((r) => { resolve = r })
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
  fs.mkdirSync(configDir, { recursive: true })

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
    const env = dockerConfigDir
      ? { ...process.env, DOCKER_CONFIG: dockerConfigDir }
      : process.env

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
        reject(new Error(`docker compose ${args[0]} failed (exit ${code}): ${stderr.trim()}`))
      }
    })

    proc.on('error', reject)
  })
}
