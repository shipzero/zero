import { IS_DEV, EMAIL, DOMAIN, API_PORT } from './env.ts'

export function isDomain(value: string): boolean {
  return value !== '' && !/^\d+\.\d+\.\d+\.\d+$/.test(value)
}

export function hasDomain(): boolean {
  return isDomain(DOMAIN)
}

export function isTLSEnabled(): boolean {
  return !IS_DEV && EMAIL !== '' && isDomain(DOMAIN)
}

/** Builds a URL for a domain-based app (e.g. https://myapp.example.com). */
export function buildDomainUrl(domain: string): string {
  return `${isTLSEnabled() ? 'https' : 'http'}://${domain}`
}

/** Builds a URL for an app, falling back to host:port when no domain is set. */
export function buildAppUrl(domain: string | undefined, port: number): string {
  if (domain) return buildDomainUrl(domain)
  const host = DOMAIN || 'localhost'
  return `http://${host}:${port}`
}

/** Builds a webhook URL with the correct host and port. */
export function buildWebhookUrl(secret: string): string {
  const base = buildDomainUrl(DOMAIN || 'localhost')
  const needsPort = !isDomain(DOMAIN)
  return `${base}${needsPort ? `:${API_PORT}` : ''}/webhooks/${secret}`
}
