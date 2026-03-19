import tls from 'node:tls'
import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
// @ts-expect-error — no bundled types
import acme from 'acme'
// @ts-expect-error — no bundled types
import keypairs from '@root/keypairs'
// @ts-expect-error — no bundled types
import csr from '@root/csr'

const IS_DEV = process.env.NODE_ENV !== 'production'
const ACME_DIRECTORY_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'
const ACME_DIRECTORY_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory'
const CERTS_DIR = process.env.CERTS_PATH ?? (IS_DEV ? '.zero/certs' : '/data/certs')
const EMAIL = process.env.EMAIL ?? ''
const DOMAIN = process.env.DOMAIN ?? ''
const CERT_RENEW_BEFORE_DAYS = Number(process.env.CERT_RENEW_BEFORE_DAYS ?? 30)

const certCache = new Map<string, tls.SecureContext>()
const certInFlight = new Map<string, Promise<tls.SecureContext>>()
const challengeTokens = new Map<string, string>()

const ACCOUNT_KEY_FILE = 'account.jwk'

async function getOrCreateAccountKey(): Promise<object> {
  fs.mkdirSync(CERTS_DIR, { recursive: true })
  const keyPath = path.join(CERTS_DIR, ACCOUNT_KEY_FILE)
  if (fs.existsSync(keyPath)) {
    return JSON.parse(fs.readFileSync(keyPath, 'utf8')) as object
  }
  const keypair = await keypairs.generate({ kty: 'EC', namedCurve: 'P-256' })
  fs.writeFileSync(keyPath, JSON.stringify(keypair.private), { mode: 0o600 })
  return keypair.private as object
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
    console.warn(`[acme] failed to inspect cert for ${domain}:`, err instanceof Error ? err.message : err)
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
  if (!isAcmeConfigured()) return []

  const uniqueDomains = [...new Set(domains.filter(Boolean))]
  const renewed: string[] = []

  for (const domain of uniqueDomains) {
    if (!shouldRenewCert(domain, now)) continue

    console.log(`[acme] renewing cert for ${domain}`)
    try {
      await renew(domain)
      renewed.push(domain)
    } catch (err) {
      console.error(`[acme] failed to renew cert for ${domain}:`, err instanceof Error ? err.message : err)
    }
  }

  return renewed
}

export function obtainCert(domain: string): Promise<tls.SecureContext> {
  if (certInFlight.has(domain)) return certInFlight.get(domain)!

  const promise = _doObtainCert(domain).catch((err) => {
    console.error(`[acme] failed to obtain cert for ${domain}:`, err instanceof Error ? err.message : err)
    throw err
  })
  certInFlight.set(domain, promise)
  promise.then(
    () => certInFlight.delete(domain),
    () => certInFlight.delete(domain)
  )
  return promise
}

async function _doObtainCert(domain: string): Promise<tls.SecureContext> {
  console.log(`[acme] obtaining cert for ${domain}`)
  fs.mkdirSync(CERTS_DIR, { recursive: true })

  const directoryUrl = IS_DEV ? ACME_DIRECTORY_STAGING : ACME_DIRECTORY_PRODUCTION

  const client = acme.create({
    maintainerEmail: EMAIL,
    packageAgent: 'zero/1.0'
  })
  await client.init(directoryUrl)

  const accountKey = await getOrCreateAccountKey()
  const account = await client.accounts.create({
    subscriberEmail: EMAIL,
    agreeToTerms: true,
    accountKey
  })

  const serverKeypair = await keypairs.generate({ kty: 'RSA', modulusLength: 2048 })
  const csrDer = await csr.create({
    jwk: serverKeypair.private,
    domains: [domain]
  })

  const pems = await client.certificates.create({
    account,
    accountKey,
    csr: csrDer,
    domains: [domain],
    challenges: {
      'http-01': {
        init: async () => {},
        set: async (data: { challenge: { token: string; keyAuthorization: string } }) => {
          challengeTokens.set(data.challenge.token, data.challenge.keyAuthorization)
        },
        get: async (data: { challenge: { token: string } }) => {
          return { keyAuthorization: challengeTokens.get(data.challenge.token) }
        },
        remove: async (data: { challenge: { token: string } }) => {
          challengeTokens.delete(data.challenge.token)
        }
      }
    }
  })

  const { cert: certFile, key: keyFile } = certPath(domain)
  const pemKey = await keypairs.export({ jwk: serverKeypair.private })
  const fullChain = pems.cert + '\n' + (pems.chain ?? '')
  fs.writeFileSync(certFile, fullChain)
  fs.writeFileSync(keyFile, pemKey)
  console.log(`[acme] cert saved for ${domain}`)

  const ctx = tls.createSecureContext({ cert: fullChain, key: pemKey })
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

/** Whether ACME cert management is configured (EMAIL set). */
export function isAcmeConfigured(): boolean {
  return EMAIL !== ''
}

function isDomain(value: string): boolean {
  return value !== '' && !/^\d+\.\d+\.\d+\.\d+$/.test(value)
}

/** Whether TLS is fully active (production + EMAIL + real domain set). */
export function isTLSEnabled(): boolean {
  return !IS_DEV && EMAIL !== '' && isDomain(DOMAIN)
}
