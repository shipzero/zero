import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockGetAllExpiredPreviews = vi.fn().mockReturnValue([])
const mockRemovePreview = vi.fn()
const mockRemoveContainer = vi.fn().mockResolvedValue(undefined)
const mockComposeDown = vi.fn().mockResolvedValue(undefined)
const mockComposeDir = vi.fn().mockReturnValue('/tmp/compose/project')
const mockRemoveComposeDir = vi.fn()
const mockRemoveProxyRoute = vi.fn()
const mockClearDeployLogs = vi.fn()

vi.mock('./state.ts', () => ({
  getAllExpiredPreviews: (...args: unknown[]) => mockGetAllExpiredPreviews(...args),
  removePreview: (...args: unknown[]) => mockRemovePreview(...args)
}))

vi.mock('./docker.ts', () => ({
  removeContainer: (...args: unknown[]) => mockRemoveContainer(...args)
}))

vi.mock('./compose.ts', () => ({
  composeDown: (...args: unknown[]) => mockComposeDown(...args),
  composeDir: (...args: unknown[]) => mockComposeDir(...args),
  removeComposeDir: (...args: unknown[]) => mockRemoveComposeDir(...args)
}))

vi.mock('./proxy.ts', () => ({
  removeProxyRoute: (...args: unknown[]) => mockRemoveProxyRoute(...args)
}))

vi.mock('./deploy.ts', () => ({
  clearDeployLogs: (...args: unknown[]) => mockClearDeployLogs(...args)
}))

const { destroyPreview, cleanupExpiredPreviews, startPreviewCleanupInterval } = await import('./preview.ts')

describe('destroyPreview', () => {
  beforeEach(() => vi.clearAllMocks())

  it('removes a single-container preview', async () => {
    const preview = {
      label: 'pr-1',
      domain: 'pr-1.app.com',
      image: 'nginx:pr-1',
      containerId: 'abc123',
      port: 3001,
      deployedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-08T00:00:00Z'
    }

    await destroyPreview('myapp', preview)

    expect(mockRemoveProxyRoute).toHaveBeenCalledWith('pr-1.app.com')
    expect(mockRemoveContainer).toHaveBeenCalledWith('abc123')
    expect(mockRemovePreview).toHaveBeenCalledWith('myapp', 'pr-1')
    expect(mockClearDeployLogs).toHaveBeenCalledWith('myapp', 'preview/pr-1')
    expect(mockComposeDown).not.toHaveBeenCalled()
  })

  it('removes a compose preview', async () => {
    const preview = {
      label: 'pr-2',
      domain: 'pr-2.app.com',
      image: 'nginx:pr-2',
      containerId: 'stack-project',
      port: 3002,
      deployedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-08T00:00:00Z',
      isCompose: true
    }

    await destroyPreview('myapp', preview)

    expect(mockRemoveProxyRoute).toHaveBeenCalledWith('pr-2.app.com')
    expect(mockComposeDown).toHaveBeenCalledWith('/tmp/compose/project', true)
    expect(mockRemoveComposeDir).toHaveBeenCalledWith('stack-project')
    expect(mockRemoveContainer).not.toHaveBeenCalled()
    expect(mockRemovePreview).toHaveBeenCalledWith('myapp', 'pr-2')
  })

  it('continues when composeDown fails', async () => {
    mockComposeDown.mockRejectedValueOnce(new Error('Project not found'))
    const preview = {
      label: 'pr-3',
      domain: 'pr-3.app.com',
      image: 'nginx:pr-3',
      containerId: 'gone-project',
      port: 3003,
      deployedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-08T00:00:00Z',
      isCompose: true
    }

    await destroyPreview('myapp', preview)

    expect(mockRemoveComposeDir).toHaveBeenCalledWith('gone-project')
    expect(mockRemovePreview).toHaveBeenCalledWith('myapp', 'pr-3')
  })
})

describe('cleanupExpiredPreviews', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns 0 when no previews are expired', async () => {
    mockGetAllExpiredPreviews.mockReturnValue([])
    const count = await cleanupExpiredPreviews()
    expect(count).toBe(0)
  })

  it('destroys all expired previews and returns count', async () => {
    mockGetAllExpiredPreviews.mockReturnValue([
      {
        appName: 'app1',
        label: 'pr-1',
        preview: {
          label: 'pr-1',
          domain: 'pr-1.app1.com',
          image: 'img:pr-1',
          containerId: 'c1',
          port: 3001,
          deployedAt: '2026-01-01T00:00:00Z',
          expiresAt: '2026-01-02T00:00:00Z'
        }
      },
      {
        appName: 'app2',
        label: 'pr-2',
        preview: {
          label: 'pr-2',
          domain: 'pr-2.app2.com',
          image: 'img:pr-2',
          containerId: 'c2',
          port: 3002,
          deployedAt: '2026-01-01T00:00:00Z',
          expiresAt: '2026-01-02T00:00:00Z'
        }
      }
    ])

    const count = await cleanupExpiredPreviews()

    expect(count).toBe(2)
    expect(mockRemoveContainer).toHaveBeenCalledTimes(2)
    expect(mockRemovePreview).toHaveBeenCalledTimes(2)
  })

  it('continues cleanup when one preview fails', async () => {
    mockRemoveContainer.mockRejectedValueOnce(new Error('Container gone'))
    mockGetAllExpiredPreviews.mockReturnValue([
      {
        appName: 'app1',
        label: 'pr-1',
        preview: {
          label: 'pr-1',
          domain: 'pr-1.app1.com',
          image: 'img:pr-1',
          containerId: 'bad',
          port: 3001,
          deployedAt: '2026-01-01T00:00:00Z',
          expiresAt: '2026-01-02T00:00:00Z'
        }
      },
      {
        appName: 'app2',
        label: 'pr-2',
        preview: {
          label: 'pr-2',
          domain: 'pr-2.app2.com',
          image: 'img:pr-2',
          containerId: 'good',
          port: 3002,
          deployedAt: '2026-01-01T00:00:00Z',
          expiresAt: '2026-01-02T00:00:00Z'
        }
      }
    ])

    const count = await cleanupExpiredPreviews()

    expect(count).toBe(2)
    expect(mockRemovePreview).toHaveBeenCalledWith('app2', 'pr-2')
  })
})

describe('startPreviewCleanupInterval', () => {
  it('returns a clearable interval', () => {
    vi.useFakeTimers()
    const interval = startPreviewCleanupInterval()
    expect(interval).toBeDefined()
    clearInterval(interval)
    vi.useRealTimers()
  })
})
