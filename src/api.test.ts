import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// Set up isolated environment before imports
const tmpDir = path.join(os.tmpdir(), `zero-test-api-${process.pid}`)
process.env.STATE_PATH = path.join(tmpDir, 'state.json')
process.env.TOKEN = 'test-token-123'
process.env.JWT_SECRET = 'test-jwt-secret-for-testing'
process.env.API_PORT = '0' // let OS pick a free port
process.env.NODE_ENV = 'test'
process.env.EMAIL = ''

// Mock docker module to avoid needing a real Docker socket
import { vi } from 'vitest'

const mockListContainers = vi.fn().mockResolvedValue([])

vi.mock('./docker.ts', () => ({
  docker: { listContainers: (...args: unknown[]) => mockListContainers(...args) },
  pullImage: vi.fn().mockResolvedValue(undefined),
  inspectImage: vi.fn().mockResolvedValue({ exposedPorts: [], digest: 'sha256:mock' }),
  runContainer: vi.fn().mockResolvedValue('mock-container-id'),
  removeContainer: vi.fn().mockResolvedValue(undefined),
  stopContainer: vi.fn().mockResolvedValue(undefined),
  startContainer: vi.fn().mockResolvedValue(undefined),
  waitForHealthy: vi.fn().mockResolvedValue(undefined),
  getFreePort: vi.fn().mockResolvedValue(9999),
  streamLogs: vi.fn().mockReturnValue((async function* () {})()),
  streamStats: vi.fn().mockReturnValue((async function* () {})()),
  getContainerState: vi.fn().mockResolvedValue({ running: true, restartCount: 0 })
}))

vi.mock('./compose.ts', () => ({
  composeDir: vi.fn().mockReturnValue('/tmp/compose'),
  writeComposeFiles: vi.fn().mockReturnValue('/tmp/compose'),
  composePull: vi.fn().mockResolvedValue(undefined),
  composeUp: vi.fn().mockResolvedValue(undefined),
  composeDown: vi.fn().mockResolvedValue(undefined),
  composeStop: vi.fn().mockResolvedValue(undefined),
  composeStart: vi.fn().mockResolvedValue(undefined),
  composeLogs: vi.fn().mockReturnValue((async function* () {})()),
  removeComposeDir: vi.fn(),
  substituteImageTags: vi.fn().mockImplementation((content: string) => content),
  extractImageTag: vi.fn().mockImplementation((content: string, prefix: string) => {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = content.match(new RegExp(`image:\\s*${escaped}/[^:]+:([^\\s]+)`))
    return match?.[1] ?? null
  })
}))

vi.mock('./proxy.ts', () => ({
  routeApp: vi.fn(),
  unrouteApp: vi.fn(),
  updateProxyRoute: vi.fn(),
  removeProxyRoute: vi.fn(),
  removePortRoute: vi.fn()
}))

// Now import after mocks are set up
const state = await import('./state.ts')
const dockerMock = await import('./docker.ts')
const composeMock = await import('./compose.ts')
const { signJwt } = await import('./jwt.ts')
const { parseTail } = await import('./api/router.ts')

// We need to dynamically import api after mocks
const { startApi } = await import('./api.ts')

const JWT_SECRET = process.env.JWT_SECRET!

function mintTestJwt(expiresInSeconds = 3600): string {
  return signJwt(JWT_SECRET, { exp: Math.floor(Date.now() / 1000) + expiresInSeconds })
}

const testJwt = mintTestJwt()

function addTestApp(opts: {
  name: string
  image?: string
  domain?: string
  internalPort?: number
  hostPort?: number
  env?: Record<string, string>
  composeFile?: string
  entryService?: string
  imagePrefix?: string
  trackTag?: string
}) {
  const { image: rawImage = 'nginx:latest', domain, ...rest } = opts
  const domains = domain ? [domain] : []
  const colonIdx = rawImage.lastIndexOf(':')
  const hasTag = colonIdx > 0 && !rawImage.substring(colonIdx).includes('/')
  const image = hasTag ? rawImage.substring(0, colonIdx) : rawImage
  const trackTag = rest.trackTag ?? (hasTag ? rawImage.substring(colonIdx + 1) : 'latest')
  return state.addApp({ image, trackTag, internalPort: 80, env: {}, domains, ...rest })
}

let server: http.Server
let baseUrl: string

function request(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const headers: Record<string, string> = {}
    if (token !== undefined) {
      headers['Authorization'] = `Bearer ${token}`
    } else {
      headers['Authorization'] = `Bearer ${testJwt}`
    }
    const serialized = body ? JSON.stringify(body) : null
    if (serialized) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(serialized).toString()
    }

    const req = http.request(url, { method, headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode!, body: data })
        }
      })
    })
    req.on('error', reject)
    if (serialized) req.write(serialized)
    req.end()
  })
}

function requestSSE(
  path: string,
  body: unknown
): Promise<{ status: number; events: Array<{ event: string; [key: string]: unknown }> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl)
    const serialized = JSON.stringify(body)
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testJwt}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(serialized).toString()
        }
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          const events = data
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)))
          resolve({ status: res.statusCode!, events })
        })
      }
    )
    req.on('error', reject)
    req.write(serialized)
    req.end()
  })
}

describe('API', () => {
  beforeAll(async () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    state.loadState()
    server = await startApi()
    const addr = server.address() as { port: number }
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    fs.writeFileSync(process.env.STATE_PATH!, JSON.stringify({ apps: {}, registryAuths: {} }))
    state.loadState()
    vi.clearAllMocks()
  })

  describe('authentication', () => {
    it('rejects requests without token', async () => {
      const res = await request('GET', '/apps', undefined, '')
      expect(res.status).toBe(401)
    })

    it('rejects requests with invalid JWT', async () => {
      const res = await request('GET', '/apps', undefined, 'invalid-jwt')
      expect(res.status).toBe(401)
    })

    it('rejects requests with expired JWT', async () => {
      const expired = mintTestJwt(-10)
      const res = await request('GET', '/apps', undefined, expired)
      expect(res.status).toBe(401)
    })

    it('rejects requests with static token (not JWT)', async () => {
      const res = await request('GET', '/apps', undefined, 'test-token-123')
      expect(res.status).toBe(401)
    })

    it('allows requests with valid JWT', async () => {
      const res = await request('GET', '/apps')
      expect(res.status).toBe(200)
    })
  })

  describe('POST /auth/token', () => {
    it('mints a JWT when called with static token', async () => {
      const res = await request('POST', '/auth/token', undefined, 'test-token-123')
      expect(res.status).toBe(200)
      const body = res.body as { token: string }
      expect(body.token).toBeDefined()
      expect(body.token.split('.')).toHaveLength(3)
    })

    it('rejects when called with wrong static token', async () => {
      const res = await request('POST', '/auth/token', undefined, 'wrong-token')
      expect(res.status).toBe(401)
    })

    it('rejects when called with a JWT instead of static token', async () => {
      const res = await request('POST', '/auth/token', undefined, testJwt)
      expect(res.status).toBe(401)
    })

    it('returns a JWT that can authenticate other endpoints', async () => {
      const mintRes = await request('POST', '/auth/token', undefined, 'test-token-123')
      const jwt = (mintRes.body as { token: string }).token
      const appsRes = await request('GET', '/apps', undefined, jwt)
      expect(appsRes.status).toBe(200)
    })
  })

  describe('GET /version', () => {
    it('returns version', async () => {
      const res = await request('GET', '/version')
      expect(res.status).toBe(200)
      expect((res.body as { version: string }).version).toBeDefined()
    })
  })

  describe('GET /apps', () => {
    it('returns empty list', async () => {
      const res = await request('GET', '/apps')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('returns apps after adding', async () => {
      addTestApp({ name: 'a' })
      const res = await request('GET', '/apps')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
    })
  })

  describe('GET /apps/:name', () => {
    it('returns app details', async () => {
      addTestApp({ name: 'detail', domain: 'detail.com' })
      const res = await request('GET', '/apps/detail')
      expect(res.status).toBe(200)
      const body = res.body as { name: string; domains: string[] }
      expect(body.name).toBe('detail')
      expect(body.domains).toEqual(['detail.com'])
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('GET', '/apps/nope')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /apps/:name/deploy', () => {
    it('starts deploy for existing app', async () => {
      addTestApp({ name: 'dep' })
      const res = await request('POST', '/apps/dep/deploy', { tag: 'v1' })
      expect(res.status).toBe(200)
      const body = res.body as { success: boolean; image: string }
      expect(body.success).toBe(true)
      expect(body.image).toBe('nginx:v1')
    })

    it('uses tracked tag when none specified', async () => {
      addTestApp({ name: 'dep2', image: 'nginx:stable' })
      const res = await request('POST', '/apps/dep2/deploy')
      expect(res.status).toBe(200)
      const body = res.body as { success: boolean; image: string }
      expect(body.success).toBe(true)
      expect(body.image).toBe('nginx:stable')
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('POST', '/apps/nope/deploy')
      expect(res.status).toBe(404)
    })
  })

  describe('PATCH /apps/:name/env', () => {
    it('updates environment variables', async () => {
      addTestApp({ name: 'envapp' })
      const res = await request('PATCH', '/apps/envapp/env', { FOO: 'bar', BAZ: 'qux' })
      expect(res.status).toBe(200)
      expect(state.getApp('envapp')!.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('PATCH', '/apps/nope/env', { X: '1' })
      expect(res.status).toBe(404)
    })

    it('rejects invalid JSON', async () => {
      addTestApp({ name: 'envapp2' })
      const res = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const url = new URL('/apps/envapp2/env', baseUrl)
        const req = http.request(
          url,
          {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${testJwt}`, 'Content-Type': 'application/json' }
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => (data += chunk))
            res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }))
          }
        )
        req.on('error', reject)
        req.write('not json')
        req.end()
      })
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /apps/:name/env', () => {
    it('removes environment variables', async () => {
      addTestApp({ name: 'envrm' })
      await request('PATCH', '/apps/envrm/env', { FOO: 'bar', BAZ: 'qux', KEEP: 'me' })
      const res = await request('DELETE', '/apps/envrm/env?key=FOO&key=BAZ')
      expect(res.status).toBe(200)
      expect(state.getApp('envrm')!.env).toEqual({ KEEP: 'me' })
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('DELETE', '/apps/nope/env?key=X')
      expect(res.status).toBe(404)
    })

    it('rejects missing keys', async () => {
      addTestApp({ name: 'envrm2' })
      const res = await request('DELETE', '/apps/envrm2/env')
      expect(res.status).toBe(400)
    })

    it('rejects empty keys array', async () => {
      addTestApp({ name: 'envrm3' })
      const res = await request('DELETE', '/apps/envrm3/env')
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /apps/:name', () => {
    it('removes an app', async () => {
      addTestApp({ name: 'delme' })
      const res = await request('DELETE', '/apps/delme')
      expect(res.status).toBe(200)
      expect(state.getApp('delme')).toBeUndefined()
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('DELETE', '/apps/nope')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /apps/:name/rollback', () => {
    it('returns 404 for unknown app', async () => {
      const res = await request('POST', '/apps/nope/rollback')
      expect(res.status).toBe(404)
    })

    it('returns 400 when no rollback target exists', async () => {
      addTestApp({ name: 'rb' })
      state.addDeployment('rb', { image: 'nginx:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })

      const res = await request('POST', '/apps/rb/rollback')
      expect(res.status).toBe(400)
    })

    it('triggers rollback when previous deployment exists', async () => {
      addTestApp({ name: 'rb2' })
      state.addDeployment('rb2', { image: 'nginx:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })
      state.addDeployment('rb2', { image: 'nginx:v2', containerId: 'c2', port: 3002, deployedAt: '2024-01-02' })

      const res = await request('POST', '/apps/rb2/rollback')
      expect(res.status).toBe(200)
      const body = res.body as { success: boolean; image: string }
      expect(body.success).toBe(true)
      expect(body.image).toBe('nginx:v1')
    })
  })

  describe('GET /apps/:name/deployments', () => {
    it('returns deployment history', async () => {
      addTestApp({ name: 'hist' })
      state.addDeployment('hist', { image: 'nginx:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })
      state.addDeployment('hist', { image: 'nginx:v2', containerId: 'c2', port: 3002, deployedAt: '2024-01-02' })

      const res = await request('GET', '/apps/hist/deployments')
      expect(res.status).toBe(200)
      const body = res.body as Array<{ image: string; isCurrent: boolean }>
      expect(body).toHaveLength(2)
      expect(body[0].isCurrent).toBe(true)
      expect(body[1].isCurrent).toBe(false)
    })
  })

  describe('POST /apps/:name/stop', () => {
    it('returns 400 when no deployment exists', async () => {
      addTestApp({ name: 'stopme' })
      const res = await request('POST', '/apps/stopme/stop')
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('POST', '/apps/nope/stop')
      expect(res.status).toBe(404)
    })

    it('stops a running container', async () => {
      addTestApp({ name: 'stopok' })
      state.addDeployment('stopok', { image: 'nginx:v1', containerId: 'stop-c1', port: 5000, deployedAt: '2024-01-01' })

      const res = await request('POST', '/apps/stopok/stop')
      expect(res.status).toBe(200)
      const body = res.body as { containerId: string }
      expect(body.containerId).toBe('stop-c1')
      expect(dockerMock.stopContainer).toHaveBeenCalledWith('stop-c1')
    })

    it('uses docker compose stop for compose apps', async () => {
      addTestApp({
        name: 'compstop',
        image: '',
        composeFile: 'version: "3"\nservices:\n  web:\n    image: nginx',
        entryService: 'web'
      })
      state.addDeployment('compstop', {
        image: 'compose',
        containerId: 'compose',
        port: 9999,
        deployedAt: '2024-01-01'
      })

      const res = await request('POST', '/apps/compstop/stop')
      expect(res.status).toBe(200)
      expect(composeMock.composeStop).toHaveBeenCalled()
      expect(dockerMock.stopContainer).not.toHaveBeenCalledWith('compose')
    })
  })

  describe('POST /apps/:name/start', () => {
    it('returns 400 when no deployment exists', async () => {
      addTestApp({ name: 'startme' })
      const res = await request('POST', '/apps/startme/start')
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('POST', '/apps/nope/start')
      expect(res.status).toBe(404)
    })

    it('starts a stopped container', async () => {
      addTestApp({ name: 'startok', domain: 'start.com' })
      state.addDeployment('startok', {
        image: 'nginx:v1',
        containerId: 'start-c1',
        port: 6000,
        deployedAt: '2024-01-01'
      })

      const res = await request('POST', '/apps/startok/start')
      expect(res.status).toBe(200)
      const body = res.body as { port: number }
      expect(body.port).toBe(6000)
      expect(dockerMock.startContainer).toHaveBeenCalledWith('start-c1')
    })

    it('uses docker compose start for compose apps', async () => {
      addTestApp({
        name: 'compstart',
        image: '',
        composeFile: 'version: "3"\nservices:\n  web:\n    image: nginx',
        entryService: 'web'
      })
      state.addDeployment('compstart', {
        image: 'compose',
        containerId: 'compose',
        port: 9999,
        deployedAt: '2024-01-01'
      })

      const res = await request('POST', '/apps/compstart/start')
      expect(res.status).toBe(200)
      expect(composeMock.composeStart).toHaveBeenCalled()
      expect(dockerMock.startContainer).not.toHaveBeenCalledWith('compose')
    })
  })

  describe('registry endpoints', () => {
    it('POST /registry saves credentials', async () => {
      const res = await request('POST', '/registries', { server: 'ghcr.io', username: 'u', password: 'p' })
      expect(res.status).toBe(200)
      expect(state.getRegistryAuth('ghcr.io')).toEqual({ username: 'u', password: 'p' })
    })

    it('POST /registry rejects incomplete body', async () => {
      const res = await request('POST', '/registries', { server: 'ghcr.io' })
      expect(res.status).toBe(400)
    })

    it('GET /registry lists servers', async () => {
      state.setRegistryAuth('ghcr.io', { username: 'u', password: 'p' })
      const res = await request('GET', '/registries')
      expect(res.status).toBe(200)
      expect(res.body).toEqual(['ghcr.io'])
    })

    it('DELETE /registry/:server removes credentials', async () => {
      state.setRegistryAuth('ghcr.io', { username: 'u', password: 'p' })
      const res = await request('DELETE', '/registries/ghcr.io')
      expect(res.status).toBe(200)
    })

    it('DELETE /registry/:server returns 404 for unknown', async () => {
      const res = await request('DELETE', '/registries/nope.io')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /apps/:name/webhook', () => {
    it('resets webhook secret and returns new URL', async () => {
      addTestApp({ name: 'hookapp' })
      const oldSecret = state.getApp('hookapp')!.webhookSecret

      const res = await request('POST', '/apps/hookapp/webhook')
      expect(res.status).toBe(200)

      const body = res.body as { webhookSecret: string; webhookUrl: string }
      expect(body.webhookSecret).toBeTruthy()
      expect(body.webhookSecret).not.toBe(oldSecret)
      expect(body.webhookUrl).toContain('/webhooks/hookapp')
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('POST', '/apps/nope/webhook')
      expect(res.status).toBe(404)
    })
  })

  describe('webhook', () => {
    function signedWebhookRequest(secret: string, path: string, payload: unknown) {
      const body = JSON.stringify(payload)
      const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
      return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const url = new URL(path, baseUrl)
        const req = http.request(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature }
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => (data += chunk))
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode!, body: JSON.parse(data) })
              } catch {
                resolve({ status: res.statusCode!, body: data })
              }
            })
          }
        )
        req.on('error', reject)
        req.write(body)
        req.end()
      })
    }

    it('skips auth for webhook endpoints', async () => {
      const app = state.addApp({ name: 'hook', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.name}`, {
        push_data: { tag: 'latest' }
      })
      expect(res.status).toBe(202)
    })

    it('returns 404 for unknown webhook secret', async () => {
      const res = await request('POST', '/webhooks/unknown-secret', { push_data: { tag: 'latest' } }, '')
      expect(res.status).toBe(404)
    })

    it('rejects webhook without signature', async () => {
      const app = state.addApp({ name: 'hook-nosig', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      const res = await request('POST', `/webhooks/${app.name}`, { push_data: { tag: 'latest' } }, '')
      expect(res.status).toBe(401)
      expect((res.body as { error: string }).error).toBe('Missing signature')
    })

    it('rejects webhook with invalid signature', async () => {
      const app = state.addApp({ name: 'hook-badsig', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      const res = await signedWebhookRequest('wrong-secret', `/webhooks/${app.name}`, {
        push_data: { tag: 'latest' }
      })
      expect(res.status).toBe(401)
      expect((res.body as { error: string }).error).toBe('Invalid signature')
    })

    it('ignores when tag does not match tracked tag and no domain', async () => {
      const app = state.addApp({ name: 'hook2', image: 'nginx', trackTag: 'stable', internalPort: 80, env: {} })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.name}`, {
        push_data: { tag: 'latest' }
      })
      expect(res.status).toBe(200)
      expect((res.body as { message: string }).message).toContain('Ignored')
    })

    it('triggers preview deploy when tag does not match but app has domain', async () => {
      const app = state.addApp({
        name: 'hookprev',
        image: 'nginx',
        trackTag: 'latest',
        domains: ['hookprev.example.com'],
        internalPort: 80,
        env: {}
      })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.name}`, {
        push_data: { tag: 'pr-21' }
      })
      expect(res.status).toBe(202)
      expect((res.body as { message: string }).message).toContain('Preview')
    })

    it('triggers compose preview deploy when imagePrefix is set and tag does not match', async () => {
      const app = state.addApp({
        name: 'hookcompprev',
        image: '',
        trackTag: 'test',
        domains: ['hookcompprev.example.com'],
        internalPort: 80,
        env: {},
        composeFile: 'services:\n  web:\n    image: ghcr.io/org/app/web:test',
        entryService: 'web',
        imagePrefix: 'ghcr.io/org/app'
      })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.name}`, {
        push_data: { tag: 'pr-99' }
      })
      expect(res.status).toBe(202)
      expect((res.body as { message: string }).message).toContain('Preview')
    })

    it('deploys when trackTag is "any"', async () => {
      const app = state.addApp({ name: 'hook3', image: 'nginx', trackTag: 'any', internalPort: 80, env: {} })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.name}`, {
        push_data: { tag: 'v5' }
      })
      expect(res.status).toBe(202)
    })

    it('extracts tag from GHCR payload', async () => {
      const app = state.addApp({ name: 'ghcr', image: 'ghcr.io/user/app', trackTag: 'v3', internalPort: 80, env: {} })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.name}`, {
        action: 'published',
        package: {
          package_version: {
            container_metadata: {
              tag: { name: 'v3' }
            }
          }
        }
      })
      expect(res.status).toBe(202)
    })
  })

  describe('POST /apps/:name/previews', () => {
    it('creates a preview deployment', async () => {
      addTestApp({ name: 'prev', domain: 'prev.example.com' })
      const res = await requestSSE('/apps/prev/previews', { label: 'pr-1', tag: 'pr-1' })
      expect(res.status).toBe(200)
      const complete = res.events.find((e) => e.event === 'complete') as Record<string, unknown>
      expect(complete.name).toBe('prev')
      expect(complete.label).toBe('pr-1')
      expect(complete.domain).toBe('preview-pr-1.prev.example.com')
      expect(complete.success).toBe(true)
      const preview = state.getApp('prev')?.previews['pr-1']
      expect(preview).toBeDefined()
      expect(preview!.domain).toBe('preview-pr-1.prev.example.com')
    })

    it('redeploys existing preview', async () => {
      addTestApp({ name: 'prev2', domain: 'prev2.example.com' })
      await requestSSE('/apps/prev2/previews', { label: 'pr-2', tag: 'pr-2' })
      const res = await requestSSE('/apps/prev2/previews', { label: 'pr-2', tag: 'pr-2-updated' })
      expect(res.status).toBe(200)
      const complete = res.events.find((e) => e.event === 'complete') as Record<string, unknown>
      expect(complete.success).toBe(true)
      const preview = state.getApp('prev2')?.previews['pr-2']
      expect(preview!.image).toBe('nginx:pr-2-updated')
    })

    it('rejects preview without domain on parent', async () => {
      addTestApp({ name: 'nodom' })
      const res = await request('POST', '/apps/nodom/previews', { label: 'pr-1', tag: 'pr-1' })
      expect(res.status).toBe(400)
      expect((res.body as { error: string }).error).toContain('domain')
    })

    it('rejects missing tag', async () => {
      addTestApp({ name: 'prev4', domain: 'prev4.example.com' })
      const res = await request('POST', '/apps/prev4/previews', { label: 'pr-4' })
      expect(res.status).toBe(400)
      expect((res.body as { error: string }).error).toContain('--tag')
    })

    it('sets TTL on preview', async () => {
      addTestApp({ name: 'prev6', domain: 'prev6.example.com' })
      await requestSSE('/apps/prev6/previews', { label: 'pr-6', tag: 'pr-6', ttl: '24h' })
      const preview = state.getApp('prev6')?.previews['pr-6']
      expect(preview?.expiresAt).toBeDefined()
      const expiresAt = new Date(preview!.expiresAt).getTime()
      const expectedMin = Date.now() + 23 * 60 * 60 * 1000
      expect(expiresAt).toBeGreaterThan(expectedMin)
    })

    it('creates a compose preview deployment', async () => {
      addTestApp({
        name: 'compprev',
        image: '',
        composeFile: 'version: "3"\nservices:\n  web:\n    image: ghcr.io/org/app/web:latest',
        entryService: 'web',
        domain: 'compprev.example.com',
        imagePrefix: 'ghcr.io/org/app'
      })
      const res = await requestSSE('/apps/compprev/previews', { label: 'pr-1' })
      expect(res.status).toBe(200)
      const complete = res.events.find((e) => e.event === 'complete') as Record<string, unknown>
      expect(complete.name).toBe('compprev')
      expect(complete.label).toBe('pr-1')
      expect(complete.domain).toBe('preview-pr-1.compprev.example.com')
      expect(complete.success).toBe(true)
      const preview = state.getApp('compprev')?.previews['pr-1']
      expect(preview).toBeDefined()
      expect(preview!.isCompose).toBe(true)
    })

    it('rejects compose preview without imagePrefix', async () => {
      addTestApp({
        name: 'compnotag',
        image: '',
        composeFile: 'version: "3"\nservices:\n  web:\n    image: nginx',
        entryService: 'web',
        domain: 'compnotag.example.com'
      })
      const res = await requestSSE('/apps/compnotag/previews', { label: 'pr-1' })
      expect(res.status).toBe(400)
    })

    it('stores tag in compose preview image field', async () => {
      addTestApp({
        name: 'comptag',
        image: '',
        composeFile: 'services:\n  web:\n    image: ghcr.io/org/app/web:latest',
        entryService: 'web',
        domain: 'comptag.example.com',
        imagePrefix: 'ghcr.io/org/app',
        trackTag: 'latest'
      })
      await requestSSE('/apps/comptag/previews', { label: 'pr-5', tag: 'pr-5' })
      const preview = state.getApp('comptag')?.previews['pr-5']
      expect(preview!.image).toBe('pr-5')
    })

    it('uses trackTag for compose preview when no tag given', async () => {
      addTestApp({
        name: 'compdefault',
        image: '',
        composeFile: 'services:\n  web:\n    image: ghcr.io/org/app/web:stable',
        entryService: 'web',
        domain: 'compdefault.example.com',
        imagePrefix: 'ghcr.io/org/app',
        trackTag: 'stable'
      })
      await request('POST', '/apps/compdefault/previews', { label: 'prev' })
      const preview = state.getApp('compdefault')?.previews['prev']
      expect(preview!.image).toBe('stable')
    })
  })

  describe('GET /apps/:name/previews', () => {
    it('lists previews for an app', async () => {
      addTestApp({ name: 'pls', domain: 'pls.example.com' })
      await requestSSE('/apps/pls/previews', { label: 'pr-1', tag: 'pr-1' })
      await requestSSE('/apps/pls/previews', { label: 'pr-2', tag: 'pr-2' })

      const res = await request('GET', '/apps/pls/previews')
      expect(res.status).toBe(200)
      const previews = res.body as Array<{ label: string; domain: string }>
      expect(previews).toHaveLength(2)
      expect(previews.map((p) => p.label).sort()).toEqual(['pr-1', 'pr-2'])
    })

    it('returns empty array when no previews', async () => {
      addTestApp({ name: 'pls2', domain: 'pls2.example.com' })
      const res = await request('GET', '/apps/pls2/previews')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('returns 404 for unknown parent', async () => {
      const res = await request('GET', '/apps/nope/previews')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /apps/:name/previews/:label', () => {
    it('removes a specific preview', async () => {
      addTestApp({ name: 'pdel', domain: 'pdel.example.com' })
      await requestSSE('/apps/pdel/previews', { label: 'pr-1', tag: 'pr-1' })

      const res = await request('DELETE', '/apps/pdel/previews/pr-1')
      expect(res.status).toBe(200)
      expect(state.getApp('pdel')?.previews['pr-1']).toBeUndefined()
    })

    it('returns 404 for unknown preview', async () => {
      addTestApp({ name: 'pdel2', domain: 'pdel2.example.com' })
      const res = await request('DELETE', '/apps/pdel2/previews/nope')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /apps/:name/previews/:label/logs', () => {
    it('returns 404 for unknown preview', async () => {
      addTestApp({ name: 'plog', domain: 'plog.example.com' })
      const res = await request('GET', '/apps/plog/previews/nope/logs')
      expect(res.status).toBe(404)
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('GET', '/apps/nope/previews/x/logs')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /apps/:name/previews/:label/metrics', () => {
    it('returns 404 for unknown preview', async () => {
      addTestApp({ name: 'pmet', domain: 'pmet.example.com' })
      const res = await request('GET', '/apps/pmet/previews/nope/metrics')
      expect(res.status).toBe(404)
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('GET', '/apps/nope/previews/x/metrics')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /apps/:name/previews', () => {
    it('removes all previews for an app', async () => {
      addTestApp({ name: 'pdelall', domain: 'pdelall.example.com' })
      await requestSSE('/apps/pdelall/previews', { label: 'pr-1', tag: 'pr-1' })
      await requestSSE('/apps/pdelall/previews', { label: 'pr-2', tag: 'pr-2' })

      const res = await request('DELETE', '/apps/pdelall/previews')
      expect(res.status).toBe(200)
      expect((res.body as { message: string }).message).toContain('2')
      expect(state.getApp('pdelall')?.previews).toEqual({})
    })

    it('deleting parent also removes previews', async () => {
      addTestApp({ name: 'pparent', domain: 'pparent.example.com' })
      await requestSSE('/apps/pparent/previews', { label: 'pr-1', tag: 'pr-1' })

      await request('DELETE', '/apps/pparent')
      expect(state.getApp('pparent')).toBeUndefined()
    })
  })

  describe('GET /apps includes previews inline', () => {
    it('previews do not appear as separate apps', async () => {
      addTestApp({ name: 'pvis', domain: 'pvis.example.com' })
      await requestSSE('/apps/pvis/previews', { label: 'pr-1', tag: 'pr-1' })

      const res = await request('GET', '/apps')
      expect(res.status).toBe(200)
      const apps = res.body as Array<{ name: string; previews: Array<{ label: string }> }>
      expect(apps).toHaveLength(1)
      expect(apps[0].name).toBe('pvis')
      expect(apps[0].previews).toHaveLength(1)
      expect(apps[0].previews[0].label).toBe('pr-1')
    })

    it('returns empty previews array when app has no previews', async () => {
      addTestApp({ name: 'noprev' })
      const res = await request('GET', '/apps')
      const apps = res.body as Array<{ name: string; previews: unknown[] }>
      const app = apps.find((a) => a.name === 'noprev')
      expect(app?.previews).toEqual([])
    })
  })

  describe('POST /deploy', () => {
    it('creates and deploys a new app from image', async () => {
      const res = await requestSSE('/deploy', { image: 'ghcr.io/org/newapp:v1' })
      expect(res.status).toBe(200)
      const accepted = res.events.find((e) => e.event === 'accepted')
      const complete = res.events.find((e) => e.event === 'complete')
      expect(accepted?.appName).toBe('newapp')
      expect(accepted?.isNew).toBe(true)
      expect(accepted?.webhookUrl).toBeDefined()
      expect(complete?.success).toBe(true)
    })

    it('deploys existing app by name', async () => {
      addTestApp({ name: 'existing' })
      const res = await requestSSE('/deploy', { name: 'existing' })
      expect(res.status).toBe(200)
      const accepted = res.events.find((e) => e.event === 'accepted')
      const complete = res.events.find((e) => e.event === 'complete')
      expect(accepted?.appName).toBe('existing')
      expect(accepted?.isNew).toBe(false)
      expect(complete?.success).toBe(true)
    })

    it('streams log events during deploy', async () => {
      const res = await requestSSE('/deploy', { image: 'ghcr.io/user/logtest:latest' })
      const logs = res.events.filter((e) => e.event === 'log')
      expect(logs.length).toBeGreaterThan(0)
    })

    it('infers name from image', async () => {
      const res = await requestSSE('/deploy', { image: 'ghcr.io/user/myapi:latest' })
      const accepted = res.events.find((e) => e.event === 'accepted')
      expect(accepted?.appName).toBe('myapi')
    })

    it('uses explicit name over inferred', async () => {
      const res = await requestSSE('/deploy', { image: 'nginx:latest', name: 'web' })
      const accepted = res.events.find((e) => e.event === 'accepted')
      expect(accepted?.appName).toBe('web')
    })

    it('sets trackTag from image tag', async () => {
      await requestSSE('/deploy', { image: 'ghcr.io/org/tagtest:v2' })
      const app = state.getApp('tagtest')!
      expect(app.trackTag).toBe('v2')
    })

    it('sets trackTag from explicit --tag over image tag', async () => {
      await requestSSE('/deploy', { image: 'ghcr.io/org/tagprio:latest', tag: 'stable' })
      const app = state.getApp('tagprio')!
      expect(app.trackTag).toBe('stable')
    })

    it('sets trackTag from explicit --tag when image has no tag', async () => {
      await requestSSE('/deploy', { image: 'ghcr.io/org/notag', tag: 'pr-1' })
      const app = state.getApp('notag')!
      expect(app.trackTag).toBe('pr-1')
    })

    it('sets trackTag from compose file image tag when imagePrefix is set', async () => {
      await requestSSE('/deploy', {
        name: 'comptagtest',
        composeFile: 'services:\n  web:\n    image: ghcr.io/org/app/web:latest',
        entryService: 'web',
        imagePrefix: 'ghcr.io/org/app'
      })
      const app = state.getApp('comptagtest')!
      expect(app.trackTag).toBe('latest')
    })

    it('prefers explicit --tag over compose file tag', async () => {
      await requestSSE('/deploy', {
        name: 'comptagprio',
        composeFile: 'services:\n  web:\n    image: ghcr.io/org/app/web:latest',
        entryService: 'web',
        imagePrefix: 'ghcr.io/org/app',
        tag: 'stable'
      })
      const app = state.getApp('comptagprio')!
      expect(app.trackTag).toBe('stable')
    })

    it('returns 400 without image or name', async () => {
      const res = await request('POST', '/deploy', {})
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown app name without image', async () => {
      const res = await request('POST', '/deploy', { name: 'doesnotexist' })
      expect(res.status).toBe(404)
    })

    it('sets env vars on new app', async () => {
      const res = await requestSSE('/deploy', {
        image: 'ghcr.io/org/envnew:latest',
        env: { DB_URL: 'postgres://localhost/db', SECRET: 'abc' }
      })
      expect(res.status).toBe(200)
      const app = state.getApp('envnew')!
      expect(app.env).toEqual({ DB_URL: 'postgres://localhost/db', SECRET: 'abc' })
    })

    it('merges env vars on existing app', async () => {
      await requestSSE('/deploy', {
        image: 'ghcr.io/org/envmerge:latest',
        env: { KEY1: 'val1', KEY2: 'val2' }
      })
      await requestSSE('/deploy', {
        name: 'envmerge',
        env: { KEY2: 'updated', KEY3: 'val3' }
      })
      const app = state.getApp('envmerge')!
      expect(app.env).toEqual({ KEY1: 'val1', KEY2: 'updated', KEY3: 'val3' })
    })

    it('does not auto-assign domain when hostPort is set', async () => {
      const res = await requestSSE('/deploy', { image: 'ghcr.io/org/portonly:latest', hostPort: 8888 })
      expect(res.status).toBe(200)
      const app = state.getApp('portonly')!
      expect(app.domains).toEqual([])
      expect(app.hostPort).toBe(8888)
    })

    it('auto-assigns domain when no hostPort and explicit domain given', async () => {
      const res = await requestSSE('/deploy', { image: 'ghcr.io/org/autodom:latest', domain: 'autodom.example.com' })
      expect(res.status).toBe(200)
      const app = state.getApp('autodom')!
      expect(app.domains).toEqual(['autodom.example.com'])
      expect(app.hostPort).toBeUndefined()
    })

    it('uses explicit domain even with hostPort', async () => {
      const res = await requestSSE('/deploy', {
        image: 'ghcr.io/org/both:latest',
        domain: 'both.example.com',
        hostPort: 9999
      })
      expect(res.status).toBe(200)
      const app = state.getApp('both')!
      expect(app.domains).toEqual(['both.example.com'])
      expect(app.hostPort).toBe(9999)
    })
  })

  describe('404 for unknown routes', () => {
    it('returns 404', async () => {
      const res = await request('GET', '/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  describe('domain management', () => {
    it('GET /apps/:name/domains returns domains', async () => {
      addTestApp({ name: 'domapp', domain: 'domapp.com' })
      const res = await request('GET', '/apps/domapp/domains')
      expect(res.status).toBe(200)
      expect((res.body as { domains: string[] }).domains).toEqual(['domapp.com'])
    })

    it('POST /apps/:name/domains adds a domain', async () => {
      addTestApp({ name: 'domadd' })
      const res = await request('POST', '/apps/domadd/domains', { domain: 'new.com' })
      expect(res.status).toBe(200)
      expect((res.body as { domains: string[]; added: string }).added).toBe('new.com')
      expect(state.getApp('domadd')!.domains).toContain('new.com')
    })

    it('POST /apps/:name/domains rejects missing domain', async () => {
      addTestApp({ name: 'domadd2' })
      const res = await request('POST', '/apps/domadd2/domains', {})
      expect(res.status).toBe(400)
    })

    it('POST /apps/:name/domains rejects duplicate domain', async () => {
      addTestApp({ name: 'domdup', domain: 'taken.com' })
      addTestApp({ name: 'domdup2' })
      const res = await request('POST', '/apps/domdup2/domains', { domain: 'taken.com' })
      expect(res.status).toBe(400)
      expect((res.body as { error: string }).error).toContain('already used')
    })

    it('DELETE /apps/:name/domains/:domain removes a domain', async () => {
      addTestApp({ name: 'domrm', domain: 'remove.com' })
      state.addDomain('domrm', 'extra.com')
      const res = await request('DELETE', '/apps/domrm/domains/extra.com')
      expect(res.status).toBe(200)
      expect(state.getApp('domrm')!.domains).toEqual(['remove.com'])
    })

    it('DELETE /apps/:name/domains/:domain returns 404 for unknown domain', async () => {
      addTestApp({ name: 'domrm2' })
      const res = await request('DELETE', '/apps/domrm2/domains/nope.com')
      expect(res.status).toBe(404)
    })

    it('DELETE /apps/:name/domains/:domain blocks removing last domain with active previews', async () => {
      addTestApp({ name: 'domblock', domain: 'block.com' })
      state.setPreview('domblock', 'pr-1', {
        label: 'pr-1',
        domain: 'preview-pr-1.block.com',
        image: 'nginx:pr-1',
        containerId: 'c1',
        port: 4000,
        deployedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2026-12-01T00:00:00Z'
      })
      const res = await request('DELETE', '/apps/domblock/domains/block.com')
      expect(res.status).toBe(400)
      expect((res.body as { error: string }).error).toContain('previews exist')
    })

    it('POST /apps/:name/domains removes auto-assigned host port', async () => {
      addTestApp({ name: 'autoport', hostPort: 7777 })
      state.getApp('autoport')!.isAutoHostPort = true
      state.saveState()
      const res = await request('POST', '/apps/autoport/domains', { domain: 'autoport.com' })
      expect(res.status).toBe(200)
      const body = res.body as { removedHostPort?: number }
      expect(body.removedHostPort).toBe(7777)
      expect(state.getApp('autoport')!.hostPort).toBeUndefined()
    })

    it('POST /apps/:name/domains keeps explicit host port', async () => {
      addTestApp({ name: 'explport', hostPort: 8888 })
      const res = await request('POST', '/apps/explport/domains', { domain: 'explport.com' })
      expect(res.status).toBe(200)
      const body = res.body as { hostPort?: number; removedHostPort?: number }
      expect(body.hostPort).toBe(8888)
      expect(body.removedHostPort).toBeUndefined()
    })

    it('DELETE /apps/:name/host-port removes host port', async () => {
      addTestApp({ name: 'rmport', domain: 'rmport.com', hostPort: 9999 })
      const res = await request('DELETE', '/apps/rmport/host-port')
      expect(res.status).toBe(200)
      expect(state.getApp('rmport')!.hostPort).toBeUndefined()
    })

    it('DELETE /apps/:name/host-port returns 400 when no host port', async () => {
      addTestApp({ name: 'noport', domain: 'noport.com' })
      const res = await request('DELETE', '/apps/noport/host-port')
      expect(res.status).toBe(400)
    })
  })

  describe('compose container resolution', () => {
    it('GET /apps list passes project filter for compose app status', async () => {
      addTestApp({
        name: 'complist',
        domain: 'complist.com',
        composeFile: 'version: "3"',
        entryService: 'api'
      })
      state.addDeployment('complist', {
        image: 'latest',
        containerId: 'compose',
        port: 5556,
        deployedAt: new Date().toISOString()
      })
      mockListContainers.mockResolvedValueOnce([{ Id: 'prod-container' }])

      await request('GET', '/apps')
      expect(mockListContainers).toHaveBeenCalledWith({
        filters: {
          label: ['com.docker.compose.service=api', 'com.docker.compose.project=complist']
        }
      })
    })
  })
})

describe('parseTail', () => {
  it('returns default for no query string', () => {
    expect(parseTail('/apps/myapp/logs')).toBe(100)
  })

  it('returns default for missing tail param', () => {
    expect(parseTail('/apps/myapp/logs?foo=bar')).toBe(100)
  })

  it('parses valid tail value', () => {
    expect(parseTail('/apps/myapp/logs?tail=500')).toBe(500)
  })

  it('returns default for non-positive values', () => {
    expect(parseTail('/apps/myapp/logs?tail=0')).toBe(100)
    expect(parseTail('/apps/myapp/logs?tail=-1')).toBe(100)
  })

  it('returns default for non-numeric values', () => {
    expect(parseTail('/apps/myapp/logs?tail=abc')).toBe(100)
  })

  it('returns default for undefined', () => {
    expect(parseTail(undefined)).toBe(100)
  })
})
