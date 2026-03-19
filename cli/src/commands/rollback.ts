import { createClient, unwrap } from '../client.ts'
import type { AppDetail, RollbackResponse, RollbackTargetResponse } from '../../../src/types.ts'
import { logSuccess, logError, logHint, confirm, bold, dim } from '../ui.ts'

export async function rollback(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = positionals[0]
  if (!appName) {
    logError('usage: zero rollback <app> [--force]')
    process.exit(1)
  }

  const client = createClient()

  if (flags['force']) {
    // Still check app exists before attempting rollback
    unwrap(await client.get<AppDetail>(
      `/apps/${encodeURIComponent(appName)}`
    ), logError)
  }

  if (!flags['force']) {
    const target = unwrap(await client.get<RollbackTargetResponse>(
      `/apps/${encodeURIComponent(appName)}/rollback-target`
    ), logError)

    const ago = timeAgo(target.deployedAt)
    const ok = await confirm(`roll back ${bold(appName)} to ${bold(target.image)} ${dim(`(deployed ${ago})`)}?`)
    if (!ok) {
      process.exit(0)
    }
  }

  const data = unwrap(await client.post<RollbackResponse>(
    `/apps/${encodeURIComponent(appName)}/rollback`
  ), logError)

  logSuccess(`rolled back ${appName} to ${data.image}`)
  logHint(`view logs: zero logs ${appName}`)
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
