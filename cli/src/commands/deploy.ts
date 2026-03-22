import fs from 'node:fs'
import { createClient } from '../client.ts'
import { logInfo, logSuccess, logError, logHint, cyan, dim, green, red, printDnsTable } from '../ui.ts'

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
  'pulling image done': 'pulling image',
  'pulling images done': 'pulling images',
  'starting container done': 'starting container',
  'starting services done': 'starting services'
}

export function formatDeployLog(line: string): string | null {
  const stripped = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '')

  if (stripped.startsWith('deploying ')) {
    return null
  }

  if (DONE_MESSAGES[stripped]) {
    return logLine(green('✓'), DONE_MESSAGES[stripped])
  }

  if (stripped.startsWith('detected port:') || stripped.startsWith('using default port:')) {
    return logLine(green('✓'), stripped)
  }

  if (stripped === 'health check passed') {
    return logLine(green('✓'), stripped)
  }

  if (stripped.startsWith('your app is live:') || stripped.startsWith('preview is live:')) {
    return null
  }

  if (stripped.includes('failed') || stripped.includes('error')) {
    return logLine(red('✗'), stripped)
  }

  if (stripped.startsWith('make sure')) {
    return logLine(' ', dim(stripped))
  }

  if (stripped.startsWith('container logs:') || stripped.startsWith('  ')) {
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

export async function deploy(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const firstArg = positionals[0]

  if (!firstArg) {
    logError('usage: zero deploy <image-or-app> [--name <n>] [--domain <d>] [--port <p>] [--tag <t>]')
    logError('       zero deploy --compose <file> --service <svc> --name <n> [--domain <d>]')
    process.exit(1)
  }

  const client = createClient()
  const tag = flags['tag'] as string | undefined
  const domain = flags['domain'] as string | undefined

  const composePath = flags['compose'] as string | undefined
  let composeFile: string | undefined
  if (composePath) {
    if (!fs.existsSync(composePath)) {
      logError(`file not found: ${composePath}`)
      process.exit(1)
    }
    composeFile = fs.readFileSync(composePath, 'utf8')
  }

  let appName: string
  if (composeFile) {
    const name = flags['name'] as string | undefined
    if (!name) {
      logError('--name is required for compose apps')
      process.exit(1)
    }
    appName = name
  } else if (isImageReference(firstArg)) {
    appName = (flags['name'] as string | undefined) ?? inferNameFromImage(firstArg)
  } else {
    appName = firstArg
  }

  process.on('SIGINT', () => {
    console.log(dim('\n[disconnected — deploy continues on the server]'))
    process.exit(0)
  })

  const body: Record<string, unknown> = {}

  if (composeFile) {
    body.composeFile = composeFile
    body.name = appName
    body.entryService = flags['service'] as string | undefined
    body.repo = flags['repo'] as string | undefined
  } else if (isImageReference(firstArg)) {
    body.image = firstArg
    body.name = appName
  } else {
    body.name = appName
  }

  if (domain) body.domain = domain
  if (tag) body.tag = tag
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
      logInfo(`deploying ${event.appName ?? appName}...`)
      if (event.isNew && event.webhookUrl) {
        logInfo(`webhook: ${event.webhookUrl}`)
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
    logSuccess(`your app is live: ${cyan(result.url ?? `port ${result.port}`)}`)
    if (result.isNew && domain && !isLocalDomain(domain)) {
      await printDnsTable(domain, client.config.host)
    }
    logHint(`view logs: zero logs ${appName}`)
  } else {
    logError(result?.error ?? 'deploy failed')
    process.exit(1)
  }
}
