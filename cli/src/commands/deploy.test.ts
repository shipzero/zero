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
    spinner: () => ({ stop: vi.fn() }),
    printDnsTable: vi.fn().mockResolvedValue(undefined)
  }
})

function makePostSSE(events: Array<{ event: string; [key: string]: unknown }>) {
  return (_path: string, _body: unknown, onData: (line: string) => void) => {
    for (const event of events) {
      onData(JSON.stringify(event))
    }
    return Promise.resolve()
  }
}

const mockClient = {
  config: { host: 'http://localhost:2020', token: 'test' },
  post: vi.fn(),
  postSSE: vi.fn().mockImplementation(
    makePostSSE([
      { event: 'accepted', appName: 'myapp', isNew: false },
      { event: 'log', message: 'Pulling image done' },
      { event: 'log', message: 'Health check passed' },
      { event: 'complete', success: true, url: 'http://localhost:3000', appName: 'myapp', isNew: false }
    ])
  ),
  streamSSE: vi.fn().mockResolvedValue(undefined)
}

const { formatDeployLog, isImageReference, inferNameFromImage, deploy } = await import('./deploy.ts')

describe('isImageReference', () => {
  it('detects image with registry path', () => {
    expect(isImageReference('ghcr.io/you/myapp:latest')).toBe(true)
  })

  it('detects image with tag only', () => {
    expect(isImageReference('nginx:alpine')).toBe(true)
  })

  it('detects image with path but no tag', () => {
    expect(isImageReference('ghcr.io/you/myapp')).toBe(true)
  })

  it('returns false for plain app name', () => {
    expect(isImageReference('myapp')).toBe(false)
  })
})

describe('inferNameFromImage', () => {
  it('extracts name from registry image', () => {
    expect(inferNameFromImage('ghcr.io/you/myapp:latest')).toBe('myapp')
  })

  it('extracts name from docker hub image', () => {
    expect(inferNameFromImage('nginx:alpine')).toBe('nginx')
  })

  it('extracts name from deep path', () => {
    expect(inferNameFromImage('ghcr.io/org/project/backend:v2')).toBe('backend')
  })

  it('handles image without tag', () => {
    expect(inferNameFromImage('ghcr.io/you/myapp')).toBe('myapp')
  })

  it('handles registry with port', () => {
    expect(inferNameFromImage('localhost:5000/myapp:latest')).toBe('myapp')
  })
})

describe('formatDeployLog', () => {
  it('hides deploying line', () => {
    expect(formatDeployLog('Deploying nginx:latest')).toBeNull()
  })

  it('shows pulling image done as success', () => {
    const result = formatDeployLog('Pulling image done')
    expect(result).toContain('Pulling image')
  })

  it('shows starting container done as success', () => {
    const result = formatDeployLog('Starting container done')
    expect(result).toContain('Starting container')
  })

  it('shows detected port', () => {
    const result = formatDeployLog('Detected port: 8080')
    expect(result).toContain('Detected port: 8080')
  })

  it('shows default port', () => {
    const result = formatDeployLog('Using default port: 3000')
    expect(result).toContain('Using default port: 3000')
  })

  it('shows health check passed', () => {
    const result = formatDeployLog('Health check passed')
    expect(result).toContain('Health check passed')
  })

  it('hides app is live line (shown from complete event instead)', () => {
    expect(formatDeployLog('Your app is live: https://myapp.example.com')).toBeNull()
  })

  it('formats error line', () => {
    const result = formatDeployLog('Health check failed — container did not respond on port 3000')
    expect(result).toContain('Health check failed')
  })

  it('hides docker pull progress', () => {
    expect(formatDeployLog('Pulling fs layer')).toBeNull()
  })
})

describe('deploy command', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sends image to POST /deploy for new app', async () => {
    mockClient.postSSE.mockImplementation(
      makePostSSE([
        { event: 'accepted', appName: 'myapp', isNew: true },
        { event: 'complete', success: true, url: 'http://localhost:3000', appName: 'myapp', isNew: true }
      ])
    )

    await deploy(['ghcr.io/you/myapp:latest'], {})

    expect(mockClient.postSSE).toHaveBeenCalledWith(
      '/deploy',
      expect.objectContaining({ image: 'ghcr.io/you/myapp:latest', name: 'myapp' }),
      expect.any(Function)
    )
  })

  it('sends app name to POST /deploy for existing app', async () => {
    mockClient.postSSE.mockImplementation(
      makePostSSE([
        { event: 'accepted', appName: 'myapp', isNew: false },
        { event: 'complete', success: true, appName: 'myapp', isNew: false }
      ])
    )

    await deploy(['myapp'], {})

    expect(mockClient.postSSE).toHaveBeenCalledWith(
      '/deploy',
      expect.objectContaining({ name: 'myapp' }),
      expect.any(Function)
    )
  })

  it('includes tag when provided', async () => {
    mockClient.postSSE.mockImplementation(
      makePostSSE([
        { event: 'accepted', appName: 'myapp', isNew: false },
        { event: 'complete', success: true, appName: 'myapp', isNew: false }
      ])
    )

    await deploy(['myapp'], { tag: 'v2' })

    expect(mockClient.postSSE).toHaveBeenCalledWith(
      '/deploy',
      expect.objectContaining({ name: 'myapp', tag: 'v2' }),
      expect.any(Function)
    )
  })

  it('uses --name flag over inferred name', async () => {
    mockClient.postSSE.mockImplementation(
      makePostSSE([
        { event: 'accepted', appName: 'web', isNew: true },
        { event: 'complete', success: true, appName: 'web', isNew: true }
      ])
    )

    await deploy(['nginx:latest'], { name: 'web' })

    expect(mockClient.postSSE).toHaveBeenCalledWith(
      '/deploy',
      expect.objectContaining({ name: 'web' }),
      expect.any(Function)
    )
  })

  it('exits with error on deploy failure', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })

    mockClient.postSSE.mockImplementation(
      makePostSSE([
        { event: 'accepted', appName: 'myapp', isNew: false },
        { event: 'complete', success: false, error: 'image not found', appName: 'myapp', isNew: false }
      ])
    )

    await expect(deploy(['myapp'], {})).rejects.toThrow('process.exit')
    expect(mockExit).toHaveBeenCalledWith(1)

    mockExit.mockRestore()
  })
})
