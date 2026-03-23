import http from 'node:http'
import crypto from 'node:crypto'
import type { AppConfig, Preview } from '../state.ts'
import { getApp, getPreview, isComposeApp } from '../state.ts'
import { getErrorMessage } from '../errors.ts'
import { docker, getContainerState } from '../docker.ts'
import { TOKEN, JWT_SECRET, API_PORT } from '../env.ts'
import { verifyJwt } from '../jwt.ts'
import { isTLSEnabled } from '../url.ts'

const BEARER_PREFIX = 'Bearer '
const MAX_BODY_SIZE = 1024 * 1024
const AUTH_WINDOW_MS = 60_000
const MAX_AUTH_FAILURES = 10

export type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>
) => Promise<void>

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
}

const routes: Route[] = []

export function route(method: string, path: string, handler: Handler) {
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

export function json<T>(res: http.ServerResponse, status: number, body: T) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

export function startSSE(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
}

export function sendSSE(res: http.ServerResponse, data: string): boolean {
  if (res.destroyed) return false
  res.write(`data: ${data}\n\n`)
  return true
}

export async function pipeSSE(res: http.ServerResponse, source: AsyncIterable<string | object>): Promise<void> {
  try {
    for await (const item of source) {
      const data = typeof item === 'string' ? item : JSON.stringify(item)
      if (!sendSSE(res, data)) break
    }
  } catch {
    /* stream ended */
  }
}

export function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_SIZE) {
        req.destroy()
        reject(new Error('Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function parseJSON<T = unknown>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function requireApp(name: string, res: http.ServerResponse): AppConfig | null {
  const app = getApp(name)
  if (!app) {
    json(res, 404, { error: 'App not found' })
    return null
  }
  return app
}

export function requirePreview(appName: string, label: string, res: http.ServerResponse): Preview | null {
  if (!requireApp(appName, res)) return null
  const preview = getPreview(appName, label)
  if (!preview) {
    json(res, 404, { error: 'Preview not found' })
    return null
  }
  return preview
}

export function maskValues(env: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    masked[key] = value.length <= 4 ? '****' : value.slice(0, 4) + '****'
  }
  return masked
}

export function inferNameFromImage(imageRef: string): string {
  const colonIdx = imageRef.lastIndexOf(':')
  const hasTag = colonIdx > 0 && !imageRef.substring(colonIdx).includes('/')
  const withoutTag = hasTag ? imageRef.substring(0, colonIdx) : imageRef
  const segments = withoutTag.split('/')
  return segments[segments.length - 1]
}

export function parseImageRef(ref: string): { image: string; tag: string } {
  const colonIdx = ref.lastIndexOf(':')
  const hasTag = colonIdx > 0 && !ref.substring(colonIdx).includes('/')
  return {
    image: hasTag ? ref.substring(0, colonIdx) : ref,
    tag: hasTag ? ref.substring(colonIdx + 1) : 'latest'
  }
}

export function previewExpiresAt(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString()
}

export function resolveImageWithTag(app: AppConfig, tag?: string): string | undefined {
  if (isComposeApp(app)) {
    return tag || app.trackTag || undefined
  }
  return `${app.image}:${tag ?? app.trackTag}`
}

export const ZERO_CONTAINER = 'zero'

export async function isZeroContainerRunning(): Promise<boolean> {
  try {
    const info = await docker.getContainer(ZERO_CONTAINER).inspect()
    return info.State.Running
  } catch {
    return false
  }
}

export async function findComposeContainer(entryService: string, project?: string): Promise<string | null> {
  const labels = [`com.docker.compose.service=${entryService}`]
  if (project) labels.push(`com.docker.compose.project=${project}`)
  const containers = await docker.listContainers({ filters: { label: labels } })
  return containers[0]?.Id ?? null
}

export async function resolveContainerStatus(
  containerId: string,
  isCompose: boolean,
  entryService?: string,
  project?: string
): Promise<'running' | 'stopped'> {
  if (isCompose) {
    const id = await findComposeContainer(entryService!, project)
    return id ? 'running' : 'stopped'
  }
  const state = await getContainerState(containerId)
  return state.running ? 'running' : 'stopped'
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

const authFailures = new Map<string, number[]>()

function cleanupAuthFailures() {
  const now = Date.now()
  for (const [ip, attempts] of authFailures) {
    const recent = attempts.filter((t) => now - t < AUTH_WINDOW_MS)
    if (recent.length === 0) {
      authFailures.delete(ip)
    } else {
      authFailures.set(ip, recent)
    }
  }
}

const authCleanupTimer = setInterval(cleanupAuthFailures, AUTH_WINDOW_MS)
authCleanupTimer.unref()

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

export { getErrorMessage } from '../errors.ts'

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = (req.url ?? '/').split('?')[0]
  const method = req.method ?? 'GET'
  const clientIp = req.socket.remoteAddress ?? ''

  const isWebhook = url.startsWith('/webhooks/')
  const isAuthToken = url === '/auth/token' && method === 'POST'

  if (!isWebhook && isRateLimited(clientIp)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
    res.end(JSON.stringify({ error: 'Too many requests' }))
    return
  }

  const isAuthorized = isWebhook || (isAuthToken ? authenticateStaticToken(req) : authenticate(req))
  if (!isAuthorized) {
    recordAuthFailure(clientIp)
    console.warn(`[api] Auth failure from ${clientIp}: ${method} ${url}`)
    json(res, 401, { error: 'Unauthorized' })
    return
  }

  const match = matchRoute(method, url)
  if (!match) {
    json(res, 404, { error: 'Not found' })
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
  console.log(`[api] Listening on 127.0.0.1:${API_PORT} (proxied via :${isTLSEnabled() ? 443 : 80})`)
  return server
}
