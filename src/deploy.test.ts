import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpDir = path.join(os.tmpdir(), `zero-test-deploy-${process.pid}`)
process.env.STATE_PATH = path.join(tmpDir, 'state.json')
process.env.EMAIL = ''

const mockPullImage = vi.fn().mockResolvedValue(undefined)
const mockRunContainer = vi.fn().mockResolvedValue('new-container-id')
const mockRemoveContainer = vi.fn().mockResolvedValue(undefined)
const mockWaitForHealthy = vi.fn().mockResolvedValue(undefined)
const mockGetFreePort = vi.fn().mockResolvedValue(4444)
const mockRouteApp = vi.fn()
const mockWriteComposeFiles = vi.fn().mockReturnValue('/tmp/compose/myapp')
const mockComposePull = vi.fn().mockResolvedValue(undefined)
const mockComposeUp = vi.fn().mockResolvedValue(undefined)

vi.mock('./docker.ts', () => ({
  pullImage: (...args: unknown[]) => mockPullImage(...args),
  runContainer: (...args: unknown[]) => mockRunContainer(...args),
  removeContainer: (...args: unknown[]) => mockRemoveContainer(...args),
  waitForHealthy: (...args: unknown[]) => mockWaitForHealthy(...args),
  getFreePort: (...args: unknown[]) => mockGetFreePort(...args)
}))

vi.mock('./compose.ts', () => ({
  writeComposeFiles: (...args: unknown[]) => mockWriteComposeFiles(...args),
  composePull: (...args: unknown[]) => mockComposePull(...args),
  composeUp: (...args: unknown[]) => mockComposeUp(...args)
}))

vi.mock('./proxy.ts', () => ({
  routeApp: (...args: unknown[]) => mockRouteApp(...args)
}))

const state = await import('./state.ts')
const { deploy, rollback, getDeployLogs, deployEvents } = await import('./deploy.ts')

describe('deploy', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(process.env.STATE_PATH!, JSON.stringify({ apps: {}, registryAuths: {} }))
    state.loadState()
    vi.clearAllMocks()
  })

  describe('deploy() — single container', () => {
    it('runs all four phases and returns success', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, domain: 'web.com', env: {} })

      const result = await deploy('web', 'nginx:latest')

      expect(result.success).toBe(true)
      expect(result.image).toBe('nginx:latest')
      expect(result.containerId).toBe('new-container-id')
      expect(result.port).toBe(4444)
      expect(mockPullImage).toHaveBeenCalledWith('nginx:latest', expect.any(Function))
      expect(mockRunContainer).toHaveBeenCalledWith(expect.objectContaining({
        image: 'nginx:latest',
        appName: 'web',
        internalPort: 80,
        hostPort: 4444
      }))
      expect(mockWaitForHealthy).toHaveBeenCalledWith(4444, undefined, undefined, 'new-container-id')
      expect(mockRouteApp).toHaveBeenCalledWith(expect.objectContaining({ domain: 'web.com' }), 4444)
    })

    it('records deployment in state', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })

      await deploy('web', 'nginx:v1')

      const app = state.getApp('web')!
      expect(app.deployments).toHaveLength(1)
      expect(app.deployments[0].image).toBe('nginx:v1')
      expect(app.deployments[0].containerId).toBe('new-container-id')
    })

    it('calls routeApp with hostPort when no domain', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, hostPort: 7777, env: {} })

      await deploy('web', 'nginx:latest')

      expect(mockRouteApp).toHaveBeenCalledWith(expect.objectContaining({ hostPort: 7777 }), 4444)
    })

    it('calls routeApp even without domain and hostPort', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })

      await deploy('web', 'nginx:latest')

      expect(mockRouteApp).toHaveBeenCalled()
    })

    it('returns failure when pull fails', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      mockPullImage.mockRejectedValueOnce(new Error('registry timeout'))

      const result = await deploy('web', 'nginx:latest')

      expect(result.success).toBe(false)
      expect(result.error).toContain('registry timeout')
      expect(mockRunContainer).not.toHaveBeenCalled()
    })

    it('returns failure when container start fails', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      mockRunContainer.mockRejectedValueOnce(new Error('port conflict'))

      const result = await deploy('web', 'nginx:latest')

      expect(result.success).toBe(false)
      expect(result.error).toContain('port conflict')
    })

    it('removes container and returns failure when health check fails', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      mockWaitForHealthy.mockRejectedValueOnce(new Error('timeout'))

      const result = await deploy('web', 'nginx:latest')

      expect(result.success).toBe(false)
      expect(result.error).toContain('health check failed')
      expect(mockRemoveContainer).toHaveBeenCalledWith('new-container-id')
    })

    it('cleans up old containers after successful deploy', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      state.addDeployment('web', { image: 'nginx:old', containerId: 'old-container', port: 3000, deployedAt: '2024-01-01' })

      await deploy('web', 'nginx:new')

      expect(mockRemoveContainer).toHaveBeenCalledWith('old-container')
    })

    it('throws when app does not exist', async () => {
      await expect(deploy('ghost', 'nginx:latest')).rejects.toThrow('not registered')
    })

    it('returns failure when image is missing for single-container deploy', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })

      const result = await deploy('web')
      expect(result.success).toBe(false)
      expect(result.error).toContain('image is required')
    })
  })

  describe('deploy lock', () => {
    it('prevents concurrent deploys for the same app', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      mockPullImage.mockImplementationOnce(() => new Promise((resolve) => setTimeout(resolve, 50)))

      const first = deploy('web', 'nginx:v1')
      await expect(deploy('web', 'nginx:v2')).rejects.toThrow('already in progress')
      await first
    })

    it('releases lock after failure', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      mockPullImage.mockRejectedValueOnce(new Error('fail'))

      await deploy('web', 'nginx:v1')
      const result = await deploy('web', 'nginx:v2')
      expect(result.success).toBe(true)
    })
  })

  describe('deploy() — compose', () => {
    it('runs compose flow and returns success', async () => {
      state.addApp({
        name: 'stack', image: '', trackTag: '', internalPort: 80, domain: 'stack.com', env: {},
        composeFile: 'version: "3"', entryService: 'web'
      })

      const result = await deploy('stack')

      expect(result.success).toBe(true)
      expect(result.image).toBe('compose')
      expect(result.containerId).toBe('compose')
      expect(mockWriteComposeFiles).toHaveBeenCalled()
      expect(mockComposePull).toHaveBeenCalled()
      expect(mockComposeUp).toHaveBeenCalled()
      expect(mockWaitForHealthy).toHaveBeenCalledWith(4444, undefined)
      expect(mockRouteApp).toHaveBeenCalledWith(expect.objectContaining({ domain: 'stack.com' }), 4444)
    })

    it('returns failure when compose pull fails', async () => {
      state.addApp({
        name: 'stack', image: '', trackTag: '', internalPort: 80, env: {},
        composeFile: 'version: "3"', entryService: 'web'
      })
      mockComposePull.mockRejectedValueOnce(new Error('pull error'))

      const result = await deploy('stack')

      expect(result.success).toBe(false)
      expect(result.error).toContain('pull failed')
    })

    it('returns failure when compose up fails', async () => {
      state.addApp({
        name: 'stack', image: '', trackTag: '', internalPort: 80, env: {},
        composeFile: 'version: "3"', entryService: 'web'
      })
      mockComposeUp.mockRejectedValueOnce(new Error('up error'))

      const result = await deploy('stack')

      expect(result.success).toBe(false)
      expect(result.error).toContain('compose up failed')
    })
  })

  describe('deploy logs', () => {
    it('stores deploy logs per app', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })

      await deploy('web', 'nginx:latest')

      const logs = getDeployLogs('web')
      expect(logs.length).toBeGreaterThan(0)
      expect(logs.some((l) => l.includes('deploy start'))).toBe(true)
      expect(logs.some((l) => l.includes('deploy complete'))).toBe(true)
    })

    it('clears logs at the start of a new deploy', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })

      await deploy('web', 'nginx:v1')
      const firstLogs = getDeployLogs('web').length

      await deploy('web', 'nginx:v2')
      const secondLogs = getDeployLogs('web')

      expect(secondLogs.length).toBe(firstLogs)
      expect(secondLogs.some((l) => l.includes('v2'))).toBe(true)
    })

    it('returns empty array for app with no logs', () => {
      expect(getDeployLogs('unknown')).toEqual([])
    })

    it('emits log events via deployEvents', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })

      const received: string[] = []
      deployEvents.on('log:web', (line: string) => received.push(line))

      await deploy('web', 'nginx:latest')

      expect(received.length).toBeGreaterThan(0)
      expect(received.some((l) => l.includes('deploy start'))).toBe(true)

      deployEvents.removeAllListeners('log:web')
    })
  })

  describe('rollback', () => {
    it('redeploys the previous image', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      state.addDeployment('web', { image: 'nginx:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })
      state.addDeployment('web', { image: 'nginx:v2', containerId: 'c2', port: 3002, deployedAt: '2024-01-02' })

      const result = await rollback('web')

      expect(result.success).toBe(true)
      expect(mockPullImage).toHaveBeenCalledWith('nginx:v1', expect.any(Function))
    })

    it('throws for non-existent app', async () => {
      await expect(rollback('ghost')).rejects.toThrow('not registered')
    })

    it('throws for compose apps', async () => {
      state.addApp({
        name: 'stack', image: '', trackTag: '', internalPort: 80, env: {},
        composeFile: 'version: "3"', entryService: 'web'
      })

      await expect(rollback('stack')).rejects.toThrow('not supported for compose')
    })

    it('throws when no rollback target exists', async () => {
      state.addApp({ name: 'web', image: 'nginx', trackTag: 'latest', internalPort: 80, env: {} })
      state.addDeployment('web', { image: 'nginx:v1', containerId: 'c1', port: 3001, deployedAt: '2024-01-01' })

      await expect(rollback('web')).rejects.toThrow()
    })
  })
})
