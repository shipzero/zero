import { createClient } from '../client.ts'
import { dim, logError } from '../ui.ts'

function formatLogLine(line: string): string {
  // Dim the ISO timestamp prefix if present
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)/)
  if (match) {
    return `${dim(match[1])} ${match[2]}`
  }
  return line
}

export async function logs(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const isServer = flags['server'] === true
  const appName = positionals[0]

  if (!isServer && !appName) {
    logError('usage: zero logs <app>')
    logError('       zero logs --server')
    process.exit(1)
  }

  const client = createClient()

  process.on('SIGINT', () => {
    console.log(dim('\n[disconnected]'))
    process.exit(0)
  })

  const path = isServer ? '/logs' : `/apps/${encodeURIComponent(appName)}/logs`
  await client.streamSSE(path, (line) => {
    console.log(formatLogLine(line))
  })
}
