import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import * as acme from 'acme-client'
import { isWildcardDomain, matchesWildcard } from './domains.ts'
import { CERT_RENEW_BEFORE_DAYS, CERTS_DIR, EMAIL, IS_DEV, ON_DEMAND_TLS_ASK, ON_DEMAND_TLS_PER_HOUR } from './env.ts'
import { getErrorMessage } from './errors.ts'
import { ensureDir, writeFileAtomic } from './fs.ts'
import { isTLSEnabled } from './url.ts'

const certCache = new Map<string, tls.SecureContext>()
const certInFlight = new Map<string, Promise<tls.SecureContext>>()
const challengeTokens = new Map<string, string>()

const ACCOUNT_KEY_FILE = 'account.pem'

async function getOrCreateAccountKey(): Promise<Buffer> {
  ensureDir(CERTS_DIR)
  const keyPath = path.join(CERTS_DIR, ACCOUNT_KEY_FILE)
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath)
  }
  const key = await acme.crypto.createPrivateEcdsaKey()
  fs.writeFileSync(keyPath, key, { mode: 0o600 })
  return key
}

export function certPath(domain: string) {
  return {
    cert: path.join(CERTS_DIR, `${domain}.crt`),
    key: path.join(CERTS_DIR, `${domain}.key`)
  }
}

export function loadCachedCert(domain: string): tls.SecureContext | null {
  const { cert, key } = certPath(domain)
  if (fs.existsSync(cert) && fs.existsSync(key)) {
    const context = tls.createSecureContext({
      cert: fs.readFileSync(cert),
      key: fs.readFileSync(key)
    })
    certCache.set(domain, context)
    return context
  }
  return null
}

export function getCachedCert(domain: string): tls.SecureContext | undefined {
  return certCache.get(domain)
}

function getCertExpiry(domain: string): Date | null {
  const { cert } = certPath(domain)
  if (!fs.existsSync(cert)) return null

  try {
    const pem = fs.readFileSync(cert, 'utf8')
    return new Date(new X509Certificate(pem).validTo)
  } catch (err) {
    console.warn(`[acme] Failed to inspect cert for ${domain}:`, getErrorMessage(err))
    return null
  }
}

export function shouldRenewCert(domain: string, now = Date.now()): boolean {
  const expiresAt = getCertExpiry(domain)
  if (!expiresAt) return false

  const renewBeforeMs = CERT_RENEW_BEFORE_DAYS * 24 * 60 * 60 * 1000
  return expiresAt.getTime() - now <= renewBeforeMs
}

export function managedDomains(apps: Array<{ domains: string[] }>, hostDomain: string): string[] {
  const appDomains = apps.flatMap((app) => app.domains)
  return hostDomain ? [hostDomain, ...appDomains] : appDomains
}

/** Hosts with a certificate on disk that a wildcard covers (issued on demand earlier). */
export function onDemandHosts(wildcard: string): string[] {
  if (!fs.existsSync(CERTS_DIR)) return []
  return fs
    .readdirSync(CERTS_DIR)
    .filter((file) => file.endsWith('.crt'))
    .map((file) => file.slice(0, -'.crt'.length))
    .filter((host) => matchesWildcard(host, wildcard))
}

export async function renewExpiringCerts(
  domains: string[],
  renew: (domain: string) => Promise<tls.SecureContext> = obtainCert,
  now = Date.now(),
  ask: (host: string) => Promise<AskVerdict> = askOnDemand
): Promise<string[]> {
  if (!isTLSEnabled()) return []

  const regularDomains = [...new Set(domains.filter((d) => d && !isWildcardDomain(d)))]
  // A wildcard has no certificate of its own: renew the hosts issued under it instead. A host that is also an
  // exact domain (of any app, or the server's DOMAIN) is a regular domain and never goes through the ask check.
  const exactDomains = new Set(regularDomains)
  const onDemandHostsToRenew = [...new Set(domains.filter(isWildcardDomain).flatMap(onDemandHosts))].filter(
    (host) => !exactDomains.has(host)
  )
  const renewed: string[] = []

  for (const domain of regularDomains) {
    if (shouldRenewCert(domain, now) && (await tryRenew(domain, renew))) renewed.push(domain)
  }

  for (const host of onDemandHostsToRenew) {
    if (!shouldRenewCert(host, now)) continue
    let verdict: AskVerdict
    try {
      verdict = await ask(host)
    } catch (err) {
      // The ask endpoint is unreachable: try again on the next run instead of letting the certificate lapse.
      console.warn(`[acme] not renewing ${host} this time: ${getErrorMessage(err)}`)
      continue
    }
    if (verdict === 'denied') {
      // A host the ask endpoint no longer approves keeps its certificate until it expires.
      console.log(`[acme] not renewing ${host}: no longer approved by ON_DEMAND_TLS_ASK`)
      continue
    }
    if (await tryRenew(host, renew)) renewed.push(host)
  }

  return renewed
}

async function tryRenew(domain: string, renew: (domain: string) => Promise<tls.SecureContext>): Promise<boolean> {
  console.log(`[acme] renewing cert for ${domain}`)
  try {
    await renew(domain)
    return true
  } catch (err) {
    console.error(`[acme] Failed to renew cert for ${domain}:`, getErrorMessage(err))
    return false
  }
}

export function obtainCert(domain: string): Promise<tls.SecureContext> {
  if (certInFlight.has(domain)) return certInFlight.get(domain)!

  const promise = _doObtainCert(domain).catch((err) => {
    console.error(`[acme] Failed to obtain cert for ${domain}:`, getErrorMessage(err))
    throw err
  })
  certInFlight.set(domain, promise)
  promise.then(
    () => certInFlight.delete(domain),
    () => certInFlight.delete(domain)
  )
  return promise
}

const ON_DEMAND_RETRY_AFTER_MS = 60 * 60 * 1000
// A failed ask call (endpoint down) is retried soon: an outage must not lock new hosts out for an hour.
const ON_DEMAND_ASK_RETRY_AFTER_MS = 60 * 1000
const ON_DEMAND_ASK_TIMEOUT_MS = 5000
const onDemandIssued: number[] = []
const onDemandFailedAt = new Map<string, number>()
const onDemandAskFailedAt = new Map<string, number>()
const onDemandInFlight = new Map<string, Promise<tls.SecureContext>>()

export type AskVerdict = 'approved' | 'denied'

/**
 * Asks ON_DEMAND_TLS_ASK whether a host may get a certificate (`GET <url>?domain=<host>`): 2xx approves,
 * 4xx denies. Anything else (timeout, network error, 5xx) means the endpoint could not decide and throws.
 * Without an ask URL every host under the wildcard is approved.
 */
export async function askOnDemand(host: string): Promise<AskVerdict> {
  if (!ON_DEMAND_TLS_ASK) return 'approved'
  const url = new URL(ON_DEMAND_TLS_ASK)
  url.searchParams.set('domain', host)
  const res = await fetch(url, { signal: AbortSignal.timeout(ON_DEMAND_ASK_TIMEOUT_MS) })
  // Release the connection for keep-alive; only the status matters.
  await res.body?.cancel()
  if (res.ok) return 'approved'
  if (res.status >= 400 && res.status < 500) return 'denied'
  throw new Error(`ON_DEMAND_TLS_ASK answered ${res.status}`)
}

/**
 * Certificate for a host that is only routed through a wildcard, issued during its first TLS handshake.
 * Anyone can point a name under a wildcard DNS record at the server, so issuance is guarded: the optional
 * ask endpoint must approve the host, at most ON_DEMAND_TLS_PER_HOUR new certificates are issued per hour,
 * and a host whose issuance failed is not retried for an hour (protects the Let's Encrypt rate limits).
 */
export function obtainOnDemandCert(
  host: string,
  issue: (domain: string) => Promise<tls.SecureContext> = obtainCert,
  ask: (host: string) => Promise<AskVerdict> = askOnDemand,
  now = Date.now()
): Promise<tls.SecureContext> {
  // Concurrent handshakes for a new host share one issuance (and count once against the limit).
  const inFlight = onDemandInFlight.get(host)
  if (inFlight) return inFlight
  const promise = issueOnDemand(host, issue, ask, now)
  onDemandInFlight.set(host, promise)
  promise.then(
    () => onDemandInFlight.delete(host),
    () => onDemandInFlight.delete(host)
  )
  return promise
}

async function issueOnDemand(
  host: string,
  issue: (domain: string) => Promise<tls.SecureContext>,
  ask: (host: string) => Promise<AskVerdict>,
  now: number
): Promise<tls.SecureContext> {
  pruneOnDemandState(now)
  if (onDemandFailedAt.has(host)) {
    throw new Error(`On-demand certificate for ${host} failed or was denied recently, retrying later`)
  }
  if (onDemandAskFailedAt.has(host)) {
    throw new Error(`ON_DEMAND_TLS_ASK was unreachable for ${host} a moment ago, retrying later`)
  }
  // The cap comes first, so a flood of random names costs neither ask calls nor certificates.
  if (onDemandIssued.length >= ON_DEMAND_TLS_PER_HOUR) {
    throw new Error(`On-demand certificate limit reached (${ON_DEMAND_TLS_PER_HOUR}/hour), not issuing for ${host}`)
  }
  let verdict: AskVerdict
  try {
    verdict = await ask(host)
  } catch (err) {
    onDemandAskFailedAt.set(host, now)
    throw new Error(`ON_DEMAND_TLS_ASK failed for ${host}: ${getErrorMessage(err)}`)
  }
  if (verdict === 'denied') {
    onDemandFailedAt.set(host, now)
    throw new Error(`On-demand certificate for ${host} not approved by ON_DEMAND_TLS_ASK`)
  }
  onDemandIssued.push(now)
  try {
    return await issue(host)
  } catch (err) {
    onDemandFailedAt.set(host, now)
    throw err
  }
}

/** Drops issuance timestamps and backoff entries that have run out, so the maps stay bounded. */
function pruneOnDemandState(now: number): void {
  while (onDemandIssued.length > 0 && now - onDemandIssued[0]! >= ON_DEMAND_RETRY_AFTER_MS) onDemandIssued.shift()
  for (const [host, at] of onDemandFailedAt) if (now - at >= ON_DEMAND_RETRY_AFTER_MS) onDemandFailedAt.delete(host)
  for (const [host, at] of onDemandAskFailedAt)
    if (now - at >= ON_DEMAND_ASK_RETRY_AFTER_MS) onDemandAskFailedAt.delete(host)
}

/** Test helper: forget issued and failed on-demand hosts. */
export function resetOnDemandState(): void {
  onDemandIssued.length = 0
  onDemandFailedAt.clear()
  onDemandAskFailedAt.clear()
}

let _acmeClient: acme.Client | null = null

async function getOrCreateClient(): Promise<acme.Client> {
  if (_acmeClient) return _acmeClient

  const directoryUrl = IS_DEV ? acme.directory.letsencrypt.staging : acme.directory.letsencrypt.production

  const accountKey = await getOrCreateAccountKey()

  _acmeClient = new acme.Client({ directoryUrl, accountKey })
  await _acmeClient.createAccount({
    termsOfServiceAgreed: true,
    contact: [`mailto:${EMAIL}`]
  })

  return _acmeClient
}

async function _doObtainCert(domain: string): Promise<tls.SecureContext> {
  console.log(`[acme] obtaining cert for ${domain}`)
  ensureDir(CERTS_DIR)

  const client = await getOrCreateClient()
  const [serverKey, serverCsr] = await acme.crypto.createCsr({ commonName: domain })

  const cert = await client.auto({
    csr: serverCsr,
    termsOfServiceAgreed: true,
    challengeCreateFn: (_authz, _challenge, keyAuthorization) => {
      challengeTokens.set(_challenge.token, keyAuthorization)
      return Promise.resolve()
    },
    challengeRemoveFn: (_authz, _challenge) => {
      challengeTokens.delete(_challenge.token)
      return Promise.resolve()
    }
  })

  const { cert: certFile, key: keyFile } = certPath(domain)
  writeFileAtomic(keyFile, serverKey)
  writeFileAtomic(certFile, cert)
  console.log(`[acme] cert saved for ${domain}`)

  const ctx = tls.createSecureContext({ cert, key: serverKey })
  certCache.set(domain, ctx)
  return ctx
}

/** Responds to ACME HTTP-01 challenges. Returns true if the request was handled. */
export function handleAcmeChallenge(url: string, res: import('node:http').ServerResponse): boolean {
  if (!url.startsWith('/.well-known/acme-challenge/')) return false

  const token = url.split('/').pop() ?? ''
  const keyAuth = challengeTokens.get(token)

  if (keyAuth) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(keyAuth)
  } else {
    res.writeHead(404)
    res.end('Not found')
  }
  return true
}
