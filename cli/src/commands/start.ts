import { createClient, unwrap } from '../client.ts'
import type { StartResponse } from '../../../src/types.ts'
import { logSuccess, logError, requireAppName } from '../ui.ts'

export async function start(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero start <app>')

  const client = createClient()
  unwrap(await client.post<StartResponse>(`/apps/${encodeURIComponent(appName)}/start`), logError)

  logSuccess(`started ${appName}`)
}
