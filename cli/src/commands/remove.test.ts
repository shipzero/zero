import { describe, it, expect, beforeEach, vi } from 'vitest'

process.env.NO_COLOR = '1'

const mockClient = {
  get: vi.fn(),
  del: vi.fn()
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

const { remove } = await import('./remove.ts')

describe('remove command', () => {
  beforeEach(() => vi.clearAllMocks())

  it('calls GET then DELETE with --force', async () => {
    mockClient.get.mockResolvedValue({ status: 200, data: { name: 'myapp' } })
    mockClient.del.mockResolvedValue({ status: 200, data: { message: 'removed' } })

    await remove(['myapp'], { force: true })

    expect(mockClient.get).toHaveBeenCalledWith('/apps/myapp')
    expect(mockClient.del).toHaveBeenCalledWith('/apps/myapp')
  })

  it('encodes app name in URL', async () => {
    mockClient.get.mockResolvedValue({ status: 200, data: { name: 'my app' } })
    mockClient.del.mockResolvedValue({ status: 200, data: { message: 'removed' } })

    await remove(['my app'], { force: true })

    expect(mockClient.get).toHaveBeenCalledWith('/apps/my%20app')
    expect(mockClient.del).toHaveBeenCalledWith('/apps/my%20app')
  })
})
