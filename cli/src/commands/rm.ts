import { createClient, unwrap } from '../client.ts'
import type { AppDetail, MessageResponse } from '../../../src/types.ts'
import { logSuccess, logError, confirm, bold } from '../ui.ts'

export async function rm(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = positionals[0]
  if (!appName) {
    logError('usage: zero rm <app> [--force]')
    process.exit(1)
  }

  const client = createClient()

  unwrap(await client.get<AppDetail>(
    `/apps/${encodeURIComponent(appName)}`
  ), logError)

  if (!flags['force']) {
    const ok = await confirm(`remove app ${bold(appName)} and all its containers?`)
    if (!ok) {
      process.exit(0)
    }
  }

  unwrap(await client.del<MessageResponse>(
    `/apps/${encodeURIComponent(appName)}`
  ), logError)

  logSuccess(`removed ${appName}`)
}
