import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { getCachedCert, handleAcmeChallenge, loadCachedCert, obtainCert } from './certs.ts'
import {
  API_PORT,
  DEV_PORT,
  MAX_BODY_BYTES,
  PROXY_HEADERS_TIMEOUT_MS,
  PROXY_REQUEST_TIMEOUT_MS,
  PROXY_WS_IDLE_TIMEOUT_MS
} from './env.ts'
import { isTLSEnabled } from './url.ts'

const MAX_CONNECTIONS = 1024
const MAX_CONNECTIONS_PER_IP = 128

const HOP_BY_HOP_HEADERS = new Set(['keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'])

const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN'
}

const connectionsPerIp = new Map<string, number>()

function trackConnectionsPerIp(server: net.Server | tls.Server): void {
  server.on('connection', (socket: net.Socket) => {
    const ip = socket.remoteAddress ?? ''
    const current = connectionsPerIp.get(ip) ?? 0

    if (current >= MAX_CONNECTIONS_PER_IP) {
      console.warn(`[proxy] Per-IP limit exceeded for ${ip} (${current} connections)`)
      socket.destroy()
      return
    }

    connectionsPerIp.set(ip, current + 1)

    socket.once('close', () => {
      const count = connectionsPerIp.get(ip) ?? 1
      if (count <= 1) {
        connectionsPerIp.delete(ip)
      } else {
        connectionsPerIp.set(ip, count - 1)
      }
    })
  })
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

export function routeApp(app: { domains: string[]; hostPort?: number }, containerPort: number) {
  if (app.domains.length > 0) {
    for (const domain of app.domains) {
      updateProxyRoute(domain, containerPort)
    }
  } else if (app.hostPort) {
    updatePortRoute(app.hostPort, containerPort)
  }
}

export function unrouteApp(app: { domains: string[]; hostPort?: number }) {
  for (const domain of app.domains) {
    removeProxyRoute(domain)
  }
  if (app.hostPort) {
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

  const isApiRequest = targetPort === API_PORT
  const upstream = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
      timeout: isApiRequest ? 0 : PROXY_REQUEST_TIMEOUT_MS
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
    console.error(`[proxy] Upstream error: ${err.message}`)
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

function proxyUpgrade(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) {
  const host = (req.headers.host ?? '').split(':')[0]
  const port = routes.get(host)

  if (!port) {
    clientSocket.destroy()
    return
  }

  const clientIp = req.socket.remoteAddress ?? ''
  console.log(`[proxy] ${clientIp} UPGRADE ${req.headers.host}${req.url}`)

  const upstream = net.connect(port, '127.0.0.1', () => {
    const reqLine = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
    const headers = Object.entries(req.headers)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('\r\n')

    upstream.write(reqLine + headers + '\r\n\r\n')
    if (head.length > 0) upstream.write(head)

    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })

  function resetIdleTimeout(socket: net.Socket) {
    socket.setTimeout(PROXY_WS_IDLE_TIMEOUT_MS, () => {
      clientSocket.destroy()
      upstream.destroy()
    })
  }

  resetIdleTimeout(clientSocket)
  clientSocket.on('data', () => resetIdleTimeout(clientSocket))
  upstream.on('data', () => resetIdleTimeout(clientSocket))

  upstream.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstream.destroy())
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
  server.on('upgrade', proxyUpgrade)
  applyServerLimits(server)
  trackConnectionsPerIp(server)
  entry.server = server

  server.on('error', (err) => {
    console.error(`[proxy] Failed to listen on :${hostPort}: ${err.message}`)
    portListeners.delete(hostPort)
  })

  server.listen(hostPort, () => {
    console.log(`[proxy] port listener started: :${hostPort} → :${targetPort}`)
  })

  portListeners.set(hostPort, entry)
}

export function removePortRoute(hostPort: number) {
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
  server.requestTimeout = PROXY_REQUEST_TIMEOUT_MS
  server.headersTimeout = PROXY_HEADERS_TIMEOUT_MS
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
  httpHandler.on('upgrade', proxyUpgrade)
  applyServerLimits(httpHandler)

  server.on('secureConnection', (socket) => {
    httpHandler.emit('connection', socket)
  })

  trackConnectionsPerIp(server)
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

  server.on('upgrade', proxyUpgrade)
  applyServerLimits(server)
  trackConnectionsPerIp(server)
  server.listen(80, () => console.log('[proxy] HTTP listening on :80'))
  return server
}

export function startDevProxy() {
  const server = http.createServer((req, res) => proxyRequest(req, res))
  server.on('upgrade', proxyUpgrade)
  applyServerLimits(server)
  trackConnectionsPerIp(server)

  server.listen(DEV_PORT, () => console.log(`[proxy] dev mode — HTTP listening on :${DEV_PORT}`))
  return server
}

export function restoreRoutes(
  apps: Array<{
    domains: string[]
    hostPort?: number
    deployments: Array<{ port: number }>
    previews: Record<string, { domain: string; port: number }>
  }>
) {
  for (const app of apps) {
    const deployment = app.deployments[0]
    if (!deployment) continue

    if (app.domains.length > 0) {
      for (const domain of app.domains) {
        updateProxyRoute(domain, deployment.port)
        loadCachedCert(domain)
      }
    } else if (app.hostPort) {
      updatePortRoute(app.hostPort, deployment.port)
    }

    for (const preview of Object.values(app.previews ?? {})) {
      updateProxyRoute(preview.domain, preview.port)
      loadCachedCert(preview.domain)
    }
  }
}
