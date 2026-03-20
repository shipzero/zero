import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'

const tmpDir = path.join(os.tmpdir(), `zero-test-certs-${process.pid}`)
process.env.NODE_ENV = 'production'
process.env.EMAIL = 'test@example.com'
process.env.DOMAIN = 'example.com'
process.env.CERTS_PATH = tmpDir
process.env.CERT_RENEW_BEFORE_DAYS = '30'

const fixtureCert = fs.readFileSync('node_modules/ssh2/test/fixtures/https_cert.pem', 'utf8')

const certs = await import('./certs.ts')
const dummyContext = tls.createSecureContext()

function writeCert(domain: string, pem = fixtureCert) {
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(path.join(tmpDir, `${domain}.crt`), pem)
}

describe('cert renewal', () => {
  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('skips domains whose cert is not close to expiry', async () => {
    writeCert('stable.example.com')

    const renew = vi.fn().mockResolvedValue(dummyContext)
    const renewed = await certs.renewExpiringCerts(['stable.example.com'], renew)

    expect(renewed).toEqual([])
    expect(renew).not.toHaveBeenCalled()
  })

  it('renews domains whose cert expires within the configured window', async () => {
    writeCert('renew.example.com')

    const now = new Date('2030-12-01T00:00:00Z').getTime()
    const renew = vi.fn().mockResolvedValue(dummyContext)
    const renewed = await certs.renewExpiringCerts(['renew.example.com'], renew, now)

    expect(renewed).toEqual(['renew.example.com'])
    expect(renew).toHaveBeenCalledWith('renew.example.com')
  })
})
