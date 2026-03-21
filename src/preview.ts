import { getAllExpiredPreviews, removePreview } from './state.ts'
import type { Preview } from './state.ts'
import { removeContainer } from './docker.ts'
import { composeDown, composeDir, removeComposeDir } from './compose.ts'
import { removeProxyRoute } from './proxy.ts'
import { clearDeployLogs } from './deploy.ts'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export async function destroyPreview(appName: string, preview: Preview): Promise<void> {
  removeProxyRoute(preview.domain)
  if (preview.isCompose) {
    const projectName = preview.containerId
    try {
      await composeDown(composeDir(projectName), true)
    } catch {
      /* project may already be gone */
    }
    removeComposeDir(projectName)
  } else {
    await removeContainer(preview.containerId)
  }
  removePreview(appName, preview.label)
  clearDeployLogs(appName, `preview/${preview.label}`)
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
