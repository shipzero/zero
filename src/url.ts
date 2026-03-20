import { IS_DEV, EMAIL, DOMAIN } from './env.ts'

function isDomain(value: string): boolean {
  return value !== '' && !/^\d+\.\d+\.\d+\.\d+$/.test(value)
}

export function isTLSEnabled(): boolean {
  return !IS_DEV && EMAIL !== '' && isDomain(DOMAIN)
}

export function buildDomainUrl(domain: string): string {
  return `${isTLSEnabled() ? 'https' : 'http'}://${domain}`
}
