import { createClient, unwrap } from '../client.ts'
import type { AppDetail, StopResponse } from '../../../src/types.ts'
import { logSuccess, logError, logHint, confirm, bold, requireAppName, spinner } from '../ui.ts'

export async function stop(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = requireAppName(positionals, 'zero stop <app> [--force]')

  const client = createClient()

  unwrap(await client.get<AppDetail>(`/apps/${encodeURIComponent(appName)}`), logError)

  if (!flags['force']) {
    const ok = await confirm(`Stop ${bold(appName)}?`)
    if (!ok) {
      process.exit(0)
    }
  }

  const spin = spinner(`stopping ${appName}...`)
  const res = await client.post<StopResponse>(`/apps/${encodeURIComponent(appName)}/stop`)
  spin.stop()
  unwrap(res, logError)

  logSuccess(`Stopped ${appName}`)
  logHint(`Restart with: zero start ${appName}`)
}
