import { createClient, unwrap } from '../client.ts'
import type { AppDetail, MessageResponse } from '../../../src/types.ts'
import { logSuccess, logError, confirm, bold, requireAppName, spinner } from '../ui.ts'

export async function remove(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = requireAppName(positionals, 'zero remove <app> [--force]')

  const client = createClient()

  unwrap(await client.get<AppDetail>(`/apps/${encodeURIComponent(appName)}`), logError)

  if (!flags['force']) {
    const ok = await confirm(`Remove app ${bold(appName)} and all its containers?`)
    if (!ok) {
      process.exit(0)
    }
  }

  const spin = spinner(`removing ${appName}...`)
  const res = await client.del<MessageResponse>(`/apps/${encodeURIComponent(appName)}`)
  spin.stop()
  unwrap(res, logError)

  logSuccess(`Removed ${appName}`)
}
