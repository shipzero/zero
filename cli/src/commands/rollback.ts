import { createClient, unwrap } from '../client.ts'
import type { AppDetail, RollbackResponse, RollbackTargetResponse } from '../../../src/types.ts'
import { logSuccess, logError, logHint, confirm, bold, dim, timeAgo, requireAppName, spinner } from '../ui.ts'

export async function rollback(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = requireAppName(positionals, 'zero rollback <app> [--force]')

  const client = createClient()

  if (flags['force']) {
    // Still check app exists before attempting rollback
    unwrap(await client.get<AppDetail>(`/apps/${encodeURIComponent(appName)}`), logError)
  }

  if (!flags['force']) {
    const target = unwrap(
      await client.get<RollbackTargetResponse>(`/apps/${encodeURIComponent(appName)}/rollback-target`),
      logError
    )

    const ago = timeAgo(target.deployedAt)
    const ok = await confirm(`Roll back ${bold(appName)} to ${bold(target.image)} ${dim(`(deployed ${ago})`)}?`)
    if (!ok) {
      process.exit(0)
    }
  }

  const spin = spinner(`rolling back ${appName}...`)
  const res = await client.post<RollbackResponse>(`/apps/${encodeURIComponent(appName)}/rollback`)
  spin.stop()
  const data = unwrap(res, logError)

  logSuccess(`Rolled back ${appName} to ${data.image}`)
  logHint(`View logs: zero logs ${appName}`)
}
