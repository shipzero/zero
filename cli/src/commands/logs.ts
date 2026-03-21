import { createClient } from '../client.ts'
import { dim, logError } from '../ui.ts'

function formatLogLine(line: string): string {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)/)
  if (match) {
    return `${dim(match[1])} ${match[2]}`
  }
  return line
}

function buildPath(
  positionals: string[],
  flags: Record<string, string | true>
): { path: string; label: string } | null {
  const isServer = flags['server'] === true
  const appName = positionals[0]
  const previewLabel = flags['preview'] as string | undefined

  if (isServer) return { path: '/logs', label: 'server' }

  if (!appName) {
    logError('usage: zero logs <app> [--preview <label>]')
    logError('       zero logs --server')
    process.exit(1)
  }

  const encodedApp = encodeURIComponent(appName)
  if (previewLabel) {
    const encodedLabel = encodeURIComponent(previewLabel)
    return { path: `/apps/${encodedApp}/previews/${encodedLabel}/logs`, label: `${appName}/${previewLabel}` }
  }

  return { path: `/apps/${encodedApp}/logs`, label: appName }
}

export async function logs(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const target = buildPath(positionals, flags)
  if (!target) return

  const client = createClient()

  process.on('SIGINT', () => {
    console.log(dim('\n[disconnected]'))
    process.exit(0)
  })

  let isFirst = true
  await client.streamSSE(target.path, (line) => {
    if (isFirst) {
      console.log(dim('ctrl+c to stop\n'))
      isFirst = false
    }
    console.log(formatLogLine(line))
  })
}
