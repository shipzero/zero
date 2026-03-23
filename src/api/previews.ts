import { parseDuration } from '../duration.ts'
import { getApp, isComposeApp, buildPreviewDomain, getPreviewsForApp } from '../state.ts'
import { deployPreview, deployComposePreview, deployEvents } from '../deploy.ts'
import { streamLogs, streamStats } from '../docker.ts'
import { composeDir, composeLogs } from '../compose.ts'
import { destroyPreview } from '../preview.ts'
import { buildDomainUrl } from '../url.ts'
import { PREVIEW_TTL_MS } from '../env.ts'
import type { MessageResponse, PreviewSummary } from '../types.ts'
import {
  route,
  json,
  startSSE,
  sendSSE,
  pipeSSE,
  readBody,
  parseJSON,
  requireApp,
  requirePreview,
  previewExpiresAt,
  resolveContainerStatus,
  findComposeContainer,
  getErrorMessage
} from './router.ts'

interface PreviewDeployRequest {
  label?: string
  tag?: string
  ttl?: string
}

route('POST', '/apps/:name/previews', async (req, res, { name }) => {
  const parent = requireApp(name, res)
  if (!parent) return
  if (!parent.domain) {
    json(res, 400, { error: 'Parent app must have a domain for preview subdomains' })
    return
  }

  const body = parseJSON<PreviewDeployRequest>((await readBody(req)).toString())
  const isCompose = isComposeApp(parent)

  if (!isCompose && !body?.tag) {
    json(res, 400, { error: '--tag required' })
    return
  }

  if (isCompose && !parent.imagePrefix) {
    json(res, 400, {
      error:
        'Compose previews require --image-prefix to substitute image tags. Redeploy with: zero deploy --compose <file> --service <svc> --name <app> --image-prefix <prefix>'
    })
    return
  }

  const label = body?.label ?? body?.tag ?? 'preview'
  let ttlMs: number
  try {
    ttlMs = body?.ttl ? parseDuration(body.ttl) : PREVIEW_TTL_MS
  } catch {
    json(res, 400, { error: `Invalid --ttl "${body?.ttl}" — use e.g. 24h, 7d` })
    return
  }
  const previewDomain = buildPreviewDomain(parent.domain, label)
  const expiresAt = previewExpiresAt(ttlMs)

  startSSE(res)
  const onDeployLog = (line: string) => sendSSE(res, JSON.stringify({ event: 'log', message: line }))
  deployEvents.on(`log:${name}`, onDeployLog)

  try {
    if (isCompose) {
      await deployComposePreview(name, label, previewDomain, expiresAt, body?.tag)
    } else {
      await deployPreview(name, label, body!.tag!, previewDomain, expiresAt)
    }
    sendSSE(
      res,
      JSON.stringify({
        event: 'complete',
        name,
        label,
        domain: previewDomain,
        url: buildDomainUrl(previewDomain),
        success: true
      })
    )
  } catch (err) {
    sendSSE(
      res,
      JSON.stringify({
        event: 'complete',
        name,
        label,
        domain: previewDomain,
        url: buildDomainUrl(previewDomain),
        success: false,
        error: getErrorMessage(err)
      })
    )
  } finally {
    deployEvents.removeListener(`log:${name}`, onDeployLog)
  }
  res.end()
})

route('GET', '/apps/:name/previews', async (_req, res, { name }) => {
  const parent = requireApp(name, res)
  if (!parent) return

  const previews: PreviewSummary[] = await Promise.all(
    getPreviewsForApp(name).map(async (preview) => {
      const status = await resolveContainerStatus(
        preview.containerId,
        !!preview.isCompose,
        parent.entryService,
        preview.containerId
      )
      return {
        name: parent.name,
        label: preview.label,
        domain: preview.domain,
        status,
        image: preview.image,
        deployedAt: preview.deployedAt,
        expiresAt: preview.expiresAt
      }
    })
  )
  json(res, 200, previews)
})

route('DELETE', '/apps/:name/previews/:label', async (_req, res, { name, label }) => {
  const preview = requirePreview(name, label, res)
  if (!preview) return

  await destroyPreview(name, preview)
  json<MessageResponse>(res, 200, { message: `Preview ${label} removed` })
})

route('GET', '/apps/:name/previews/:label/logs', async (_req, res, { name, label }) => {
  const preview = requirePreview(name, label, res)
  if (!preview) return

  startSSE(res)
  if (preview.isCompose) {
    await pipeSSE(res, composeLogs(composeDir(preview.containerId)))
  } else {
    await pipeSSE(res, streamLogs(preview.containerId))
  }
})

route('GET', '/apps/:name/previews/:label/metrics', async (_req, res, { name, label }) => {
  const preview = requirePreview(name, label, res)
  if (!preview) return

  const containerId = preview.isCompose
    ? await findComposeContainer(getApp(name)!.entryService!, preview.containerId)
    : preview.containerId

  if (!containerId) {
    json(res, 400, { error: 'Container not found' })
    return
  }

  startSSE(res)
  await pipeSSE(res, streamStats(containerId))
})

route('DELETE', '/apps/:name/previews', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const previews = getPreviewsForApp(name)
  for (const preview of previews) {
    await destroyPreview(name, preview)
  }
  json<MessageResponse>(res, 200, { message: `Removed ${previews.length} preview(s)` })
})
