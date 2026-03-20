import { createClient, unwrap } from '../client.ts'
import type { AppDetail, StopResponse } from '../../../src/types.ts'
import { logSuccess, logError, logHint, confirm, bold } from '../ui.ts'

export async function stop(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = positionals[0]
  if (!appName) {
    logError('usage: zero stop <app> [--force]')
    process.exit(1)
  }

  const client = createClient()

  unwrap(await client.get<AppDetail>(`/apps/${encodeURIComponent(appName)}`), logError)

  if (!flags['force']) {
    const ok = await confirm(`stop ${bold(appName)}?`)
    if (!ok) {
      process.exit(0)
    }
  }

  unwrap(await client.post<StopResponse>(`/apps/${encodeURIComponent(appName)}/stop`), logError)

  logSuccess(`stopped ${appName}`)
  logHint(`restart with: zero start ${appName}`)
}
