import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'

process.env.NO_COLOR = '1'

vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof fs
  return { ...original, default: { ...original, existsSync: vi.fn(), readFileSync: vi.fn() } }
})

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
    spinner: () => ({
      stop: (msg?: string) => {
        if (msg) console.log(msg)
      }
    }),
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

const { createDeployLogger, stripTimestamp, parseEnvFlag, isImageReference, inferNameFromImage, deploy } =
  await import('./deploy.ts')

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

describe('parseEnvFlag', () => {
  it('parses single KEY=val pair', () => {
    expect(parseEnvFlag('DB_URL=postgres://localhost/db')).toEqual({ DB_URL: 'postgres://localhost/db' })
  })

  it('parses multiple comma-separated pairs', () => {
    expect(parseEnvFlag('KEY1=val1,KEY2=val2')).toEqual({ KEY1: 'val1', KEY2: 'val2' })
  })

  it('handles values with equals signs', () => {
    expect(parseEnvFlag('TOKEN=abc=def')).toEqual({ TOKEN: 'abc=def' })
  })

  it('exits on invalid format', () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })
    expect(() => parseEnvFlag('INVALID')).toThrow('process.exit')
    expect(mockExit).toHaveBeenCalledWith(1)
    mockExit.mockRestore()
  })
})

describe('stripTimestamp', () => {
  it('removes ISO timestamp prefix', () => {
    expect(stripTimestamp('2024-01-01T12:00:00.000Z Pulling image done')).toBe('Pulling image done')
  })

  it('passes through lines without timestamp', () => {
    expect(stripTimestamp('Pulling image done')).toBe('Pulling image done')
  })
})

describe('createDeployLogger', () => {
  let output: string[]
  let logger: ReturnType<typeof createDeployLogger>

  beforeEach(() => {
    output = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => output.push(args.join(' ')))
    logger = createDeployLogger()
  })

  it('outputs step completion on done messages', () => {
    logger.handleLog('Deploying nginx:latest')
    logger.handleLog('Pulling image done')
    expect(output.some((l) => l.includes('Pulling image'))).toBe(true)
  })

  it('outputs detected port', () => {
    logger.handleLog('Detected port: 8080')
    expect(output.some((l) => l.includes('Detected port: 8080'))).toBe(true)
  })

  it('outputs health check passed', () => {
    logger.handleLog('Deploying nginx:latest')
    logger.handleLog('Pulling image done')
    logger.handleLog('Starting container done')
    logger.handleLog('Health check passed')
    expect(output.some((l) => l.includes('Health check passed'))).toBe(true)
  })

  it('outputs error lines', () => {
    logger.handleLog('Health check failed — container did not respond on port 3000')
    expect(output.some((l) => l.includes('Health check failed'))).toBe(true)
  })

  it('does not output app is live line', () => {
    logger.handleLog('Your app is live: https://myapp.example.com')
    expect(output).toHaveLength(0)
  })

  it('does not output docker pull progress', () => {
    logger.handleLog('Pulling fs layer')
    expect(output).toHaveLength(0)
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

  it('includes env when provided', async () => {
    mockClient.postSSE.mockImplementation(
      makePostSSE([
        { event: 'accepted', appName: 'myapp', isNew: true },
        { event: 'complete', success: true, appName: 'myapp', isNew: true }
      ])
    )

    await deploy(['ghcr.io/you/myapp:latest'], { env: 'DB_URL=postgres://localhost/db,NODE_ENV=production' })

    expect(mockClient.postSSE).toHaveBeenCalledWith(
      '/deploy',
      expect.objectContaining({
        env: { DB_URL: 'postgres://localhost/db', NODE_ENV: 'production' }
      }),
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

  it('sends compose file to POST /deploy', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('services:\n  web:\n    image: nginx')

    mockClient.postSSE.mockImplementation(
      makePostSSE([
        { event: 'accepted', appName: 'mystack', isNew: true },
        { event: 'complete', success: true, url: 'http://localhost:3000', appName: 'mystack', isNew: true }
      ])
    )

    await deploy([], { compose: 'docker-compose.yml', service: 'web', name: 'mystack' })

    expect(mockClient.postSSE).toHaveBeenCalledWith(
      '/deploy',
      expect.objectContaining({
        composeFile: 'services:\n  web:\n    image: nginx',
        name: 'mystack',
        entryService: 'web'
      }),
      expect.any(Function)
    )
  })

  it('exits with error when --compose is used without --name', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('services:\n  web:\n    image: nginx')

    await expect(deploy([], { compose: 'docker-compose.yml', service: 'web' })).rejects.toThrow('process.exit')
    expect(mockExit).toHaveBeenCalledWith(1)

    mockExit.mockRestore()
  })

  it('exits with error when --compose file does not exist', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit')
    })

    vi.mocked(fs.existsSync).mockReturnValue(false)

    await expect(deploy([], { compose: 'missing.yml', service: 'web', name: 'mystack' })).rejects.toThrow(
      'process.exit'
    )
    expect(mockExit).toHaveBeenCalledWith(1)

    mockExit.mockRestore()
  })
})
