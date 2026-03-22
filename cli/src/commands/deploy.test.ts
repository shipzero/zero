import { describe, it, expect, beforeEach, vi } from 'vitest'

process.env.NO_COLOR = '1'

vi.mock('../client.ts', () => ({
  createClient: () => mockClient,
  unwrap: (res: { status: number; data: unknown }, logError: (msg: string) => void) => {
    if (res.status >= 400) {
      logError(`HTTP ${res.status}`)
      throw new Error(`HTTP ${res.status}`)
    }
    return res.data
  }
}))

vi.mock('../ui.ts', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>
  return {
    ...original,
    spinner: () => ({ stop: vi.fn() })
  }
})

const mockClient = {
  post: vi.fn(),
  streamSSE: vi.fn().mockResolvedValue(undefined)
}

const { formatDeployLog, deploy } = await import('./deploy.ts')

describe('formatDeployLog', () => {
  it('formats deploy start line', () => {
    const result = formatDeployLog('2026-01-01T00:00:00.000Z ── deploy start: nginx:latest')
    expect(result).toContain('deploying')
    expect(result).toContain('nginx:latest')
  })

  it('formats phase line', () => {
    const result = formatDeployLog('phase 1/4: pulling image')
    expect(result).toContain('[1/4]')
    expect(result).toContain('pulling image')
  })

  it('formats healthy line', () => {
    const result = formatDeployLog('container is healthy')
    expect(result).toContain('container is healthy')
  })

  it('returns null for deploy complete', () => {
    expect(formatDeployLog('deploy complete')).toBeNull()
  })

  it('formats error line', () => {
    const result = formatDeployLog('deploy failed: image not found')
    expect(result).toContain('deploy failed: image not found')
  })

  it('formats unknown lines as dim', () => {
    const result = formatDeployLog('some log output')
    expect(result).toContain('some log output')
  })
})

describe('deploy command', () => {
  beforeEach(() => vi.clearAllMocks())

  it('posts to deploy endpoint', async () => {
    mockClient.post.mockResolvedValue({
      status: 200,
      data: { success: true, image: 'nginx:latest' }
    })

    await deploy(['myapp'], {})

    expect(mockClient.post).toHaveBeenCalledWith('/apps/myapp/deploy', undefined)
  })

  it('includes tag when provided', async () => {
    mockClient.post.mockResolvedValue({
      status: 200,
      data: { success: true, image: 'nginx:v2' }
    })

    await deploy(['myapp'], { tag: 'v2' })

    expect(mockClient.post).toHaveBeenCalledWith('/apps/myapp/deploy', { tag: 'v2' })
  })

  it('streams deploy logs via SSE', async () => {
    mockClient.post.mockResolvedValue({
      status: 200,
      data: { success: true, image: 'nginx:latest' }
    })

    await deploy(['myapp'], {})

    expect(mockClient.streamSSE).toHaveBeenCalledWith(
      '/apps/myapp/deploy-logs',
      expect.any(Function),
      expect.any(Object)
    )
  })

  it('exits with error on deploy failure', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })

    mockClient.post.mockResolvedValue({
      status: 200,
      data: { success: false, error: 'image not found' }
    })

    await expect(deploy(['myapp'], {})).rejects.toThrow('process.exit')
    expect(mockExit).toHaveBeenCalledWith(1)

    mockExit.mockRestore()
  })
})
