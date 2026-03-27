import { startApi } from './api.ts'
import { renewExpiringCerts } from './certs.ts'
import { API_PORT, CERT_RENEW_INTERVAL_MS, DOMAIN, IS_DEV, JWT_SECRET, TOKEN } from './env.ts'
import { cleanupExpiredPreviews, startPreviewCleanupInterval } from './preview.ts'
import {
  closeAllPortListeners,
  restoreRoutes,
  startDevProxy,
  startHTTPProxy,
  startTLSProxy,
  updateProxyRoute
} from './proxy.ts'
import { getApps, loadState } from './state.ts'
import { isTLSEnabled } from './url.ts'
import { VERSION } from './version.ts'

if (!TOKEN) {
  if (IS_DEV) {
    console.warn('[warn] TOKEN not set — API is unprotected')
  } else {
    console.error('[fatal] TOKEN must be set in production')
    process.exit(1)
  }
}

if (!JWT_SECRET) {
  if (IS_DEV) {
    console.warn('[warn] JWT_SECRET not set — API is unprotected')
  } else {
    console.error('[fatal] JWT_SECRET must be set in production')
    process.exit(1)
  }
}

console.log('┌──────────┐')
console.log('│   zero   │')
console.log('└──────────┘')
console.log(`[zero] ${IS_DEV ? 'dev' : `${VERSION} (production)`}`)

loadState()
restoreRoutes(getApps())

function managedDomains(): string[] {
  return getApps().flatMap((app) => app.domains)
}

void renewExpiringCerts(managedDomains())

const certRenewTimer = setInterval(() => {
  void renewExpiringCerts(managedDomains())
}, CERT_RENEW_INTERVAL_MS)
certRenewTimer.unref()

void cleanupExpiredPreviews()
const previewCleanupTimer = startPreviewCleanupInterval()
previewCleanupTimer.unref()

const servers = IS_DEV ? [startDevProxy()] : isTLSEnabled() ? [startHTTPProxy(), startTLSProxy()] : [startHTTPProxy()]

const apiServer = await startApi()
servers.push(apiServer)

if (DOMAIN) {
  updateProxyRoute(DOMAIN, API_PORT)
}

console.log('[zero] ready')

const GRACEFUL_TIMEOUT_MS = 10_000

function shutdown(signal: string) {
  console.log(`[zero] ${signal} received, draining connections...`)

  const timeout = setTimeout(() => {
    console.warn('[zero] Graceful timeout exceeded, forcing exit')
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
