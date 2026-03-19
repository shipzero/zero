import { loadState, getApps } from './state.ts'
import { startTLSProxy, startHTTPProxy, startDevProxy, restoreRoutes, updateProxyRoute, closeAllPortListeners } from './proxy.ts'
import { startApi } from './api.ts'
import { renewExpiringCerts, isTLSEnabled } from './certs.ts'
import { VERSION } from './version.ts'

const isDevelopment = process.env.NODE_ENV !== 'production'
const CERT_RENEW_INTERVAL_MS = Number(process.env.CERT_RENEW_INTERVAL_MS ?? 12 * 60 * 60 * 1000)

if (!process.env.TOKEN) {
  if (isDevelopment) {
    console.warn('[warn] TOKEN not set — API is unprotected')
  } else {
    console.error('[fatal] TOKEN must be set in production')
    process.exit(1)
  }
}

console.log('┌──────────┐')
console.log('│   zero   │')
console.log('└──────────┘')
console.log(`[zero] ${isDevelopment ? 'dev' : `${VERSION} (production)`}`)

loadState()
restoreRoutes(getApps())

function managedDomains(): string[] {
  return getApps()
    .map((app) => app.domain)
    .filter((domain): domain is string => !!domain)
}

void renewExpiringCerts(managedDomains())

const certRenewTimer = setInterval(() => {
  void renewExpiringCerts(managedDomains())
}, CERT_RENEW_INTERVAL_MS)
certRenewTimer.unref()

const servers = isDevelopment
  ? [startDevProxy()]
  : isTLSEnabled()
    ? [startHTTPProxy(), startTLSProxy()]
    : [startHTTPProxy()]

const apiServer = await startApi()
servers.push(apiServer)

const DOMAIN = process.env.DOMAIN ?? ''
if (DOMAIN) {
  const API_PORT = Number(process.env.API_PORT ?? 2020)
  updateProxyRoute(DOMAIN, API_PORT)
}

console.log('[zero] ready')

const GRACEFUL_TIMEOUT_MS = 10_000

function shutdown(signal: string) {
  console.log(`[zero] ${signal} received, draining connections...`)

  const timeout = setTimeout(() => {
    console.warn('[zero] graceful timeout exceeded, forcing exit')
    process.exit(1)
  }, GRACEFUL_TIMEOUT_MS)
  timeout.unref()

  closeAllPortListeners()

  let remaining = servers.length
  for (const server of servers) {
    server.close(() => {
      remaining--
      if (remaining === 0) {
        console.log('[zero] all connections closed, exiting')
        process.exit(0)
      }
    })
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
