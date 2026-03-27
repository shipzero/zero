import crypto from 'node:crypto'
import { deploy, deployComposePreview, deployPreview } from '../deploy.ts'
import { PREVIEW_TTL_MS } from '../env.ts'
import { buildPreviewDomain, getApp, isComposeApp } from '../state.ts'
import { json, parseJSON, previewExpiresAt, readBody, route } from './router.ts'

function extractTag(payload: Record<string, unknown>): string | null {
  const pushData = payload['push_data'] as Record<string, unknown> | undefined
  if (typeof pushData?.tag === 'string') return pushData.tag

  const packageData = payload['package'] as Record<string, unknown> | undefined
  const packageVersion = packageData?.['package_version'] as Record<string, unknown> | undefined
  const containerMetadata = packageVersion?.['container_metadata'] as Record<string, unknown> | undefined
  const tagData = containerMetadata?.['tag'] as Record<string, unknown> | undefined
  if (typeof tagData?.name === 'string') return tagData.name

  return null
}

route('POST', '/webhooks/:name', async (req, res, { name }) => {
  const app = getApp(name)
  if (!app) {
    json(res, 404, { error: 'Unknown app' })
    return
  }

  const rawBody = await readBody(req)

  const signature = req.headers['x-hub-signature-256'] as string | undefined
  if (!signature) {
    json(res, 401, { error: 'Missing signature' })
    return
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', app.webhookSecret).update(rawBody).digest('hex')
  const signatureBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    json(res, 401, { error: 'Invalid signature' })
    return
  }

  const payload = parseJSON<Record<string, unknown>>(rawBody.toString())
  if (!payload) {
    json(res, 400, { error: 'Invalid JSON' })
    return
  }

  const tag = extractTag(payload)
  if (!tag) {
    json(res, 200, { message: 'Ignored: no tag' })
    return
  }

  const isCompose = isComposeApp(app)
  const isTrackedTag = app.trackTag === 'any' || tag === app.trackTag
  const hasImagePrefix = isCompose && !!app.imagePrefix
  const isPreviewCandidate = !isTrackedTag && app.domains.length > 0

  if (!isTrackedTag && !isPreviewCandidate) {
    json(res, 200, { message: `Ignored: tag "${tag}" != tracked "${app.trackTag}"` })
    return
  }

  if (isPreviewCandidate) {
    if (isCompose && !hasImagePrefix) {
      json(res, 200, { message: `Ignored: compose app without --image-prefix cannot create previews for tag "${tag}"` })
      return
    }
    const previewDomain = buildPreviewDomain(app.domains[0], tag)
    const expiresAt = previewExpiresAt(PREVIEW_TTL_MS)
    json(res, 202, { message: 'Preview deploy triggered', tag })
    if (isCompose) {
      deployComposePreview(app.name, tag, previewDomain, expiresAt, tag).catch((err) =>
        console.error(`[webhook] Preview ${app.name}/${tag}: ${err}`)
      )
    } else {
      deployPreview(app.name, tag, tag, previewDomain, expiresAt).catch((err) =>
        console.error(`[webhook] Preview ${app.name}/${tag}: ${err}`)
      )
    }
    return
  }

  if (isCompose) {
    json(res, 202, { message: 'Deploy triggered', tag })
    deploy(app.name, hasImagePrefix ? tag : undefined).catch((err) => console.error(`[webhook] ${app.name}: ${err}`))
  } else {
    const image = `${app.image}:${tag}`
    json(res, 202, { message: 'Deploy triggered', image })
    deploy(app.name, image).catch((err) => console.error(`[webhook] ${app.name}: ${err}`))
  }
})
