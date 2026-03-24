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
  spinner,
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

const STEP_DONE: Record<string, string> = {
  'Pulling image done': 'Pulling image',
  'Pulling images done': 'Pulling images',
  'Starting container done': 'Starting container',
  'Starting services done': 'Starting services'
}

const NEXT_SPINNER: Record<string, string> = {
  'Pulling image done': 'Starting container...',
  'Pulling images done': 'Starting services...',
  'Starting container done': 'Running health check...',
  'Starting services done': 'Running health check...'
}

export function stripTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '')
}

export function createDeployLogger(): { handleLog: (line: string) => void; stop: () => void } {
  let active: ReturnType<typeof spinner> | null = null

  function stopSpinner(finalMessage?: string): void {
    if (active) {
      active.stop(finalMessage)
      active = null
    }
  }

  function startSpinner(message: string): void {
    active = spinner(message)
  }

  function handleLog(line: string): void {
    const stripped = stripTimestamp(line)

    if (stripped.startsWith('Deploying ')) {
      startSpinner('Pulling image...')
      return
    }

    if (stripped.startsWith('Deploying compose')) {
      startSpinner('Pulling images...')
      return
    }

    if (STEP_DONE[stripped]) {
      stopSpinner(`${green('✓')} ${STEP_DONE[stripped]}`)
      const next = NEXT_SPINNER[stripped]
      if (next) startSpinner(next)
      return
    }

    if (stripped.startsWith('Detected port:') || stripped.startsWith('Using default port:')) {
      console.log(`${green('✓')} ${stripped}`)
      return
    }

    if (stripped === 'Health check passed') {
      stopSpinner(`${green('✓')} Health check passed`)
      return
    }

    if (stripped.includes('Your app is live:') || stripped.includes('Preview is live:')) {
      return
    }

    if (stripped.includes('failed') || stripped.includes('error')) {
      stopSpinner()
      console.log(`${red('✗')} ${stripped}`)
      return
    }

    if (stripped.startsWith('Make sure') || stripped.startsWith('Run ') || stripped.startsWith('  ')) {
      console.log(`  ${dim(stripped)}`)
      return
    }
  }

  return { handleLog, stop: () => stopSpinner() }
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

export function parseEnvFlag(value: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const pair of value.split(',')) {
    const equalsIndex = pair.indexOf('=')
    if (equalsIndex === -1) {
      logError(`Invalid env format: "${pair}" — expected KEY=val`)
      process.exit(1)
    }
    env[pair.slice(0, equalsIndex)] = pair.slice(equalsIndex + 1)
  }
  return env
}

function printDeployHelp(): void {
  printCommandHelp(
    'zero deploy <image-or-app> [options]',
    [
      ['--name <n>', 'App name (overrides inferred name)'],
      ['--domain <d>', 'Domain for routing and TLS'],
      ['--port <p>', 'Internal container port (auto-detected from EXPOSE)'],
      ['--host-port <p>', 'Expose directly on a host port (skips auto-domain)'],
      ['--tag <t>', 'Image tag to deploy'],
      ['--preview <label>', 'Deploy as a preview environment'],
      ['--ttl <duration>', 'Time to live for previews (e.g. 24h, 7d)'],
      ['--command <cmd>', 'Container startup command'],
      ['--volume <v>', 'Volumes, comma-separated (e.g. data:/app/data)'],
      ['--health-path <path>', 'HTTP health check endpoint'],
      ['--health-timeout <t>', 'Health check timeout (e.g. 30s, 3m)'],
      ['--env <vars>', 'Env vars, comma-separated (e.g. KEY=val,KEY2=val2)'],
      ['--compose <file>', 'Deploy a Docker Compose stack'],
      ['--service <svc>', 'Entry service for Compose (required with --compose)'],
      ['--image-prefix <p>', 'Shared image prefix for tag substitution (e.g. ghcr.io/org/project)']
    ],
    [
      'zero deploy ghcr.io/shipzero/demo:latest',
      'zero deploy myapp --tag v2',
      'zero deploy myapp --env DATABASE_URL=postgres://localhost/db,NODE_ENV=production',
      'zero deploy myapp --preview pr-21',
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
      imagePrefix: flags['image-prefix'] as string | undefined
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
  if (flags['env'] && typeof flags['env'] === 'string') body.env = parseEnvFlag(flags['env'])

  let result: DeployEvent | undefined
  const deployLogger = createDeployLogger()

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
      deployLogger.handleLog(event.message)
      return
    }

    if (event.event === 'complete') {
      deployLogger.stop()
      result = event
    }
  })

  if (result?.success) {
    if (preview) {
      logSuccess(`Preview deployed: ${cyan(result.url ?? '')}`)
      logHint(`Remove with: zero remove ${body.name} --preview ${preview}`)
    } else {
      logSuccess(`Your app is live: ${cyan(result.url ?? `port ${result.port}`)}`)
      const appDomain = domain ?? (result.url ? new URL(result.url).hostname : undefined)
      if (result.isNew && appDomain && !isLocalDomain(appDomain) && !body.hostPort) {
        await printDnsTable(appDomain, client.config.host)
      }
      logHint(`View logs: zero logs ${body.name}`)
    }
  } else {
    logError(result?.error ?? 'Deploy failed')
    process.exit(1)
  }
}
