import crypto from 'node:crypto'

function base64url(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64url')
}

interface JwtPayload {
  exp: number
  iat: number
  [key: string]: unknown
}

/** Signs a JWT with HS256. Returns the compact token string. */
export function signJwt(secret: string, payload: Omit<JwtPayload, 'iat'> & { iat?: number }): string {
  const header = base64url('{"alg":"HS256","typ":"JWT"}')
  const body = base64url(JSON.stringify({ iat: Math.floor(Date.now() / 1000), ...payload }))
  const signature = base64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest())
  return `${header}.${body}.${signature}`
}

/** Verifies a JWT signed with HS256. Returns the payload or `null` if invalid/expired. */
export function verifyJwt(secret: string, token: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, signature] = parts
  const expected = base64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest())

  if (signature.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as JwtPayload
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
