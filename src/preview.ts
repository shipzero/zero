import { getAllExpiredPreviews, removePreview } from './state.ts'
import type { Preview } from './state.ts'
import { removeContainer } from './docker.ts'
import { removeProxyRoute } from './proxy.ts'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

/** Removes a single preview: unroutes, stops container, deletes from state. */
export async function destroyPreview(appName: string, preview: Preview): Promise<void> {
  removeProxyRoute(preview.domain)
  await removeContainer(preview.containerId)
  removePreview(appName, preview.label)
}

export async function cleanupExpiredPreviews(): Promise<number> {
  const expired = getAllExpiredPreviews()
  if (expired.length === 0) return 0

  console.log(`[preview] cleaning up ${expired.length} expired preview(s)`)
  for (const { appName, label, preview } of expired) {
    try {
      await destroyPreview(appName, preview)
      console.log(`[preview] removed expired preview ${label} of ${appName}`)
    } catch (err) {
      console.error(`[preview] failed to remove ${label} of ${appName}:`, err)
    }
  }
  return expired.length
}

export function startPreviewCleanupInterval(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    cleanupExpiredPreviews().catch((err) => {
      console.error('[preview] cleanup error:', err)
    })
  }, CLEANUP_INTERVAL_MS)
}
