import type { AppConfig } from '../state.ts'
import { parseDuration } from '../duration.ts'
import {
  getApps,
  getApp,
  addApp,
  updateEnv,
  removeEnv,
  removeApp,
  clearHostPort,
  resetWebhookSecret,
  getCurrentDeployment,
  findRollbackTarget,
  isComposeApp,
  buildPreviewDomain,
  getPreviewsForApp
} from '../state.ts'
import { deploy, deployPreview, deployComposePreview, rollback, deployEvents } from '../deploy.ts'
import { streamLogs, streamStats, stopContainer, startContainer, waitForHealthy, removeContainer } from '../docker.ts'
import { composeDir, composeDown, composeStop, composeStart, composeLogs, removeComposeDir } from '../compose.ts'
import { routeApp, unrouteApp, removePortRoute } from '../proxy.ts'
import { destroyPreview } from '../preview.ts'
import { buildDomainUrl, buildWebhookUrl, hasDomain } from '../url.ts'
import { DOMAIN, PREVIEW_TTL_MS } from '../env.ts'
import type { MessageResponse, AppSummary, AppDetail, StopResponse, StartResponse, PreviewSummary } from '../types.ts'
import {
  route,
  json,
  startSSE,
  sendSSE,
  pipeSSE,
  readBody,
  parseJSON,
  requireApp,
  maskValues,
  inferNameFromImage,
  parseImageRef,
  previewExpiresAt,
  resolveContainerStatus,
  resolveImageWithTag,
  parseTail,
  findComposeContainer,
  getErrorMessage
} from './router.ts'

interface DeployPayload {
  image?: string
  name?: string
  domain?: string
  port?: number
  hostPort?: number
  command?: string[]
  volumes?: string[]
  healthPath?: string
  healthTimeout?: string
  tag?: string
  env?: Record<string, string>
  composeFile?: string
  entryService?: string
  imagePrefix?: string
  preview?: string
  ttl?: string
}

interface DeployRequest {
  tag?: string
}

interface UpdateEnvRequest {
  [key: string]: string
}

route('GET', '/apps', async (_req, res) => {
  const apps: AppSummary[] = await Promise.all(
    getApps().map(async (app) => {
      const deployment = getCurrentDeployment(app)
      let status: AppSummary['status'] = 'no deployment'
      if (deployment) {
        status = await resolveContainerStatus(deployment.containerId, isComposeApp(app), app.entryService)
      }

      const previews: PreviewSummary[] = await Promise.all(
        getPreviewsForApp(app.name).map(async (preview) => {
          const previewStatus = await resolveContainerStatus(
            preview.containerId,
            !!preview.isCompose,
            app.entryService,
            preview.containerId
          )
          return {
            name: app.name,
            label: preview.label,
            domain: preview.domain,
            status: previewStatus,
            image: preview.image,
            deployedAt: preview.deployedAt,
            expiresAt: preview.expiresAt
          }
        })
      )

      return {
        name: app.name,
        image: app.image,
        domains: app.domains,
        hostPort: app.hostPort,
        trackTag: app.trackTag,
        currentImage: deployment?.image,
        port: deployment?.port,
        deployedAt: deployment?.deployedAt,
        status,
        webhookUrl: buildWebhookUrl(app.webhookSecret),
        previews
      }
    })
  )
  json(res, 200, apps)
})

route('POST', '/deploy', async (req, res) => {
  const body = parseJSON<DeployPayload>((await readBody(req)).toString())
  if (!body) {
    json(res, 400, { error: 'Invalid JSON' })
    return
  }

  if (!body.image && !body.name) {
    json(res, 400, { error: 'Image or name required' })
    return
  }

  if (body.healthTimeout) {
    try {
      parseDuration(body.healthTimeout)
    } catch {
      json(res, 400, { error: `Invalid --health-timeout "${body.healthTimeout}" — use e.g. 30s, 3m` })
      return
    }
  }

  const appName = body.name ?? inferNameFromImage(body.image!)
  let app = getApp(appName)
  let isNew = false

  if (!app) {
    if (!body.image && !body.composeFile) {
      json(res, 404, { error: `App "${appName}" not found` })
      return
    }

    const isCompose = !!body.composeFile
    if (isCompose && !body.entryService) {
      json(res, 400, { error: '--service required for Compose apps' })
      return
    }

    const { image, tag } = isCompose ? { image: '', tag: '' } : parseImageRef(body.image!)

    const domain = body.domain ?? (!body.hostPort && hasDomain() ? `${appName}.${DOMAIN}` : undefined)
    const domains = domain ? [domain] : []

    app = addApp({
      name: appName,
      image,
      domains,
      internalPort: isCompose ? (body.port ?? 80) : body.port,
      hostPort: body.hostPort,
      command: body.command,
      volumes: body.volumes,
      healthPath: body.healthPath,
      healthTimeout: body.healthTimeout,
      trackTag: tag,
      env: body.env ?? {},
      ...(isCompose
        ? { composeFile: body.composeFile, entryService: body.entryService, imagePrefix: body.imagePrefix }
        : {})
    })
    isNew = true
  } else if (body.env) {
    updateEnv(appName, body.env)
  }

  startSSE(res)
  sendSSE(
    res,
    JSON.stringify({
      event: 'accepted',
      appName,
      isNew,
      ...(isNew ? { webhookUrl: buildWebhookUrl(app.webhookSecret) } : {})
    })
  )

  const onDeployLog = (line: string) => sendSSE(res, JSON.stringify({ event: 'log', message: line }))
  deployEvents.on(`log:${appName}`, onDeployLog)

  try {
    if (body.preview) {
      if (app.domains.length === 0) {
        sendSSE(
          res,
          JSON.stringify({ event: 'complete', success: false, error: 'App must have a domain for previews' })
        )
        res.end()
        return
      }

      if (isComposeApp(app) && !app.imagePrefix) {
        sendSSE(
          res,
          JSON.stringify({
            event: 'complete',
            success: false,
            error:
              'Compose previews require --image-prefix to substitute image tags. Redeploy with: zero deploy --compose <file> --service <svc> --name <app> --image-prefix <prefix>'
          })
        )
        res.end()
        return
      }

      const label = body.preview
      const tag = body.tag ?? label
      let ttlMs: number
      try {
        ttlMs = body.ttl ? parseDuration(body.ttl) : PREVIEW_TTL_MS
      } catch {
        sendSSE(res, JSON.stringify({ event: 'complete', success: false, error: `Invalid --ttl "${body.ttl}"` }))
        res.end()
        return
      }

      const previewDomain = buildPreviewDomain(app.domains[0], label)
      const expiresAt = previewExpiresAt(ttlMs)

      try {
        if (isComposeApp(app)) {
          await deployComposePreview(appName, label, previewDomain, expiresAt, tag)
        } else {
          await deployPreview(appName, label, tag, previewDomain, expiresAt)
        }
        sendSSE(
          res,
          JSON.stringify({
            event: 'complete',
            success: true,
            appName,
            label,
            url: buildDomainUrl(previewDomain)
          })
        )
      } catch (err) {
        sendSSE(
          res,
          JSON.stringify({
            event: 'complete',
            success: false,
            error: getErrorMessage(err)
          })
        )
      }
      res.end()
      return
    }

    const result = await deploy(appName, resolveImageWithTag(app, body.tag))
    sendSSE(res, JSON.stringify({ event: 'complete', ...result, appName, isNew }))
    res.end()
  } finally {
    deployEvents.removeListener(`log:${appName}`, onDeployLog)
  }
})

route('GET', '/apps/:name', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const deployment = getCurrentDeployment(app)
  json<AppDetail>(res, 200, {
    name: app.name,
    image: app.image,
    domains: app.domains,
    internalPort: app.internalPort,
    trackTag: app.trackTag,
    imagePrefix: app.imagePrefix,
    env: maskValues(app.env),
    currentImage: deployment?.image,
    port: deployment?.port,
    deployedAt: deployment?.deployedAt,
    deployments: app.deployments.length,
    webhookUrl: buildWebhookUrl(app.webhookSecret)
  })
})

route('POST', '/apps/:name/deploy', async (req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const raw = (await readBody(req)).toString()
  const body = raw ? parseJSON<DeployRequest>(raw) : null

  const result = await deploy(name, resolveImageWithTag(app, body?.tag))
  json(res, result.success ? 200 : 500, result)
})

route('GET', '/apps/:name/rollback-target', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return
  try {
    const target = findRollbackTarget(name)
    json(res, 200, { image: target.image, deployedAt: target.deployedAt })
  } catch (err) {
    json(res, 400, { error: getErrorMessage(err) })
  }
})

route('POST', '/apps/:name/rollback', async (_req, res, { name }) => {
  if (!requireApp(name, res)) return
  try {
    const result = await rollback(name)
    json(res, 200, result)
  } catch (err) {
    json(res, 400, { error: getErrorMessage(err) })
  }
})

route('GET', '/apps/:name/deployments', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return
  json(
    res,
    200,
    app.deployments.map((deployment, index) => ({
      ...deployment,
      isCurrent: index === 0
    }))
  )
})

route('POST', '/apps/:name/stop', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const deployment = getCurrentDeployment(app)
  if (!deployment) {
    json(res, 400, { error: 'No active deployment' })
    return
  }

  unrouteApp(app)
  if (isComposeApp(app)) {
    await composeStop(composeDir(app.name))
  } else {
    await stopContainer(deployment.containerId)
  }
  json<StopResponse>(res, 200, { message: `Stopped ${name}`, containerId: deployment.containerId })
})

route('POST', '/apps/:name/start', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const deployment = getCurrentDeployment(app)
  if (!deployment) {
    json(res, 400, { error: 'No deployment to start' })
    return
  }

  try {
    if (isComposeApp(app)) {
      await composeStart(composeDir(app.name))
    } else {
      await startContainer(deployment.containerId)
    }
    await waitForHealthy(
      deployment.port,
      app.healthPath,
      app.healthTimeout ? parseDuration(app.healthTimeout) : undefined
    )
    routeApp(app, deployment.port)
    json<StartResponse>(res, 200, { message: `Started ${name}`, port: deployment.port })
  } catch (err) {
    json(res, 500, { error: getErrorMessage(err) })
  }
})

route('PATCH', '/apps/:name/env', async (req, res, { name }) => {
  if (!requireApp(name, res)) return
  const env = parseJSON<UpdateEnvRequest>((await readBody(req)).toString())
  if (!env || typeof env !== 'object') {
    json(res, 400, { error: 'Invalid JSON' })
    return
  }
  updateEnv(name, env)
  json<MessageResponse>(res, 200, { message: 'Env updated — redeploy to apply' })
})

route('DELETE', '/apps/:name/env', async (req, res, { name }) => {
  if (!requireApp(name, res)) return
  const keys = new URLSearchParams(req.url?.split('?')[1] ?? '').getAll('key')
  if (keys.length === 0) {
    json(res, 400, { error: 'Key parameter required' })
    return
  }
  removeEnv(name, keys)
  json<MessageResponse>(res, 200, { message: 'Env removed — redeploy to apply' })
})

route('POST', '/apps/:name/webhook', async (_req, res, { name }) => {
  if (!requireApp(name, res)) return
  const secret = resetWebhookSecret(name)
  json(res, 200, { webhookSecret: secret, webhookUrl: buildWebhookUrl(secret) })
})

route('GET', '/apps/:name/logs', async (req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const tail = parseTail(req.url)

  startSSE(res)

  const onDeployLog = (line: string) => sendSSE(res, line)
  deployEvents.on(`log:${name}`, onDeployLog)
  res.on('close', () => deployEvents.removeListener(`log:${name}`, onDeployLog))

  if (isComposeApp(app)) {
    await pipeSSE(res, composeLogs(composeDir(name), tail))
  } else {
    const deployment = getCurrentDeployment(app)
    if (deployment) {
      await pipeSSE(res, streamLogs(deployment.containerId, tail))
    }
  }
})

route('GET', '/apps/:name/metrics', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const deployment = getCurrentDeployment(app)
  if (!deployment) {
    json(res, 400, { error: 'No active deployment' })
    return
  }

  const containerId = isComposeApp(app) ? await findComposeContainer(app.entryService!) : deployment.containerId

  if (!containerId) {
    json(res, 400, { error: 'Container not found' })
    return
  }

  startSSE(res)
  await pipeSSE(res, streamStats(containerId))
})

async function removeAppWithContainers(app: AppConfig): Promise<void> {
  for (const preview of Object.values(app.previews)) {
    await destroyPreview(app.name, preview)
  }

  unrouteApp(app)

  if (isComposeApp(app)) {
    try {
      await composeDown(composeDir(app.name))
    } catch (err) {
      console.error(`[api] Compose down failed for ${app.name}:`, err)
    }
    removeComposeDir(app.name)
  } else {
    const containerIds = app.deployments.map((deployment) => deployment.containerId)
    await Promise.all(containerIds.map((containerId) => removeContainer(containerId)))
  }

  removeApp(app.name)
}

route('DELETE', '/apps/:name/host-port', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  if (!app.hostPort) {
    json(res, 400, { error: 'No host port configured' })
    return
  }

  removePortRoute(app.hostPort)
  clearHostPort(name)

  json<MessageResponse>(res, 200, { message: 'Host port removed' })
})

route('DELETE', '/apps/:name', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  await removeAppWithContainers(app)
  json<MessageResponse>(res, 200, { message: 'Removed' })
})
