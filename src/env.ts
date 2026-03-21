export const IS_DEV = process.env.NODE_ENV !== 'production'
export const DOMAIN = process.env.DOMAIN ?? ''
export const EMAIL = process.env.EMAIL ?? ''
export const TOKEN = process.env.TOKEN ?? ''
export const JWT_SECRET = process.env.JWT_SECRET ?? ''
export const API_PORT = Number(process.env.API_PORT ?? 2020)
export const DEV_PORT = Number(process.env.DEV_PORT ?? 8080)
export const STATE_PATH = process.env.STATE_PATH ?? (IS_DEV ? '.zero/state.json' : '/var/lib/zero/state.json')
export const CERTS_DIR = process.env.CERTS_PATH ?? (IS_DEV ? '.zero/certs' : '/var/lib/zero/certs')
export const CERT_RENEW_BEFORE_DAYS = Number(process.env.CERT_RENEW_BEFORE_DAYS ?? 30)
export const CERT_RENEW_INTERVAL_MS = Number(process.env.CERT_RENEW_INTERVAL_MS ?? 12 * 60 * 60 * 1000)
export const COMPOSE_BASE_DIR = process.env.COMPOSE_DIR ?? (IS_DEV ? '.zero/compose' : '/var/lib/zero/compose')
import { parseDuration } from './duration.ts'

function safeParseDuration(value: string, fallback: string): number {
  try {
    return parseDuration(value)
  } catch {
    console.error(`[config] invalid PREVIEW_TTL "${value}", falling back to ${fallback}`)
    return parseDuration(fallback)
  }
}

export const PREVIEW_TTL_MS = safeParseDuration(process.env.PREVIEW_TTL ?? '7d', '7d')
