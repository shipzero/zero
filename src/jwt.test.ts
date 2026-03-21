import { describe, it, expect } from 'vitest'
import { signJwt, verifyJwt } from './jwt.ts'

const SECRET = 'test-secret-key-for-jwt-testing'

describe('JWT', () => {
  it('roundtrips sign and verify', () => {
    const token = signJwt(SECRET, { exp: Math.floor(Date.now() / 1000) + 3600 })
    const payload = verifyJwt(SECRET, token)
    expect(payload).not.toBeNull()
    expect(payload!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(payload!.iat).toBeDefined()
  })

  it('rejects expired tokens', () => {
    const token = signJwt(SECRET, { exp: Math.floor(Date.now() / 1000) - 10 })
    expect(verifyJwt(SECRET, token)).toBeNull()
  })

  it('rejects tokens with invalid signature', () => {
    const token = signJwt(SECRET, { exp: Math.floor(Date.now() / 1000) + 3600 })
    const payload = verifyJwt('wrong-secret', token)
    expect(payload).toBeNull()
  })

  it('rejects malformed tokens', () => {
    expect(verifyJwt(SECRET, 'not-a-jwt')).toBeNull()
    expect(verifyJwt(SECRET, 'a.b')).toBeNull()
    expect(verifyJwt(SECRET, '')).toBeNull()
  })

  it('rejects tokens without exp', () => {
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
    const body = Buffer.from('{"iat":1}').toString('base64url')
    const crypto = require('node:crypto')
    const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest().toString('base64url')
    expect(verifyJwt(SECRET, `${header}.${body}.${sig}`)).toBeNull()
  })

  it('preserves custom payload fields', () => {
    const token = signJwt(SECRET, { exp: Math.floor(Date.now() / 1000) + 3600, sub: 'admin' })
    const payload = verifyJwt(SECRET, token)
    expect(payload!.sub).toBe('admin')
  })
})
