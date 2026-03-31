import type { AppDetail, MessageResponse, PreviewSummary } from '../../../src/types.ts'
import { createClient, unwrap } from '../client.ts'
import { bold, confirm, logError, logSuccess, requireAppName, spinner } from '../ui.ts'

export async function remove(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = requireAppName(positionals, 'zero remove <app> [--preview <label>] [--force]')
  const previewLabel = flags['preview'] as string | undefined
  const client = createClient()

  if (previewLabel) {
    const previews = unwrap(
      await client.get<PreviewSummary[]>(`/apps/${encodeURIComponent(appName)}/previews`),
      logError
    )
    if (!previews.some((p) => p.label === previewLabel)) {
      logError(`Preview "${previewLabel}" not found on app "${appName}"`)
      process.exit(1)
    }

    if (!flags['force']) {
      const ok = await confirm(`Remove preview ${bold(previewLabel)} for ${bold(appName)}?`)
      if (!ok) process.exit(0)
    }

    const spin = spinner(`Removing preview ${previewLabel}...`)
    const res = await client.del<MessageResponse>(
      `/apps/${encodeURIComponent(appName)}/previews/${encodeURIComponent(previewLabel)}`
    )
    spin.stop()
    unwrap(res, logError)
    logSuccess(`Removed preview ${previewLabel} for ${appName}`)
    return
  }

  unwrap(await client.get<AppDetail>(`/apps/${encodeURIComponent(appName)}`), logError)

  if (!flags['force']) {
    const ok = await confirm(`Remove app ${bold(appName)} and all its containers?`)
    if (!ok) process.exit(0)
  }

  const spin = spinner(`Removing ${appName}...`)
  const res = await client.del<MessageResponse>(`/apps/${encodeURIComponent(appName)}`)
  spin.stop()
  unwrap(res, logError)

  logSuccess(`Removed ${appName}`)
}
