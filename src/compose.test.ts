import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const tmpDir = path.join(os.tmpdir(), `zero-test-compose-${process.pid}`)
process.env.COMPOSE_DIR = tmpDir

// Mock state to avoid file conflicts
import { vi } from 'vitest'

vi.mock('./state.ts', () => ({
  getRegistryAuths: vi.fn().mockReturnValue({})
}))

const mockExecFile = vi.fn()

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args)
}))

const {
  composeDir,
  composeDown,
  hasComposeService,
  writeComposeFiles,
  removeComposeDir,
  substituteImageTags,
  extractImageTag
} = await import('./compose.ts')

function fakeComposeProcess() {
  return {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on(event: string, callback: (code: number) => void) {
      if (event === 'close') queueMicrotask(() => callback(0))
    }
  }
}

describe('compose', () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('composeDir', () => {
    it('returns path under base dir', () => {
      expect(composeDir('myapp')).toBe(path.join(tmpDir, 'myapp'))
    })
  })

  describe('writeComposeFiles', () => {
    it('writes docker-compose.yml and override', () => {
      const composeContent = 'version: "3"\nservices:\n  web:\n    image: nginx'
      const projectDir = writeComposeFiles('testapp', composeContent, 'web', 8080, 80)

      expect(fs.existsSync(path.join(projectDir, 'docker-compose.yml'))).toBe(true)
      expect(fs.existsSync(path.join(projectDir, 'docker-compose.override.yml'))).toBe(true)

      const main = fs.readFileSync(path.join(projectDir, 'docker-compose.yml'), 'utf8')
      expect(main).toBe(composeContent)

      const override = fs.readFileSync(path.join(projectDir, 'docker-compose.override.yml'), 'utf8')
      expect(override).toContain('web:')
      expect(override).toContain('127.0.0.1:8080:80')
    })

    it('always binds to 127.0.0.1', () => {
      writeComposeFiles('internal', 'version: "3"', 'web', 9090, 80)
      const override = fs.readFileSync(path.join(tmpDir, 'internal', 'docker-compose.override.yml'), 'utf8')
      expect(override).toContain('127.0.0.1:9090:80')
      expect(override).not.toContain('0.0.0.0')
    })
  })

  describe('substituteImageTags', () => {
    const composeFile = [
      'services:',
      '  backend:',
      '    image: ghcr.io/org/project/backend:test',
      '  frontend:',
      '    image: ghcr.io/org/project/frontend:test',
      '  db:',
      '    image: postgres:16-alpine'
    ].join('\n')

    it('replaces tags matching the image prefix', () => {
      const result = substituteImageTags(composeFile, 'ghcr.io/org/project', 'pr-21')
      expect(result).toContain('ghcr.io/org/project/backend:pr-21')
      expect(result).toContain('ghcr.io/org/project/frontend:pr-21')
    })

    it('does not touch third-party images', () => {
      const result = substituteImageTags(composeFile, 'ghcr.io/org/project', 'pr-21')
      expect(result).toContain('postgres:16-alpine')
    })

    it('handles different tag formats', () => {
      const content = '    image: ghcr.io/org/project/api:v1.2.3'
      const result = substituteImageTags(content, 'ghcr.io/org/project', 'latest')
      expect(result).toContain('ghcr.io/org/project/api:latest')
    })

    it('returns content unchanged when no images match', () => {
      const result = substituteImageTags(composeFile, 'ghcr.io/other/repo', 'pr-21')
      expect(result).toBe(composeFile)
    })
  })

  describe('removeComposeDir', () => {
    it('removes the project directory', () => {
      writeComposeFiles('removeme', 'version: "3"', 'web', 8080, 80)
      expect(fs.existsSync(path.join(tmpDir, 'removeme'))).toBe(true)

      removeComposeDir('removeme')
      expect(fs.existsSync(path.join(tmpDir, 'removeme'))).toBe(false)
    })

    it('does not throw when directory does not exist', () => {
      expect(() => removeComposeDir('nonexistent')).not.toThrow()
    })
  })

  describe('hasComposeService', () => {
    const content = 'services:\n  web:\n    image: nginx\n  db:\n    image: postgres'

    it('returns true for a defined service', () => {
      expect(hasComposeService(content, 'web')).toBe(true)
      expect(hasComposeService(content, 'db')).toBe(true)
    })

    it('returns false for an unknown service', () => {
      expect(hasComposeService(content, 'api')).toBe(false)
    })
  })

  describe('composeDown', () => {
    beforeEach(() => {
      mockExecFile.mockReset()
      mockExecFile.mockImplementation(() => fakeComposeProcess())
    })

    it('runs docker compose down with --remove-orphans', async () => {
      await composeDown('/tmp/proj')

      expect(mockExecFile).toHaveBeenCalledWith('docker', ['compose', 'down', '--remove-orphans'], expect.anything())
    })

    it('adds -v when removeVolumes is set', async () => {
      await composeDown('/tmp/proj', { removeVolumes: true })

      const args = mockExecFile.mock.calls[0][1] as string[]
      expect(args).toContain('-v')
      expect(args).not.toContain('--rmi')
    })

    it('adds --rmi all when removeImages is set', async () => {
      await composeDown('/tmp/proj', { removeImages: true })

      const args = mockExecFile.mock.calls[0][1] as string[]
      const rmiIndex = args.indexOf('--rmi')
      expect(rmiIndex).toBeGreaterThan(-1)
      expect(args[rmiIndex + 1]).toBe('all')
      expect(args).not.toContain('-v')
    })
  })

  describe('extractImageTag', () => {
    it('extracts tag from first matching image', () => {
      const content = 'services:\n  web:\n    image: ghcr.io/org/app/web:test'
      expect(extractImageTag(content, 'ghcr.io/org/app')).toBe('test')
    })

    it('returns null when no image matches prefix', () => {
      const content = 'services:\n  db:\n    image: postgres:16-alpine'
      expect(extractImageTag(content, 'ghcr.io/org/app')).toBeNull()
    })

    it('extracts from first match when multiple images match', () => {
      const content = [
        'services:',
        '  backend:',
        '    image: ghcr.io/org/app/backend:v2',
        '  frontend:',
        '    image: ghcr.io/org/app/frontend:v3'
      ].join('\n')
      expect(extractImageTag(content, 'ghcr.io/org/app')).toBe('v2')
    })
  })
})
