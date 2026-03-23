import fs from 'node:fs'
import { createClient } from '../client.ts'
import {
  logInfo,
  logSuccess,
  logError,
  logHint,
  cyan,
  dim,
  green,
  red,
  printDnsTable,
  printCommandHelp
} from '../ui.ts'

function isLocalDomain(domain: string): boolean {
  return domain === 'localhost' || domain.endsWith('.localhost') || /^\d+\.\d+\.\d+\.\d+/.test(domain)
}

export function isImageReference(arg: string): boolean {
  return arg.includes('/') || arg.includes(':')
}

export function inferNameFromImage(imageRef: string): string {
  const colonIdx = imageRef.lastIndexOf(':')
  const hasTag = colonIdx > 0 && !imageRef.substring(colonIdx).includes('/')
  const withoutTag = hasTag ? imageRef.substring(0, colonIdx) : imageRef
  const segments = withoutTag.split('/')
  return segments[segments.length - 1]
}

const DONE_MESSAGES: Record<string, string> = {
  'Pulling image done': 'Pulling image',
  'Pulling images done': 'Pulling images',
  'Starting container done': 'Starting container',
  'Starting services done': 'Starting services'
}

export function formatDeployLog(line: string): string | null {
  const stripped = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '')

  if (stripped.startsWith('Deploying ')) {
    return null
  }

  if (DONE_MESSAGES[stripped]) {
    return logLine(green('✓'), DONE_MESSAGES[stripped])
  }

  if (stripped.startsWith('Detected port:') || stripped.startsWith('Using default port:')) {
    return logLine(green('✓'), stripped)
  }

  if (stripped === 'Health check passed') {
    return logLine(green('✓'), stripped)
  }

  if (stripped.includes('Your app is live:') || stripped.includes('Preview is live:')) {
    return null
  }

  if (stripped.includes('failed') || stripped.includes('error')) {
    return logLine(red('✗'), stripped)
  }

  if (stripped.startsWith('Make sure')) {
    return logLine(' ', dim(stripped))
  }

  if (stripped.startsWith('Container logs:') || stripped.startsWith('  ')) {
    return logLine(' ', dim(stripped))
  }

  return null
}

function logLine(prefix: string, message: string): string {
  return `${prefix} ${message}`
}

interface DeployEvent {
  event: string
  message?: string
  appName?: string
  isNew?: boolean
  webhookUrl?: string
  success?: boolean
  url?: string
  port?: number
  error?: string
}

function printDeployHelp(): void {
  printCommandHelp(
    'zero deploy <image-or-app> [options]',
    [
      ['--name <n>', 'App name (overrides inferred name)'],
      ['--domain <d>', 'Domain for routing and TLS'],
      ['--port <p>', 'Internal container port (auto-detected from EXPOSE)'],
      ['--host-port <p>', 'Expose directly on a host port'],
      ['--tag <t>', 'Image tag to deploy'],
      ['--preview <label>', 'Deploy as a preview environment'],
      ['--ttl <duration>', 'Time to live for previews (e.g. 24h, 7d)'],
      ['--command <cmd>', 'Container startup command'],
      ['--volume <v>', 'Volumes, comma-separated (e.g. data:/app/data)'],
      ['--health-path <path>', 'HTTP health check endpoint'],
      ['--health-timeout <t>', 'Health check timeout (e.g. 30s, 3m)'],
      ['--compose <file>', 'Deploy a Docker Compose stack'],
      ['--service <svc>', 'Entry service for Compose (required with --compose)']
    ],
    [
      'zero deploy ghcr.io/you/myapp:latest',
      'zero deploy myapp --tag v2',
      'zero deploy myapp --preview pr-42',
      'zero deploy --compose docker-compose.yml --service web --name mystack'
    ]
  )
}

function parseDeployInput(firstArg: string | undefined, flags: Record<string, string | true>): Record<string, unknown> {
  const composePath = flags['compose'] as string | undefined

  if (composePath) {
    if (!fs.existsSync(composePath)) {
      logError(`File not found: ${composePath}`)
      process.exit(1)
    }
    const name = flags['name'] as string | undefined
    if (!name) {
      logError('--name is required for compose apps')
      process.exit(1)
    }
    return {
      composeFile: fs.readFileSync(composePath, 'utf8'),
      name,
      entryService: flags['service'] as string | undefined,
      repo: flags['repo'] as string | undefined
    }
  }

  if (!firstArg) {
    printDeployHelp()
    process.exit(1)
  }

  if (isImageReference(firstArg)) {
    return {
      image: firstArg,
      name: (flags['name'] as string | undefined) ?? inferNameFromImage(firstArg)
    }
  }

  return { name: firstArg }
}

export async function deploy(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const firstArg = positionals[0]

  if (flags['help'] === true) {
    printDeployHelp()
    process.exit(0)
  }

  const body = parseDeployInput(firstArg, flags)

  const client = createClient()
  const tag = flags['tag'] as string | undefined
  const domain = flags['domain'] as string | undefined

  process.on('SIGINT', () => {
    console.log(dim('\n[disconnected — deploy continues on the server]'))
    process.exit(0)
  })

  const preview = flags['preview'] as string | undefined
  const ttl = flags['ttl'] as string | undefined

  if (domain) body.domain = domain
  if (tag) body.tag = tag
  if (preview) body.preview = preview
  if (ttl) body.ttl = ttl
  if (flags['port']) body.port = Number(flags['port'])
  if (flags['host-port']) body.hostPort = Number(flags['host-port'])
  if (flags['command']) body.command = (flags['command'] as string).split(' ')
  if (flags['volume']) body.volumes = (flags['volume'] as string).split(',')
  if (flags['health-path']) body.healthPath = flags['health-path']
  if (flags['health-timeout']) body.healthTimeout = flags['health-timeout']

  let result: DeployEvent | undefined

  await client.postSSE('/deploy', body, (raw) => {
    const event = JSON.parse(raw) as DeployEvent

    if (event.event === 'accepted') {
      const target = preview ? `preview ${preview} for ${event.appName ?? body.name}` : `${event.appName ?? body.name}`
      logInfo(`Deploying ${target}...`)
      if (event.isNew && event.webhookUrl) {
        logInfo(`Webhook: ${event.webhookUrl}`)
      }
      return
    }

    if (event.event === 'log' && event.message) {
      const formatted = formatDeployLog(event.message)
      if (formatted) console.log(formatted)
      return
    }

    if (event.event === 'complete') {
      result = event
    }
  })

  if (result?.success) {
    if (preview) {
      logSuccess(`Preview deployed: ${cyan(result.url ?? '')}`)
      logHint(`Remove with: zero remove ${body.name} --preview ${preview}`)
    } else {
      logSuccess(`Your app is live: ${cyan(result.url ?? `port ${result.port}`)}`)
      const appDomain = result.url ? new URL(result.url).hostname : domain
      if (result.isNew && appDomain && !isLocalDomain(appDomain)) {
        await printDnsTable(appDomain, client.config.host)
      }
      logHint(`View logs: zero logs ${body.name}`)
    }
  } else {
    logError(result?.error ?? 'Deploy failed')
    process.exit(1)
  }
}
