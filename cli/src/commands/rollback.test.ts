import { describe, it, expect, beforeEach, vi } from 'vitest'

process.env.NO_COLOR = '1'

const mockClient = {
  get: vi.fn(),
  post: vi.fn()
}

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
    confirm: vi.fn().mockResolvedValue(true),
    spinner: () => ({ stop: vi.fn() })
  }
})

const { rollback } = await import('./rollback.ts')

describe('rollback command', () => {
  beforeEach(() => vi.clearAllMocks())

  it('checks app exists and posts rollback with --force', async () => {
    mockClient.get.mockResolvedValue({ status: 200, data: { name: 'myapp' } })
    mockClient.post.mockResolvedValue({
      status: 200,
      data: { image: 'nginx:v1', containerId: 'abc123' }
    })

    await rollback(['myapp'], { force: true })

    expect(mockClient.get).toHaveBeenCalledWith('/apps/myapp')
    expect(mockClient.post).toHaveBeenCalledWith('/apps/myapp/rollback')
  })

  it('fetches rollback target without --force', async () => {
    mockClient.get.mockResolvedValue({
      status: 200,
      data: { image: 'nginx:v1', deployedAt: '2026-01-01T00:00:00Z' }
    })
    mockClient.post.mockResolvedValue({
      status: 200,
      data: { image: 'nginx:v1', containerId: 'abc123' }
    })

    await rollback(['myapp'], {})

    expect(mockClient.get).toHaveBeenCalledWith('/apps/myapp/rollback-target')
    expect(mockClient.post).toHaveBeenCalledWith('/apps/myapp/rollback')
  })
})
