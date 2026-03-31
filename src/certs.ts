import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import * as acme from 'acme-client'
import { CERT_RENEW_BEFORE_DAYS, CERTS_DIR, EMAIL, IS_DEV } from './env.ts'
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

export async function renewExpiringCerts(
  domains: string[],
  renew: (domain: string) => Promise<tls.SecureContext> = obtainCert,
  now = Date.now()
): Promise<string[]> {
  if (!isTLSEnabled()) return []

  const uniqueDomains = [...new Set(domains.filter(Boolean))]
  const renewed: string[] = []

  for (const domain of uniqueDomains) {
    if (!shouldRenewCert(domain, now)) continue

    console.log(`[acme] renewing cert for ${domain}`)
    try {
      await renew(domain)
      renewed.push(domain)
    } catch (err) {
      console.error(`[acme] Failed to renew cert for ${domain}:`, getErrorMessage(err))
    }
  }

  return renewed
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
    challengeCreateFn: async (_authz, _challenge, keyAuthorization) => {
      challengeTokens.set(_challenge.token, keyAuthorization)
    },
    challengeRemoveFn: async (_authz, _challenge) => {
      challengeTokens.delete(_challenge.token)
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
