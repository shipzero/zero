const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const CYAN = '\x1b[36m'

const isColorEnabled = !process.env['NO_COLOR'] && process.stdout.isTTY

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const ANSI_REGEX = /\x1b\[[0-9;]*m/g

function wrap(code: string, text: string): string {
  return isColorEnabled ? `${code}${text}${RESET}` : text
}

export function bold(text: string): string {
  return wrap(BOLD, text)
}

export function dim(text: string): string {
  return wrap(DIM, text)
}

export function red(text: string): string {
  return wrap(RED, text)
}

export function green(text: string): string {
  return wrap(GREEN, text)
}

export function yellow(text: string): string {
  return wrap(YELLOW, text)
}

export function blue(text: string): string {
  return wrap(BLUE, text)
}

export function cyan(text: string): string {
  return wrap(CYAN, text)
}

export function logSuccess(message: string): void {
  console.log(`${green('✓')} ${message}`)
}

export function logInfo(message: string): void {
  console.log(`${blue('ℹ')} ${message}`)
}

export function logError(message: string): void {
  console.error(`${red('✗')} ${message}`)
}

export function logWarn(message: string): void {
  console.log(`${yellow('!')} ${message}`)
}

export function logHint(message: string): void {
  console.log(`  ${dim(message)}`)
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function timeUntil(iso: string): string {
  const date = new Date(iso)
  const diff = date.getTime() - Date.now()
  if (diff <= 0) return 'expired'
  const hours = Math.floor(diff / 3_600_000)
  const formatted = date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  if (hours < 24) return `${hours}h (${formatted})`
  const days = Math.floor(hours / 24)
  return `${days}d (${formatted})`
}

export function formatStatus(status: 'running' | 'stopped' | 'no deployment'): string {
  switch (status) {
    case 'running':
      return green('running')
    case 'stopped':
      return red('stopped')
    case 'no deployment':
      return dim('—')
  }
}

function visibleLength(text: string): number {
  return text.replace(ANSI_REGEX, '').length
}

export interface Column {
  header: string
  key: string
  minWidth?: number
}

export function printTable(columns: Column[], rows: Record<string, string>[]): void {
  const widths = columns.map((col) => {
    const cellWidths = rows.map((row) => visibleLength(row[col.key] ?? ''))
    return Math.max(col.minWidth ?? 0, visibleLength(col.header), ...cellWidths)
  })

  const header = columns.map((col, i) => col.header.padEnd(widths[i])).join('  ')
  console.log(bold(header))

  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const value = row[col.key] ?? ''
      const pad = widths[i] - visibleLength(value)
      return pad > 0 ? value + ' '.repeat(pad) : value
    })
    console.log(cells.join('  '))
  }
}

export function spinner(message: string): { stop: (finalMessage?: string) => void } {
  if (!process.stdout.isTTY) {
    console.log(`${blue('ℹ')} ${message}`)
    return {
      stop: (msg) => {
        if (msg) console.log(msg)
      }
    }
  }

  let frame = 0
  const timer = setInterval(() => {
    process.stdout.write(`\r${cyan(SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length])} ${message}`)
  }, 80)

  return {
    stop(finalMessage?: string) {
      clearInterval(timer)
      process.stdout.write('\r\x1b[2K')
      if (finalMessage) console.log(finalMessage)
    }
  }
}

export function printCommandHelp(usage: string, options?: Array<[string, string]>, examples?: string[]): void {
  console.log(`\n  Usage: ${usage}\n`)
  if (options && options.length > 0) {
    const maxFlag = Math.max(...options.map(([flag]) => flag.length))
    console.log('  Options:')
    for (const [flag, desc] of options) {
      console.log(`    ${cyan(flag.padEnd(maxFlag))}  ${dim(desc)}`)
    }
    console.log()
  }
  if (examples && examples.length > 0) {
    console.log('  Examples:')
    for (const ex of examples) {
      console.log(`    ${dim(ex)}`)
    }
    console.log()
  }
}

export function requireAppName(positionals: string[], usage: string): string {
  const appName = positionals[0]
  if (!appName) {
    logError(`Usage: ${usage}`)
    process.exit(1)
  }
  return appName
}

export function buildStreamPath(
  positionals: string[],
  flags: Record<string, string | true>,
  endpoint: string,
  serverLabel: string
): { path: string; label: string } {
  const isServer = flags['server'] === true
  const previewLabel = flags['preview'] as string | undefined

  if (isServer) return { path: `/${endpoint}`, label: serverLabel }

  const appName = requireAppName(positionals, `zero ${endpoint} <app> [--preview <label>]`)
  const encodedApp = encodeURIComponent(appName)

  if (previewLabel) {
    const encodedLabel = encodeURIComponent(previewLabel)
    return { path: `/apps/${encodedApp}/previews/${encodedLabel}/${endpoint}`, label: `${appName}/${previewLabel}` }
  }

  return { path: `/apps/${encodedApp}/${endpoint}`, label: appName }
}

export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true
  process.stdout.write(`${yellow('?')} ${message} ${dim('[y/N]')} `)
  return new Promise((resolve) => {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.once('data', (data) => {
      const char = data.toString().trim().toLowerCase()
      process.stdin.setRawMode(false)
      process.stdin.pause()
      console.log(char || 'n')
      resolve(char === 'y')
    })
  })
}

export function formatDigest(digest: string | undefined): string {
  if (!digest) return dim('—')
  return dim(digest.replace('sha256:', '').slice(0, 12))
}

export function formatAppUrl(domain: string | undefined, hostPort: number | undefined, serverUrl: URL): string {
  if (domain) return `${serverUrl.protocol}//${domain}`
  if (hostPort) return `http://${serverUrl.hostname}:${hostPort}`
  return '—'
}

export async function printDnsTable(domain: string, serverHost: string): Promise<void> {
  const dns = await import('node:dns/promises')
  const hostname = new URL(serverHost).hostname
  let ip = hostname
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    try {
      const addresses = await dns.resolve4(hostname)
      ip = addresses[0]
    } catch {}
  }

  const typeWidth = 4
  const nameWidth = Math.max(4, domain.length, `*.${domain}`.length)

  console.log()
  console.log(bold('  DNS:'))
  console.log(
    `  ${'A'.padEnd(typeWidth)}  ${domain.padEnd(nameWidth)}  ${ip}  ${dim('(required — makes the app reachable)')}`
  )
  console.log(
    `  ${'A'.padEnd(typeWidth)}  ${`*.${domain}`.padEnd(nameWidth)}  ${ip}  ${dim('(recommended — enables preview subdomains)')}`
  )
  console.log()
}
