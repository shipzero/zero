import type { StartResponse } from '../../../src/types.ts'
import { createClient, unwrap } from '../client.ts'
import { logError, logSuccess, requireAppName, spinner } from '../ui.ts'

export async function start(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero start <app>')

  const client = createClient()
  const spin = spinner(`Starting ${appName}...`)
  const res = await client.post<StartResponse>(`/apps/${encodeURIComponent(appName)}/start`)
  spin.stop()
  unwrap(res, logError)

  logSuccess(`Started ${appName}`)
}
