import http from 'node:http'
import crypto from 'node:crypto'
import type { AppConfig, Preview } from './state.ts'
import { getErrorMessage } from './errors.ts'
import {
  getApps,
  getApp,
  addApp,
  updateEnv,
  removeEnv,
  removeApp,
  resetWebhookSecret,
  getCurrentDeployment,
  findAppBySecret,
  findRollbackTarget,
  isComposeApp,
  buildPreviewDomain,
  getPreview,
  getPreviewsForApp,
  getRegistryAuths,
  setRegistryAuth,
  removeRegistryAuth
} from './state.ts'
import { deploy, deployPreview, rollback, deployEvents } from './deploy.ts'
import {
  docker,
  streamLogs,
  streamStats,
  stopContainer,
  startContainer,
  waitForHealthy,
  removeContainer,
  getContainerState
} from './docker.ts'
import { composeDir, composeDown, composeStop, composeStart, composeLogs, removeComposeDir } from './compose.ts'
import { routeApp, unrouteApp } from './proxy.ts'
import { destroyPreview } from './preview.ts'
import { isTLSEnabled, buildDomainUrl } from './url.ts'
import { IS_DEV, TOKEN, JWT_SECRET, DOMAIN, API_PORT, PREVIEW_TTL_HOURS } from './env.ts'
import { signJwt, verifyJwt } from './jwt.ts'
import { VERSION } from './version.ts'
import type {
  MessageResponse,
  VersionResponse,
  AppSummary,
  AppDetail,
  AddAppResponse,
  StopResponse,
  StartResponse,
  PreviewDeployResponse,
  PreviewSummary
} from './types.ts'

const WEBHOOK_HOST = DOMAIN || 'localhost'
const ZERO_CONTAINER = 'zero'
const BEARER_PREFIX = 'Bearer '
const MAX_BODY_SIZE = 1024 * 1024
const JWT_TTL_SECONDS = 24 * 60 * 60
const AUTH_WINDOW_MS = 60_000
const MAX_AUTH_FAILURES = 10

function webhookUrl(secret: string): string {
  return `${buildDomainUrl(WEBHOOK_HOST)}/webhooks/${secret}`
}

function parseImageRef(ref: string): { image: string; tag: string } {
  const colonIdx = ref.lastIndexOf(':')
  const hasTag = colonIdx > 0 && !ref.substring(colonIdx).includes('/')
  return {
    image: hasTag ? ref.substring(0, colonIdx) : ref,
    tag: hasTag ? ref.substring(colonIdx + 1) : 'latest'
  }
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>) => Promise<void>

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
}

const routes: Route[] = []

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = []
  const pattern = new RegExp(
    '^' +
      path.replace(/:([^/]+)/g, (_, k) => {
        keys.push(k)
        return '([^/]+)'
      }) +
      '$'
  )
  routes.push({ method, pattern, keys, handler })
}

function matchRoute(method: string, url: string) {
  for (const candidate of routes) {
    if (candidate.method !== method) continue
    const match = url.match(candidate.pattern)
    if (match) {
      const params: Record<string, string> = {}
      candidate.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1])
      })
      return { handler: candidate.handler, params }
    }
  }
  return null
}

function json<T>(res: http.ServerResponse, status: number, body: T) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function startSSE(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
}

function sendSSE(res: http.ServerResponse, data: string): boolean {
  if (res.destroyed) return false
  res.write(`data: ${data}\n\n`)
  return true
}

async function pipeSSE(res: http.ServerResponse, source: AsyncIterable<string | object>): Promise<void> {
  try {
    for await (const item of source) {
      const data = typeof item === 'string' ? item : JSON.stringify(item)
      if (!sendSSE(res, data)) break
    }
  } catch {
    /* stream ended */
  }
}

function maskValues(env: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    masked[key] = value.length <= 4 ? '****' : value.slice(0, 4) + '****'
  }
  return masked
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseJSON<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function authenticateStaticToken(req: http.IncomingMessage): boolean {
  const header = req.headers['authorization'] ?? ''
  const expected = `Bearer ${TOKEN}`
  if (header.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected))
}

function authenticate(req: http.IncomingMessage): boolean {
  if (!TOKEN && !JWT_SECRET) return true
  const header = req.headers['authorization'] ?? ''
  if (!header.startsWith(BEARER_PREFIX)) return false
  const token = header.slice(BEARER_PREFIX.length)
  return verifyJwt(JWT_SECRET, token) !== null
}

function requireApp(name: string, res: http.ServerResponse): AppConfig | null {
  const app = getApp(name)
  if (!app) {
    json(res, 404, { error: 'not found' })
    return null
  }
  return app
}

function requirePreview(appName: string, label: string, res: http.ServerResponse): Preview | null {
  if (!requireApp(appName, res)) return null
  const preview = getPreview(appName, label)
  if (!preview) {
    json(res, 404, { error: 'preview not found' })
    return null
  }
  return preview
}

route('GET', '/version', async (_req, res) => {
  json<VersionResponse>(res, 200, { version: VERSION })
})

route('POST', '/auth/token', async (_req, res) => {
  const now = Math.floor(Date.now() / 1000)
  const token = signJwt(JWT_SECRET, { exp: now + JWT_TTL_SECONDS })
  json(res, 200, { token })
})

route('GET', '/apps', async (_req, res) => {
  const apps: AppSummary[] = await Promise.all(
    getApps().map(async (app) => {
      const deployment = getCurrentDeployment(app)
      let status: AppSummary['status'] = 'no deployment'
      if (deployment) {
        if (isComposeApp(app)) {
          status = 'running'
        } else {
          const state = await getContainerState(deployment.containerId)
          status = state.running ? 'running' : 'stopped'
        }
      }

      const previews: PreviewSummary[] = await Promise.all(
        getPreviewsForApp(app.name).map(async (preview) => {
          const previewState = await getContainerState(preview.containerId)
          return {
            name: app.name,
            label: preview.label,
            domain: preview.domain,
            status: previewState.running ? ('running' as const) : ('stopped' as const),
            image: preview.image,
            deployedAt: preview.deployedAt,
            expiresAt: preview.expiresAt
          }
        })
      )

      return {
        name: app.name,
        image: app.image,
        domain: app.domain,
        hostPort: app.hostPort,
        trackTag: app.trackTag,
        currentImage: deployment?.image,
        port: deployment?.port,
        deployedAt: deployment?.deployedAt,
        status,
        webhookUrl: webhookUrl(app.webhookSecret),
        previews
      }
    })
  )
  json(res, 200, apps)
})

interface AddAppRequest {
  name?: string
  image?: string
  domain?: string
  internalPort?: number
  hostPort?: number
  command?: string[]
  volumes?: string[]
  healthPath?: string
  env?: Record<string, string>
  composeFile?: string
  entryService?: string
}

interface DeployRequest {
  tag?: string
}

interface UpdateEnvRequest {
  [key: string]: string
}

route('POST', '/apps', async (req, res) => {
  const body = parseJSON<AddAppRequest>((await readBody(req)).toString())
  if (!body) {
    json(res, 400, { error: 'invalid JSON' })
    return
  }
  const {
    name,
    domain,
    internalPort = 3000,
    hostPort,
    command,
    volumes,
    healthPath,
    env = {},
    composeFile,
    entryService
  } = body

  if (!name) {
    json(res, 400, { error: 'name required' })
    return
  }

  const isCompose = !!composeFile
  if (isCompose && !entryService) {
    json(res, 400, { error: 'entryService required for compose apps' })
    return
  }
  if (!isCompose && !body.image) {
    json(res, 400, { error: 'image required (or use composeFile for compose apps)' })
    return
  }

  if (getApp(name)) {
    json(res, 409, { error: `app "${name}" already exists` })
    return
  }

  const { image, tag } = isCompose ? { image: '', tag: '' } : parseImageRef(body.image ?? '')

  const app = addApp({
    name,
    image,
    domain,
    internalPort,
    hostPort,
    command,
    volumes,
    healthPath,
    trackTag: tag,
    env,
    ...(isCompose ? { composeFile, entryService } : {})
  })

  json<AddAppResponse>(res, 201, {
    name: app.name,
    webhookSecret: app.webhookSecret,
    webhookUrl: webhookUrl(app.webhookSecret)
  })
})

route('GET', '/apps/:name', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const deployment = getCurrentDeployment(app)
  json<AppDetail>(res, 200, {
    name: app.name,
    image: app.image,
    domain: app.domain,
    internalPort: app.internalPort,
    trackTag: app.trackTag,
    env: maskValues(app.env),
    currentImage: deployment?.image,
    port: deployment?.port,
    deployedAt: deployment?.deployedAt,
    deployments: app.deployments.length,
    webhookUrl: webhookUrl(app.webhookSecret)
  })
})

route('POST', '/apps/:name/deploy', async (req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  let imageWithTag: string | undefined
  if (!isComposeApp(app)) {
    const raw = (await readBody(req)).toString()
    const body = raw ? parseJSON<DeployRequest>(raw) : null
    const tag = body?.tag ?? app.trackTag
    imageWithTag = `${app.image}:${tag}`
  }

  const result = await deploy(name, imageWithTag)
  json(res, result.success ? 200 : 500, result)
})

route('GET', '/apps/:name/rollback-target', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return
  if (isComposeApp(app)) {
    json(res, 400, { error: 'rollback is not supported for compose apps' })
    return
  }
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
    json(res, 400, { error: 'no active deployment' })
    return
  }

  unrouteApp(app)
  if (isComposeApp(app)) {
    await composeStop(composeDir(app.name))
  } else {
    await stopContainer(deployment.containerId)
  }
  json<StopResponse>(res, 200, { message: `stopped ${name}`, containerId: deployment.containerId })
})

route('POST', '/apps/:name/start', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const deployment = getCurrentDeployment(app)
  if (!deployment) {
    json(res, 400, { error: 'no deployment to start' })
    return
  }

  try {
    if (isComposeApp(app)) {
      await composeStart(composeDir(app.name))
    } else {
      await startContainer(deployment.containerId)
    }
    await waitForHealthy(deployment.port, app.healthPath)
    routeApp(app, deployment.port)
    json<StartResponse>(res, 200, { message: `started ${name}`, port: deployment.port })
  } catch (err) {
    json(res, 500, { error: getErrorMessage(err) })
  }
})

route('PATCH', '/apps/:name/env', async (req, res, { name }) => {
  if (!requireApp(name, res)) return
  const env = parseJSON<UpdateEnvRequest>((await readBody(req)).toString())
  if (!env || typeof env !== 'object') {
    json(res, 400, { error: 'invalid JSON' })
    return
  }
  updateEnv(name, env)
  json<MessageResponse>(res, 200, { message: 'env updated — redeploy to apply' })
})

route('DELETE', '/apps/:name/env', async (req, res, { name }) => {
  if (!requireApp(name, res)) return
  const keys = new URLSearchParams(req.url?.split('?')[1] ?? '').getAll('key')
  if (keys.length === 0) {
    json(res, 400, { error: 'key query param required' })
    return
  }
  removeEnv(name, keys)
  json<MessageResponse>(res, 200, { message: 'env removed — redeploy to apply' })
})

route('POST', '/apps/:name/webhooks/reset', async (_req, res, { name }) => {
  if (!requireApp(name, res)) return
  const secret = resetWebhookSecret(name)
  json(res, 200, { webhookSecret: secret, webhookUrl: webhookUrl(secret) })
})

route('POST', '/upgrade', async (_req, res) => {
  if (IS_DEV) {
    json(res, 400, { error: 'upgrade is only available in production mode' })
    return
  }

  console.log('[upgrade] pulling latest image and restarting...')

  const COMPOSE_FILE = '/opt/zero/docker-compose.yml'

  try {
    const upgrader = await docker.createContainer({
      Image: 'docker:cli',
      Cmd: ['sh', '-c', `sleep 2 && docker compose -f ${COMPOSE_FILE} pull && docker compose -f ${COMPOSE_FILE} up -d`],
      HostConfig: {
        Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/opt/zero:/opt/zero:ro'],
        AutoRemove: true
      }
    })
    await upgrader.start()
    json<MessageResponse>(res, 200, { message: 'upgrade started — zero will restart' })
  } catch (err) {
    console.error('[upgrade] failed:', err)
    json(res, 500, { error: getErrorMessage(err) })
  }
})

interface PreviewDeployRequest {
  label?: string
  tag?: string
  ttlHours?: number
}

function previewExpiresAt(ttlHours: number): string {
  return new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString()
}

route('POST', '/apps/:name/previews', async (req, res, { name }) => {
  const parent = requireApp(name, res)
  if (!parent) return
  if (isComposeApp(parent)) {
    json(res, 400, { error: 'previews are not supported for compose apps' })
    return
  }
  if (!parent.domain) {
    json(res, 400, { error: 'parent app must have a domain for preview subdomains' })
    return
  }

  const body = parseJSON<PreviewDeployRequest>((await readBody(req)).toString())
  if (!body?.tag) {
    json(res, 400, { error: 'tag required' })
    return
  }

  const label = body.label ?? body.tag
  const ttlHours = body.ttlHours ?? PREVIEW_TTL_HOURS
  const previewDomain = buildPreviewDomain(parent.domain, label)

  try {
    await deployPreview(name, label, body.tag, previewDomain, previewExpiresAt(ttlHours))
    json<PreviewDeployResponse>(res, 201, {
      name,
      label,
      domain: previewDomain,
      url: buildDomainUrl(previewDomain),
      success: true
    })
  } catch (err) {
    json<PreviewDeployResponse>(res, 500, {
      name,
      label,
      domain: previewDomain,
      url: buildDomainUrl(previewDomain),
      success: false,
      error: getErrorMessage(err)
    })
  }
})

route('GET', '/apps/:name/previews', async (_req, res, { name }) => {
  const parent = requireApp(name, res)
  if (!parent) return

  const previews: PreviewSummary[] = await Promise.all(
    getPreviewsForApp(name).map(async (preview) => {
      let status: PreviewSummary['status'] = 'no deployment'
      const state = await getContainerState(preview.containerId)
      status = state.running ? 'running' : 'stopped'
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
  json<MessageResponse>(res, 200, { message: `preview ${label} removed` })
})

route('GET', '/apps/:name/previews/:label/logs', async (_req, res, { name, label }) => {
  const preview = requirePreview(name, label, res)
  if (!preview) return

  startSSE(res)
  await pipeSSE(res, streamLogs(preview.containerId))
})

route('GET', '/apps/:name/previews/:label/metrics', async (_req, res, { name, label }) => {
  const preview = requirePreview(name, label, res)
  if (!preview) return

  startSSE(res)
  await pipeSSE(res, streamStats(preview.containerId))
})

route('DELETE', '/apps/:name/previews', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const previews = getPreviewsForApp(name)
  for (const preview of previews) {
    await destroyPreview(name, preview)
  }
  json<MessageResponse>(res, 200, { message: `removed ${previews.length} preview(s)` })
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
      console.error(`[api] compose down failed for ${app.name}:`, err)
    }
    removeComposeDir(app.name)
  } else {
    const containerIds = app.deployments.map((deployment) => deployment.containerId)
    await Promise.all(containerIds.map((containerId) => removeContainer(containerId)))
  }

  removeApp(app.name)
}

route('DELETE', '/apps/:name', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  await removeAppWithContainers(app)
  json<MessageResponse>(res, 200, { message: 'removed' })
})

route('GET', '/apps/:name/logs', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  startSSE(res)

  const onDeployLog = (line: string) => sendSSE(res, line)
  deployEvents.on(`log:${name}`, onDeployLog)
  res.on('close', () => deployEvents.removeListener(`log:${name}`, onDeployLog))

  if (isComposeApp(app)) {
    await pipeSSE(res, composeLogs(composeDir(name)))
  } else {
    const deployment = getCurrentDeployment(app)
    if (deployment) {
      await pipeSSE(res, streamLogs(deployment.containerId))
    }
  }
})

async function isZeroContainerRunning(): Promise<boolean> {
  try {
    const info = await docker.getContainer(ZERO_CONTAINER).inspect()
    return info.State.Running
  } catch {
    return false
  }
}

route('GET', '/logs', async (_req, res) => {
  if (!(await isZeroContainerRunning())) {
    json(res, 400, { error: 'server logs are only available in production (zero container not found)' })
    return
  }

  startSSE(res)
  await pipeSSE(res, streamLogs(ZERO_CONTAINER))
  sendSSE(res, '[log stream ended]')
})

route('GET', '/metrics', async (_req, res) => {
  if (!(await isZeroContainerRunning())) {
    json(res, 400, { error: 'server metrics are only available in production (zero container not found)' })
    return
  }

  startSSE(res)
  await pipeSSE(res, streamStats(ZERO_CONTAINER))
})

route('GET', '/apps/:name/metrics', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const deployment = getCurrentDeployment(app)
  if (!deployment) {
    json(res, 400, { error: 'no active deployment' })
    return
  }

  const containerId = isComposeApp(app)
    ? (await docker.listContainers({ filters: { label: [`com.docker.compose.service=${app.entryService}`] } }))[0]?.Id
    : deployment.containerId

  if (!containerId) {
    json(res, 400, { error: 'container not found' })
    return
  }

  startSSE(res)
  await pipeSSE(res, streamStats(containerId))
})

route('GET', '/registries', async (_req, res) => {
  const auths = getRegistryAuths()
  const servers = Object.keys(auths)
  json(res, 200, servers)
})

route('POST', '/registries', async (req, res) => {
  const body = parseJSON<{ server?: string; username?: string; password?: string }>((await readBody(req)).toString())
  if (!body?.server || !body.username || !body.password) {
    json(res, 400, { error: 'server, username, password required' })
    return
  }
  setRegistryAuth(body.server, { username: body.username, password: body.password })
  json<MessageResponse>(res, 200, { message: `registry ${body.server} saved` })
})

route('DELETE', '/registries/:server', async (_req, res, { server }) => {
  if (!removeRegistryAuth(server)) {
    json(res, 404, { error: `no credentials for ${server}` })
    return
  }
  json<MessageResponse>(res, 200, { message: `registry ${server} removed` })
})

route('POST', '/webhooks/:secret', async (req, res, { secret }) => {
  const app = findAppBySecret(secret)
  if (!app) {
    json(res, 404, { error: 'unknown webhook' })
    return
  }

  const rawBody = await readBody(req)

  const signature = req.headers['x-hub-signature-256'] as string | undefined
  if (!signature) {
    json(res, 401, { error: 'missing signature' })
    return
  }

  const expected = 'sha256=' + crypto.createHmac('sha256', app.webhookSecret).update(rawBody).digest('hex')
  const signatureBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    json(res, 401, { error: 'invalid signature' })
    return
  }

  const payload = parseJSON<Record<string, unknown>>(rawBody.toString())
  if (!payload) {
    json(res, 400, { error: 'invalid JSON' })
    return
  }

  const tag = extractTag(payload)
  if (!tag) {
    json(res, 200, { message: 'ignored: no tag' })
    return
  }

  if (app.trackTag !== 'any' && tag !== app.trackTag) {
    json(res, 200, { message: `ignored: tag "${tag}" != tracked "${app.trackTag}"` })
    return
  }

  const image = `${app.image}:${tag}`
  json(res, 202, { message: 'deploy triggered', image })
  deploy(app.name, image).catch((err) => console.error(`[webhook] ${app.name}: ${err}`))
})

function extractTag(payload: Record<string, unknown>): string | null {
  // Docker Hub: { push_data: { tag: "latest" } }
  const pushData = payload['push_data'] as Record<string, unknown> | undefined
  if (typeof pushData?.tag === 'string') return pushData.tag

  // GHCR: { action: "published", package: { package_version: { container_metadata: { tag: { name: "v3" } } } } }
  const packageData = payload['package'] as Record<string, unknown> | undefined
  const packageVersion = packageData?.['package_version'] as Record<string, unknown> | undefined
  const containerMetadata = packageVersion?.['container_metadata'] as Record<string, unknown> | undefined
  const tagData = containerMetadata?.['tag'] as Record<string, unknown> | undefined
  if (typeof tagData?.name === 'string') return tagData.name

  return null
}

const authFailures = new Map<string, number[]>()

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const attempts = authFailures.get(ip) ?? []
  const recent = attempts.filter((t) => now - t < AUTH_WINDOW_MS)
  authFailures.set(ip, recent)
  return recent.length >= MAX_AUTH_FAILURES
}

function recordAuthFailure(ip: string) {
  const attempts = authFailures.get(ip) ?? []
  attempts.push(Date.now())
  authFailures.set(ip, attempts)
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = (req.url ?? '/').split('?')[0]
  const method = req.method ?? 'GET'
  const clientIp = req.socket.remoteAddress ?? ''

  const isWebhook = url.startsWith('/webhooks/')
  const isAuthToken = url === '/auth/token' && method === 'POST'

  if (!isWebhook && isRateLimited(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
    res.end(JSON.stringify({ error: 'too many requests' }))
    return
  }

  const isAuthorized = isWebhook || (isAuthToken ? authenticateStaticToken(req) : authenticate(req))
  if (!isAuthorized) {
    recordAuthFailure(clientIp)
    console.warn(`[api] auth failure from ${clientIp} — ${method} ${url}`)
    json(res, 401, { error: 'unauthorized' })
    return
  }

  const match = matchRoute(method, url)
  if (!match) {
    json(res, 404, { error: 'not found' })
    return
  }

  match.handler(req, res, match.params).catch((err) => {
    console.error('[api]', err)
    json(res, 500, { error: getErrorMessage(err) })
  })
}

function listenOn(server: http.Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve) => server.listen(port, host, resolve))
}

export async function startApi() {
  const server = http.createServer(handleRequest)
  await listenOn(server, API_PORT, '127.0.0.1')
  console.log(`[api] listening on 127.0.0.1:${API_PORT} (proxied via :${isTLSEnabled() ? 443 : 80})`)
  return server
}
