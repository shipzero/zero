import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Set STATE_PATH before importing state module
const tmpDir = path.join(os.tmpdir(), `zero-test-state-${process.pid}`)
process.env.STATE_PATH = path.join(tmpDir, 'state.json')

const state = await import('./state.ts')

describe('state', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
    // Reset state by loading fresh
    fs.writeFileSync(process.env.STATE_PATH!, JSON.stringify({ apps: {}, registryAuths: {} }))
    state.loadState()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('loadState / saveState', () => {
    it('initializes fresh state when no file exists', () => {
      fs.rmSync(process.env.STATE_PATH!, { force: true })
      state.loadState()
      expect(state.getApps()).toEqual([])
    })

    it('loads existing state from disk', () => {
      const existing = {
        apps: {
          myapp: {
            name: 'myapp',
            image: 'nginx',
            trackTag: 'latest',
            domain: 'myapp.com',
            internalPort: 80,
            webhookSecret: 'abc123',
            env: {},
            deployments: []
          }
        },
        registryAuths: {}
      }
      fs.writeFileSync(process.env.STATE_PATH!, JSON.stringify(existing))
      state.loadState()
      expect(state.getApp('myapp')).toBeDefined()
      expect(state.getApp('myapp')!.image).toBe('nginx')
    })

    it('initializes registryAuths if missing from old state file', () => {
      const oldState = { apps: {} }
      fs.writeFileSync(process.env.STATE_PATH!, JSON.stringify(oldState))
      state.loadState()
      expect(state.getRegistryAuths()).toEqual({})
    })

    it('backfills previews for apps missing the field', () => {
      const oldState = {
        apps: {
          legacy: {
            name: 'legacy',
            image: 'nginx',
            trackTag: 'latest',
            internalPort: 80,
            webhookSecret: 'sec',
            env: {},
            deployments: []
          }
        },
        registryAuths: {}
      }
      fs.writeFileSync(process.env.STATE_PATH!, JSON.stringify(oldState))
      state.loadState()
      expect(state.getApp('legacy')!.previews).toEqual({})
    })
  })

  describe('addApp / getApp / getApps', () => {
    it('adds an app with generated webhook secret and empty deployments', () => {
      const app = state.addApp({
        name: 'web',
        image: 'nginx',
        trackTag: 'latest',
        internalPort: 80,
        env: {}
      })

      expect(app.name).toBe('web')
      expect(app.webhookSecret).toHaveLength(48) // 24 bytes hex
      expect(app.deployments).toEqual([])
      expect(state.getApp('web')).toEqual(app)
    })

    it('persists to disk after addApp', () => {
      state.addApp({ name: 'persisted', image: 'alpine', trackTag: 'latest', internalPort: 80, env: {} })
      const raw = JSON.parse(fs.readFileSync(process.env.STATE_PATH!, 'utf8'))
      expect(raw.apps.persisted).toBeDefined()
    })

    it('returns undefined for non-existent app', () => {
      expect(state.getApp('nope')).toBeUndefined()
    })

    it('returns all apps as array', () => {
      state.addApp({ name: 'a', image: 'a', trackTag: 'latest', internalPort: 80, env: {} })
      state.addApp({ name: 'b', image: 'b', trackTag: 'latest', internalPort: 80, env: {} })
      expect(state.getApps()).toHaveLength(2)
    })
  })

  describe('updateEnv', () => {
    it('merges new env vars', () => {
      state.addApp({ name: 'app', image: 'img', trackTag: 'latest', internalPort: 80, env: { A: '1' } })
      state.updateEnv('app', { B: '2' })
      expect(state.getApp('app')!.env).toEqual({ A: '1', B: '2' })
    })

    it('overwrites existing env vars', () => {
      state.addApp({ name: 'app', image: 'img', trackTag: 'latest', internalPort: 80, env: { A: '1' } })
      state.updateEnv('app', { A: '99' })
      expect(state.getApp('app')!.env).toEqual({ A: '99' })
    })

    it('throws for non-existent app', () => {
      expect(() => state.updateEnv('nope', { X: '1' })).toThrow('app "nope" not found')
    })
  })

  describe('removeApp', () => {
    it('removes an app', () => {
      state.addApp({ name: 'doomed', image: 'img', trackTag: 'latest', internalPort: 80, env: {} })
      state.removeApp('doomed')
      expect(state.getApp('doomed')).toBeUndefined()
    })
  })

  describe('deployments', () => {
    it('adds deployment to front of list', () => {
      state.addApp({ name: 'app', image: 'img', trackTag: 'latest', internalPort: 80, env: {} })
      state.addDeployment('app', { image: 'img:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })
      state.addDeployment('app', { image: 'img:v2', containerId: 'c2', port: 3002, deployedAt: '2024-01-02' })

      const app = state.getApp('app')!
      expect(app.deployments[0].image).toBe('img:v2')
      expect(app.deployments[1].image).toBe('img:v1')
    })

    it('getCurrentDeployment returns the first deployment', () => {
      state.addApp({ name: 'app', image: 'img', trackTag: 'latest', internalPort: 80, env: {} })
      state.addDeployment('app', { image: 'img:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })
      expect(state.getCurrentDeployment(state.getApp('app')!)!.image).toBe('img:v1')
    })

    it('getCurrentDeployment returns undefined when no deployments', () => {
      state.addApp({ name: 'app', image: 'img', trackTag: 'latest', internalPort: 80, env: {} })
      expect(state.getCurrentDeployment(state.getApp('app')!)).toBeUndefined()
    })

    it('evicts old deployments beyond MAX_DEPLOYMENTS (10)', () => {
      state.addApp({ name: 'app', image: 'img', trackTag: 'latest', internalPort: 80, env: {} })

      for (let i = 0; i < 10; i++) {
        state.addDeployment('app', {
          image: `img:v${i}`,
          containerId: `c${i}`,
          port: 3000 + i,
          deployedAt: `2024-01-${i}`
        })
      }
      expect(state.getApp('app')!.deployments).toHaveLength(10)

      const evicted = state.addDeployment('app', {
        image: 'img:v10',
        containerId: 'c10',
        port: 3010,
        deployedAt: '2024-01-10'
      })
      expect(state.getApp('app')!.deployments).toHaveLength(10)
      expect(evicted).toHaveLength(1)
      expect(evicted[0].containerId).toBe('c0')
    })

    it('throws for non-existent app', () => {
      expect(() => state.addDeployment('nope', { image: 'x', containerId: 'x', port: 1, deployedAt: '' })).toThrow()
    })
  })

  describe('findRollbackTarget', () => {
    it('finds a deployment with a different image than current', () => {
      state.addApp({ name: 'app', image: 'img', trackTag: 'latest', internalPort: 80, env: {} })
      state.addDeployment('app', { image: 'img:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })
      state.addDeployment('app', { image: 'img:v2', containerId: 'c2', port: 3002, deployedAt: '2024-01-02' })

      const target = state.findRollbackTarget('app')
      expect(target.image).toBe('img:v1')
    })

    it('throws when no different image exists', () => {
      state.addApp({ name: 'app', image: 'img', trackTag: 'latest', internalPort: 80, env: {} })
      state.addDeployment('app', { image: 'img:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })
      expect(() => state.findRollbackTarget('app')).toThrow('no previous deployment')
    })

    it('throws for non-existent app', () => {
      expect(() => state.findRollbackTarget('nope')).toThrow()
    })
  })

  describe('findAppBySecret', () => {
    it('finds app by webhook secret', () => {
      const app = state.addApp({ name: 'app', image: 'img', trackTag: 'latest', internalPort: 80, env: {} })
      expect(state.findAppBySecret(app.webhookSecret)!.name).toBe('app')
    })

    it('returns undefined for unknown secret', () => {
      expect(state.findAppBySecret('unknown')).toBeUndefined()
    })
  })

  describe('isComposeApp', () => {
    it('returns true when composeFile is set', () => {
      const app = state.addApp({
        name: 'app',
        image: '',
        trackTag: '',
        internalPort: 80,
        env: {},
        composeFile: 'version: "3"',
        entryService: 'web'
      })
      expect(state.isComposeApp(app)).toBe(true)
    })

    it('returns false for regular app', () => {
      const app = state.addApp({ name: 'app', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      expect(state.isComposeApp(app)).toBe(false)
    })
  })

  describe('registry auth', () => {
    it('set and get registry auth', () => {
      state.setRegistryAuth('ghcr.io', { username: 'user', password: 'pass' })
      expect(state.getRegistryAuth('ghcr.io')).toEqual({ username: 'user', password: 'pass' })
    })

    it('returns undefined for unknown registry', () => {
      expect(state.getRegistryAuth('unknown.io')).toBeUndefined()
    })

    it('lists all registries', () => {
      state.setRegistryAuth('ghcr.io', { username: 'u', password: 'p' })
      state.setRegistryAuth('docker.io', { username: 'u2', password: 'p2' })
      const auths = state.getRegistryAuths()
      expect(Object.keys(auths)).toHaveLength(2)
    })

    it('removes registry auth', () => {
      state.setRegistryAuth('ghcr.io', { username: 'u', password: 'p' })
      expect(state.removeRegistryAuth('ghcr.io')).toBe(true)
      expect(state.getRegistryAuth('ghcr.io')).toBeUndefined()
    })

    it('returns false when removing non-existent registry', () => {
      expect(state.removeRegistryAuth('nope')).toBe(false)
    })
  })

  describe('preview helpers', () => {
    it('buildPreviewDomain builds correct subdomain', () => {
      expect(state.buildPreviewDomain('myapp.example.com', 'pr-42')).toBe('preview-pr-42.myapp.example.com')
    })

    it('setPreview and getPreview work correctly', () => {
      state.addApp({ name: 'app', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      const preview = {
        label: 'pr-1',
        domain: 'pr-1.app.example.com',
        image: 'nginx:pr-1',
        containerId: 'c1',
        port: 4000,
        deployedAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-08T00:00:00Z'
      }
      state.setPreview('app', 'pr-1', preview)
      expect(state.getPreview('app', 'pr-1')).toEqual(preview)
    })

    it('getPreview returns undefined for non-existent preview', () => {
      state.addApp({ name: 'app', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      expect(state.getPreview('app', 'nope')).toBeUndefined()
    })

    it('removePreview removes a preview', () => {
      state.addApp({ name: 'app', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      state.setPreview('app', 'pr-1', {
        label: 'pr-1',
        domain: 'pr-1.app.com',
        image: 'nginx:pr-1',
        containerId: 'c1',
        port: 4000,
        deployedAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-08T00:00:00Z'
      })
      state.removePreview('app', 'pr-1')
      expect(state.getPreview('app', 'pr-1')).toBeUndefined()
    })

    it('getPreviewsForApp returns all previews', () => {
      state.addApp({ name: 'app', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      state.setPreview('app', 'pr-1', {
        label: 'pr-1',
        domain: 'pr-1.app.com',
        image: 'nginx:pr-1',
        containerId: 'c1',
        port: 4000,
        deployedAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-08T00:00:00Z'
      })
      state.setPreview('app', 'pr-2', {
        label: 'pr-2',
        domain: 'pr-2.app.com',
        image: 'nginx:pr-2',
        containerId: 'c2',
        port: 4001,
        deployedAt: '2024-01-01T00:00:00Z',
        expiresAt: '2024-01-08T00:00:00Z'
      })
      const previews = state.getPreviewsForApp('app')
      expect(previews).toHaveLength(2)
      expect(previews.map((p) => p.label).sort()).toEqual(['pr-1', 'pr-2'])
    })

    it('getAllExpiredPreviews returns only expired previews', () => {
      const past = new Date(Date.now() - 1000).toISOString()
      const future = new Date(Date.now() + 86_400_000).toISOString()

      state.addApp({ name: 'app', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      state.setPreview('app', 'old', {
        label: 'old',
        domain: 'old.app.com',
        image: 'nginx:old',
        containerId: 'c1',
        port: 4000,
        deployedAt: '2024-01-01T00:00:00Z',
        expiresAt: past
      })
      state.setPreview('app', 'new', {
        label: 'new',
        domain: 'new.app.com',
        image: 'nginx:new',
        containerId: 'c2',
        port: 4001,
        deployedAt: '2024-01-01T00:00:00Z',
        expiresAt: future
      })

      const expired = state.getAllExpiredPreviews()
      expect(expired).toHaveLength(1)
      expect(expired[0].label).toBe('old')
      expect(expired[0].appName).toBe('app')
    })

    it('addApp initializes previews as empty object', () => {
      const app = state.addApp({ name: 'app', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      expect(app.previews).toEqual({})
    })
  })
})
