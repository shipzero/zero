import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Set up isolated environment before imports
const tmpDir = path.join(os.tmpdir(), `zero-test-api-${process.pid}`)
process.env.STATE_PATH = path.join(tmpDir, 'state.json')
process.env.TOKEN = 'test-token-123'
process.env.API_PORT = '0' // let OS pick a free port
process.env.NODE_ENV = 'test'
process.env.EMAIL = ''

// Mock docker module to avoid needing a real Docker socket
import { vi } from 'vitest'
vi.mock('./docker.ts', () => ({
  docker: {},
  pullImage: vi.fn().mockResolvedValue(undefined),
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
  removeComposeDir: vi.fn()
}))

vi.mock('./proxy.ts', () => ({
  routeApp: vi.fn(),
  unrouteApp: vi.fn(),
  updateProxyRoute: vi.fn(),
  removeProxyRoute: vi.fn()
}))

// Now import after mocks are set up
const state = await import('./state.ts')
const dockerMock = await import('./docker.ts')
const composeMock = await import('./compose.ts')

// We need to dynamically import api after mocks
const { startApi } = await import('./api.ts')

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
      headers['Authorization'] = `Bearer test-token-123`
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

    it('rejects requests with wrong token', async () => {
      const res = await request('GET', '/apps', undefined, 'wrong-token')
      expect(res.status).toBe(401)
    })

    it('allows requests with correct token', async () => {
      const res = await request('GET', '/apps')
      expect(res.status).toBe(200)
    })
  })

  describe('GET /version', () => {
    it('returns version', async () => {
      const res = await request('GET', '/version')
      expect(res.status).toBe(200)
      expect((res.body as { version: string }).version).toBeDefined()
    })
  })

  describe('POST /apps', () => {
    it('creates an app', async () => {
      const res = await request('POST', '/apps', {
        name: 'testapp',
        image: 'nginx:latest',
        domain: 'test.com',
        internalPort: 80
      })
      expect(res.status).toBe(201)
      const body = res.body as { name: string; webhookSecret: string; webhookUrl: string }
      expect(body.name).toBe('testapp')
      expect(body.webhookSecret).toBeDefined()
      expect(body.webhookUrl).toContain('webhook')
    })

    it('rejects duplicate app name', async () => {
      await request('POST', '/apps', { name: 'dup', image: 'nginx:latest' })
      const res = await request('POST', '/apps', { name: 'dup', image: 'nginx:latest' })
      expect(res.status).toBe(409)
    })

    it('rejects missing name', async () => {
      const res = await request('POST', '/apps', { image: 'nginx:latest' })
      expect(res.status).toBe(400)
    })

    it('rejects missing image for non-compose app', async () => {
      const res = await request('POST', '/apps', { name: 'noimg' })
      expect(res.status).toBe(400)
    })

    it('rejects compose app without entryService', async () => {
      const res = await request('POST', '/apps', {
        name: 'comp',
        composeFile: 'version: "3"'
      })
      expect(res.status).toBe(400)
    })

    it('creates compose app successfully', async () => {
      const res = await request('POST', '/apps', {
        name: 'comp',
        composeFile: 'version: "3"\nservices:\n  web:\n    image: nginx',
        entryService: 'web'
      })
      expect(res.status).toBe(201)
    })

    it('parses image:tag correctly', async () => {
      await request('POST', '/apps', { name: 'tagged', image: 'myrepo/myimg:v2.1' })
      const app = state.getApp('tagged')!
      expect(app.image).toBe('myrepo/myimg')
      expect(app.trackTag).toBe('v2.1')
    })

    it('defaults tag to latest', async () => {
      await request('POST', '/apps', { name: 'notag', image: 'nginx' })
      const app = state.getApp('notag')!
      expect(app.trackTag).toBe('latest')
    })
  })

  describe('GET /apps', () => {
    it('returns empty list', async () => {
      const res = await request('GET', '/apps')
      expect(res.status).toBe(200)
      expect(res.body).toEqual([])
    })

    it('returns apps after adding', async () => {
      await request('POST', '/apps', { name: 'a', image: 'nginx:latest' })
      const res = await request('GET', '/apps')
      expect(res.status).toBe(200)
      expect(res.body).toHaveLength(1)
    })
  })

  describe('GET /apps/:name', () => {
    it('returns app details', async () => {
      await request('POST', '/apps', { name: 'detail', image: 'nginx:latest', domain: 'detail.com' })
      const res = await request('GET', '/apps/detail')
      expect(res.status).toBe(200)
      const body = res.body as { name: string; domain: string }
      expect(body.name).toBe('detail')
      expect(body.domain).toBe('detail.com')
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('GET', '/apps/nope')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /apps/:name/deploy', () => {
    it('starts deploy for existing app', async () => {
      await request('POST', '/apps', { name: 'dep', image: 'nginx:latest' })
      const res = await request('POST', '/apps/dep/deploy', { tag: 'v1' })
      expect(res.status).toBe(200)
      const body = res.body as { success: boolean; image: string }
      expect(body.success).toBe(true)
      expect(body.image).toBe('nginx:v1')
    })

    it('uses tracked tag when none specified', async () => {
      await request('POST', '/apps', { name: 'dep2', image: 'nginx:stable' })
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
      await request('POST', '/apps', { name: 'envapp', image: 'nginx:latest' })
      const res = await request('PATCH', '/apps/envapp/env', { FOO: 'bar', BAZ: 'qux' })
      expect(res.status).toBe(200)
      expect(state.getApp('envapp')!.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('PATCH', '/apps/nope/env', { X: '1' })
      expect(res.status).toBe(404)
    })

    it('rejects invalid JSON', async () => {
      await request('POST', '/apps', { name: 'envapp2', image: 'nginx:latest' })
      const res = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const url = new URL('/apps/envapp2/env', baseUrl)
        const req = http.request(
          url,
          {
            method: 'PATCH',
            headers: { Authorization: 'Bearer test-token-123', 'Content-Type': 'application/json' }
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
      await request('POST', '/apps', { name: 'envrm', image: 'nginx:latest' })
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
      await request('POST', '/apps', { name: 'envrm2', image: 'nginx:latest' })
      const res = await request('DELETE', '/apps/envrm2/env')
      expect(res.status).toBe(400)
    })

    it('rejects empty keys array', async () => {
      await request('POST', '/apps', { name: 'envrm3', image: 'nginx:latest' })
      const res = await request('DELETE', '/apps/envrm3/env')
      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /apps/:name', () => {
    it('removes an app', async () => {
      await request('POST', '/apps', { name: 'delme', image: 'nginx:latest' })
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
      await request('POST', '/apps', { name: 'rb', image: 'nginx:latest' })
      state.addDeployment('rb', { image: 'nginx:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })

      const res = await request('POST', '/apps/rb/rollback')
      expect(res.status).toBe(400)
    })

    it('triggers rollback when previous deployment exists', async () => {
      await request('POST', '/apps', { name: 'rb2', image: 'nginx:latest' })
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
      await request('POST', '/apps', { name: 'hist', image: 'nginx:latest' })
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
      await request('POST', '/apps', { name: 'stopme', image: 'nginx:latest' })
      const res = await request('POST', '/apps/stopme/stop')
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('POST', '/apps/nope/stop')
      expect(res.status).toBe(404)
    })

    it('stops a running container', async () => {
      await request('POST', '/apps', { name: 'stopok', image: 'nginx:latest' })
      state.addDeployment('stopok', { image: 'nginx:v1', containerId: 'stop-c1', port: 5000, deployedAt: '2024-01-01' })

      const res = await request('POST', '/apps/stopok/stop')
      expect(res.status).toBe(200)
      const body = res.body as { containerId: string }
      expect(body.containerId).toBe('stop-c1')
      expect(dockerMock.stopContainer).toHaveBeenCalledWith('stop-c1')
    })

    it('uses docker compose stop for compose apps', async () => {
      await request('POST', '/apps', {
        name: 'compstop',
        composeFile: 'version: "3"\nservices:\n  web:\n    image: nginx',
        entryService: 'web'
      })
      state.addDeployment('compstop', { image: 'compose', containerId: 'compose', port: 9999, deployedAt: '2024-01-01' })

      const res = await request('POST', '/apps/compstop/stop')
      expect(res.status).toBe(200)
      expect(composeMock.composeStop).toHaveBeenCalled()
      expect(dockerMock.stopContainer).not.toHaveBeenCalledWith('compose')
    })
  })

  describe('POST /apps/:name/start', () => {
    it('returns 400 when no deployment exists', async () => {
      await request('POST', '/apps', { name: 'startme', image: 'nginx:latest' })
      const res = await request('POST', '/apps/startme/start')
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('POST', '/apps/nope/start')
      expect(res.status).toBe(404)
    })

    it('starts a stopped container', async () => {
      await request('POST', '/apps', { name: 'startok', image: 'nginx:latest', domain: 'start.com' })
      state.addDeployment('startok', { image: 'nginx:v1', containerId: 'start-c1', port: 6000, deployedAt: '2024-01-01' })

      const res = await request('POST', '/apps/startok/start')
      expect(res.status).toBe(200)
      const body = res.body as { port: number }
      expect(body.port).toBe(6000)
      expect(dockerMock.startContainer).toHaveBeenCalledWith('start-c1')
    })

    it('uses docker compose start for compose apps', async () => {
      await request('POST', '/apps', {
        name: 'compstart',
        composeFile: 'version: "3"\nservices:\n  web:\n    image: nginx',
        entryService: 'web'
      })
      state.addDeployment('compstart', { image: 'compose', containerId: 'compose', port: 9999, deployedAt: '2024-01-01' })

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

  describe('POST /apps/:name/webhooks/reset', () => {
    it('resets webhook secret and returns new URL', async () => {
      await request('POST', '/apps', { name: 'hookapp', image: 'nginx:latest' })
      const oldSecret = state.getApp('hookapp')!.webhookSecret

      const res = await request('POST', '/apps/hookapp/webhooks/reset')
      expect(res.status).toBe(200)

      const body = res.body as { webhookSecret: string; webhookUrl: string }
      expect(body.webhookSecret).toBeTruthy()
      expect(body.webhookSecret).not.toBe(oldSecret)
      expect(body.webhookUrl).toContain(body.webhookSecret)
    })

    it('returns 404 for unknown app', async () => {
      const res = await request('POST', '/apps/nope/webhooks/reset')
      expect(res.status).toBe(404)
    })
  })

  describe('webhook', () => {
    function signedWebhookRequest(secret: string, path: string, payload: unknown) {
      const body = JSON.stringify(payload)
      const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
      return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const url = new URL(path, baseUrl)
        const req = http.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature }
        }, (res) => {
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
        req.write(body)
        req.end()
      })
    }

    it('skips auth for webhook endpoints', async () => {
      const app = state.addApp({ name: 'hook', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.webhookSecret}`, {
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
      const res = await request('POST', `/webhooks/${app.webhookSecret}`, { push_data: { tag: 'latest' } }, '')
      expect(res.status).toBe(401)
      expect((res.body as { error: string }).error).toBe('missing signature')
    })

    it('rejects webhook with invalid signature', async () => {
      const app = state.addApp({ name: 'hook-badsig', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      const res = await signedWebhookRequest('wrong-secret', `/webhooks/${app.webhookSecret}`, {
        push_data: { tag: 'latest' }
      })
      expect(res.status).toBe(401)
      expect((res.body as { error: string }).error).toBe('invalid signature')
    })

    it('ignores when tag does not match tracked tag', async () => {
      const app = state.addApp({ name: 'hook2', image: 'nginx', trackTag: 'stable', internalPort: 80, env: {} })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.webhookSecret}`, {
        push_data: { tag: 'latest' }
      })
      expect(res.status).toBe(200)
      expect((res.body as { message: string }).message).toContain('ignored')
    })

    it('deploys when trackTag is "any"', async () => {
      const app = state.addApp({ name: 'hook3', image: 'nginx', trackTag: 'any', internalPort: 80, env: {} })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.webhookSecret}`, {
        push_data: { tag: 'v5' }
      })
      expect(res.status).toBe(202)
    })

    it('extracts tag from GHCR payload', async () => {
      const app = state.addApp({ name: 'ghcr', image: 'ghcr.io/user/app', trackTag: 'v3', internalPort: 80, env: {} })
      const res = await signedWebhookRequest(app.webhookSecret, `/webhooks/${app.webhookSecret}`, {
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
      await request('POST', '/apps', { name: 'prev', image: 'nginx:latest', domain: 'prev.example.com' })
      const res = await request('POST', '/apps/prev/previews', { label: 'pr-1', tag: 'pr-1' })
      expect(res.status).toBe(201)
      const body = res.body as { name: string; label: string; domain: string; url: string; success: boolean }
      expect(body.name).toBe('prev')
      expect(body.label).toBe('pr-1')
      expect(body.domain).toBe('pr-1.prev.example.com')
      expect(body.success).toBe(true)
      const preview = state.getApp('prev')?.previews['pr-1']
      expect(preview).toBeDefined()
      expect(preview!.domain).toBe('pr-1.prev.example.com')
    })

    it('redeploys existing preview', async () => {
      await request('POST', '/apps', { name: 'prev2', image: 'nginx:latest', domain: 'prev2.example.com' })
      await request('POST', '/apps/prev2/previews', { label: 'pr-2', tag: 'pr-2' })
      const res = await request('POST', '/apps/prev2/previews', { label: 'pr-2', tag: 'pr-2-updated' })
      expect(res.status).toBe(201)
      expect((res.body as { success: boolean }).success).toBe(true)
      const preview = state.getApp('prev2')?.previews['pr-2']
      expect(preview!.image).toBe('nginx:pr-2-updated')
    })

    it('rejects preview without domain on parent', async () => {
      await request('POST', '/apps', { name: 'nodom', image: 'nginx:latest' })
      const res = await request('POST', '/apps/nodom/previews', { label: 'pr-1', tag: 'pr-1' })
      expect(res.status).toBe(400)
      expect((res.body as { error: string }).error).toContain('domain')
    })

    it('rejects missing tag', async () => {
      await request('POST', '/apps', { name: 'prev4', image: 'nginx:latest', domain: 'prev4.example.com' })
      const res = await request('POST', '/apps/prev4/previews', { label: 'pr-4' })
      expect(res.status).toBe(400)
      expect((res.body as { error: string }).error).toContain('tag')
    })

    it('sets TTL on preview', async () => {
      await request('POST', '/apps', { name: 'prev6', image: 'nginx:latest', domain: 'prev6.example.com' })
      await request('POST', '/apps/prev6/previews', { label: 'pr-6', tag: 'pr-6', ttlHours: 24 })
      const preview = state.getApp('prev6')?.previews['pr-6']
      expect(preview?.expiresAt).toBeDefined()
      const expiresAt = new Date(preview!.expiresAt).getTime()
      const expectedMin = Date.now() + 23 * 60 * 60 * 1000
      expect(expiresAt).toBeGreaterThan(expectedMin)
    })
  })

  describe('GET /apps/:name/previews', () => {
    it('lists previews for an app', async () => {
      await request('POST', '/apps', { name: 'pls', image: 'nginx:latest', domain: 'pls.example.com' })
      await request('POST', '/apps/pls/previews', { label: 'pr-1', tag: 'pr-1' })
      await request('POST', '/apps/pls/previews', { label: 'pr-2', tag: 'pr-2' })

      const res = await request('GET', '/apps/pls/previews')
      expect(res.status).toBe(200)
      const previews = res.body as Array<{ label: string; domain: string }>
      expect(previews).toHaveLength(2)
      expect(previews.map((p) => p.label).sort()).toEqual(['pr-1', 'pr-2'])
    })

    it('returns empty array when no previews', async () => {
      await request('POST', '/apps', { name: 'pls2', image: 'nginx:latest', domain: 'pls2.example.com' })
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
      await request('POST', '/apps', { name: 'pdel', image: 'nginx:latest', domain: 'pdel.example.com' })
      await request('POST', '/apps/pdel/previews', { label: 'pr-1', tag: 'pr-1' })

      const res = await request('DELETE', '/apps/pdel/previews/pr-1')
      expect(res.status).toBe(200)
      expect(state.getApp('pdel')?.previews['pr-1']).toBeUndefined()
    })

    it('returns 404 for unknown preview', async () => {
      await request('POST', '/apps', { name: 'pdel2', image: 'nginx:latest', domain: 'pdel2.example.com' })
      const res = await request('DELETE', '/apps/pdel2/previews/nope')
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /apps/:name/previews', () => {
    it('removes all previews for an app', async () => {
      await request('POST', '/apps', { name: 'pdelall', image: 'nginx:latest', domain: 'pdelall.example.com' })
      await request('POST', '/apps/pdelall/previews', { label: 'pr-1', tag: 'pr-1' })
      await request('POST', '/apps/pdelall/previews', { label: 'pr-2', tag: 'pr-2' })

      const res = await request('DELETE', '/apps/pdelall/previews')
      expect(res.status).toBe(200)
      expect((res.body as { message: string }).message).toContain('2')
      expect(state.getApp('pdelall')?.previews).toEqual({})
    })

    it('deleting parent also removes previews', async () => {
      await request('POST', '/apps', { name: 'pparent', image: 'nginx:latest', domain: 'pparent.example.com' })
      await request('POST', '/apps/pparent/previews', { label: 'pr-1', tag: 'pr-1' })

      await request('DELETE', '/apps/pparent')
      expect(state.getApp('pparent')).toBeUndefined()
    })
  })

  describe('GET /apps does not include previews', () => {
    it('previews do not appear as separate apps', async () => {
      await request('POST', '/apps', { name: 'pvis', image: 'nginx:latest', domain: 'pvis.example.com' })
      await request('POST', '/apps/pvis/previews', { label: 'pr-1', tag: 'pr-1' })

      const res = await request('GET', '/apps')
      expect(res.status).toBe(200)
      const apps = res.body as Array<{ name: string }>
      expect(apps).toHaveLength(1)
      expect(apps[0].name).toBe('pvis')
    })
  })

  describe('404 for unknown routes', () => {
    it('returns 404', async () => {
      const res = await request('GET', '/nonexistent')
      expect(res.status).toBe(404)
    })
  })
})
