import { createClient } from '../client.ts'
import type { DeployResult } from '../../../src/types.ts'
import { logInfo, logSuccess, logError, logHint, cyan, dim, green, red, requireAppName } from '../ui.ts'

export function formatDeployLog(line: string): string | null {
  const stripped = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '')

  if (stripped.startsWith('── deploy start:')) {
    return logLine(cyan('▸'), stripped.replace('── deploy start: ', 'deploying '))
  }

  const phaseMatch = stripped.match(/^phase (\d\/\d): (.+)/)
  if (phaseMatch) {
    return logLine(cyan(`[${phaseMatch[1]}]`), phaseMatch[2])
  }

  if (stripped === 'container is healthy' || stripped === 'entry service is healthy') {
    return logLine(green('✓'), stripped)
  }

  if (stripped.startsWith('deploy complete')) {
    return null
  }

  if (stripped.includes('failed') || stripped.includes('error')) {
    return logLine(red('✗'), stripped)
  }

  return logLine(' ', dim(stripped))
}

function logLine(prefix: string, message: string): string {
  return `  ${prefix} ${message}`
}

export async function deploy(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = requireAppName(positionals, 'zero deploy <app> [--tag <tag>]')

  const tag = flags['tag'] as string | undefined
  const client = createClient()

  logInfo(`deploying ${appName}...`)
  logHint('ctrl+c to disconnect (deploy will continue in background)')

  process.on('SIGINT', () => {
    console.log(dim('\n[disconnected — deploy continues on the server]'))
    process.exit(0)
  })

  const abort = new AbortController()

  client
    .streamSSE(
      `/apps/${encodeURIComponent(appName)}/logs`,
      (line) => {
        const formatted = formatDeployLog(line)
        if (formatted) console.log(formatted)
      },
      abort.signal
    )
    .catch(() => {})

  const { data } = await client.post<DeployResult>(
    `/apps/${encodeURIComponent(appName)}/deploy`,
    tag ? { tag } : undefined
  )
  const result = data as DeployResult

  abort.abort()

  if (result.success) {
    logSuccess(`deploy complete${result.url ? `: ${cyan(result.url)}` : ''}`)
    logHint(`view logs: zero logs ${appName}`)
  } else {
    logError('deploy failed')
    process.exit(1)
  }
}
