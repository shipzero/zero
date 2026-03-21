import tls from 'node:tls'
import http from 'node:http'
import { getCachedCert, loadCachedCert, obtainCert, handleAcmeChallenge } from './certs.ts'
import { isTLSEnabled } from './url.ts'
import { DEV_PORT } from './env.ts'

const REQUEST_TIMEOUT_MS = 30_000
const HEADERS_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 100 * 1024 * 1024 // 100 MB
const MAX_CONNECTIONS = 1024

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN'
}

const routes = new Map<string, number>()

export function hasProxyRoute(domain: string): boolean {
  return routes.has(domain)
}

export function updateProxyRoute(domain: string, port: number) {
  routes.set(domain, port)
  console.log(`[proxy] route updated: ${domain} → :${port}`)
}

export function removeProxyRoute(domain: string) {
  routes.delete(domain)
}

export function routeApp(app: { domain?: string; hostPort?: number }, containerPort: number) {
  if (app.domain) {
    updateProxyRoute(app.domain, containerPort)
  } else if (app.hostPort) {
    updatePortRoute(app.hostPort, containerPort)
  }
}

export function unrouteApp(app: { domain?: string; hostPort?: number }) {
  if (app.domain) {
    removeProxyRoute(app.domain)
  } else if (app.hostPort) {
    removePortRoute(app.hostPort)
  }
}

function forwardTo(req: http.IncomingMessage, res: http.ServerResponse, targetPort: number) {
  const clientIp = req.socket.remoteAddress ?? ''
  const forwardedFor = req.headers['x-forwarded-for']
  const isEncrypted = 'encrypted' in req.socket

  const contentLength = parseInt(req.headers['content-length'] ?? '', 10)
  if (contentLength > MAX_BODY_BYTES) {
    res.writeHead(413, { 'Content-Type': 'text/plain' })
    res.end('Request entity too large')
    return
  }

  const headers: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(key)) headers[key] = value
  }
  headers['x-forwarded-for'] = forwardedFor ? `${forwardedFor}, ${clientIp}` : clientIp
  headers['x-real-ip'] = clientIp
  headers['x-forwarded-proto'] = isEncrypted ? 'https' : 'http'

  let receivedBytes = 0
  req.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length
    if (receivedBytes > MAX_BODY_BYTES) {
      req.destroy()
      upstream.destroy()
      if (!res.headersSent) {
        res.writeHead(413, { 'Content-Type': 'text/plain' })
        res.end('Request entity too large')
      }
    }
  })

  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
      timeout: REQUEST_TIMEOUT_MS
    },
    (proxyRes) => {
      const status = proxyRes.statusCode ?? 502
      console.log(`[proxy] ${clientIp} ${req.method} ${req.headers.host}${req.url} → ${status}`)
      const responseHeaders = { ...proxyRes.headers, ...SECURITY_HEADERS }
      res.writeHead(status, responseHeaders)
      proxyRes.pipe(res)
    }
  )

  upstream.on('timeout', () => {
    upstream.destroy()
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'text/plain' })
      res.end('Gateway timeout')
    }
  })

  upstream.on('error', (err) => {
    console.error(`[proxy] upstream error: ${err.message}`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end('Upstream unreachable')
    }
  })

  req.pipe(upstream)
}

function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const host = (req.headers.host ?? '').split(':')[0]
  const port = routes.get(host)

  if (!port) {
    const clientIp = req.socket.remoteAddress ?? ''
    console.warn(`[proxy] ${clientIp} ${req.method} ${req.headers.host}${req.url} → 502 (no route for "${host}")`)
    res.writeHead(502, { 'Content-Type': 'text/plain' })
    res.end('Bad gateway')
    return
  }

  forwardTo(req, res, port)
}

const portListeners = new Map<number, { server: http.Server; targetPort: number }>()

function updatePortRoute(hostPort: number, targetPort: number) {
  const existing = portListeners.get(hostPort)
  if (existing) {
    existing.targetPort = targetPort
    console.log(`[proxy] port route updated: :${hostPort} → :${targetPort}`)
    return
  }

  const entry = { server: null as unknown as http.Server, targetPort }
  const server = http.createServer((req, res) => {
    forwardTo(req, res, entry.targetPort)
  })
  applyServerLimits(server)
  entry.server = server

  server.on('error', (err) => {
    console.error(`[proxy] failed to listen on :${hostPort}: ${err.message}`)
    portListeners.delete(hostPort)
  })

  server.listen(hostPort, () => {
    console.log(`[proxy] port listener started: :${hostPort} → :${targetPort}`)
  })

  portListeners.set(hostPort, entry)
}

function removePortRoute(hostPort: number) {
  const entry = portListeners.get(hostPort)
  if (!entry) return
  entry.server.close()
  portListeners.delete(hostPort)
  console.log(`[proxy] port listener closed: :${hostPort}`)
}

export async function closeAllPortListeners(): Promise<void> {
  const closes = [...portListeners.values()].map(
    (entry) => new Promise<void>((resolve) => entry.server.close(() => resolve()))
  )
  portListeners.clear()
  await Promise.all(closes)
}

function applyServerLimits(server: http.Server) {
  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.maxConnections = MAX_CONNECTIONS
}

export function startTLSProxy() {
  const server = tls.createServer({
    minVersion: 'TLSv1.2',
    SNICallback: (domain, callback) => {
      if (!hasProxyRoute(domain)) {
        callback(new Error(`Unknown domain: ${domain}`))
        return
      }

      const cached = getCachedCert(domain)
      if (cached) return callback(null, cached)

      const fromDisk = loadCachedCert(domain)
      if (fromDisk) return callback(null, fromDisk)

      if (!isTLSEnabled()) {
        callback(new Error(`No EMAIL set, cannot obtain cert for ${domain}`))
        return
      }
      obtainCert(domain)
        .then((ctx) => callback(null, ctx))
        .catch((err) => callback(err))
    }
  })

  // Non-listening HTTP server to parse decrypted TLS sockets as HTTP requests
  const httpHandler = http.createServer((req, res) => proxyRequest(req, res))
  applyServerLimits(httpHandler)

  server.on('secureConnection', (socket) => {
    httpHandler.emit('connection', socket)
  })

  server.listen(443, () => console.log('[proxy] TLS listening on :443'))
  return server
}

export function startHTTPProxy() {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'

    if (handleAcmeChallenge(url, res)) return

    if (isTLSEnabled()) {
      const host = req.headers.host ?? ''
      res.writeHead(301, { Location: `https://${host}${url}` })
      res.end()
      return
    }

    proxyRequest(req, res)
  })

  applyServerLimits(server)
  server.listen(80, () => console.log('[proxy] HTTP listening on :80'))
  return server
}

export function startDevProxy() {
  const server = http.createServer((req, res) => proxyRequest(req, res))
  applyServerLimits(server)

  server.listen(DEV_PORT, () => console.log(`[proxy] dev mode — HTTP listening on :${DEV_PORT}`))
  return server
}

export function restoreRoutes(
  apps: Array<{
    domain?: string
    hostPort?: number
    deployments: Array<{ port: number }>
    previews: Record<string, { domain: string; port: number }>
  }>
) {
  for (const app of apps) {
    const deployment = app.deployments[0]
    if (!deployment) continue

    if (app.domain) {
      updateProxyRoute(app.domain, deployment.port)
      loadCachedCert(app.domain)
    } else if (app.hostPort) {
      updatePortRoute(app.hostPort, deployment.port)
    }

    for (const preview of Object.values(app.previews ?? {})) {
      updateProxyRoute(preview.domain, preview.port)
      loadCachedCert(preview.domain)
    }
  }
}
