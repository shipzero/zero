import { createClient, unwrap } from '../client.ts'
import type { StartResponse } from '../../../src/types.ts'
import { logSuccess, logError } from '../ui.ts'

export async function start(positionals: string[]): Promise<void> {
  const appName = positionals[0]
  if (!appName) {
    logError('usage: zero start <app>')
    process.exit(1)
  }

  const client = createClient()
  unwrap(await client.post<StartResponse>(`/apps/${encodeURIComponent(appName)}/start`), logError)

  logSuccess(`started ${appName}`)
}
