import { API_PORT, DOMAIN, EMAIL, IS_DEV } from './env.ts'

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

/** Builds a URL for an app. Returns undefined when no domain and no hostPort. */
export function buildAppUrl(domain: string | undefined, hostPort: number | undefined): string | undefined {
  if (domain) return buildDomainUrl(domain)
  if (!hostPort) return undefined
  const host = DOMAIN || 'localhost'
  return `http://${host}:${hostPort}`
}

/** Builds a webhook URL for an app. */
export function buildWebhookUrl(appName: string): string {
  const base = buildDomainUrl(DOMAIN || 'localhost')
  const needsPort = !isDomain(DOMAIN)
  return `${base}${needsPort ? `:${API_PORT}` : ''}/webhooks/${appName}`
}
