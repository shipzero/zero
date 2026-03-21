import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpDir = path.join(os.tmpdir(), `zero-test-compose-${process.pid}`)
process.env.COMPOSE_DIR = tmpDir

// Mock state to avoid file conflicts
import { vi } from 'vitest'
vi.mock('./state.ts', () => ({
  getRegistryAuths: vi.fn().mockReturnValue({})
}))

const { composeDir, writeComposeFiles, removeComposeDir, substituteImageTags } = await import('./compose.ts')

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

    it('replaces tags matching the repo prefix', () => {
      const result = substituteImageTags(composeFile, 'ghcr.io/org/project', 'pr-42')
      expect(result).toContain('ghcr.io/org/project/backend:pr-42')
      expect(result).toContain('ghcr.io/org/project/frontend:pr-42')
    })

    it('does not touch third-party images', () => {
      const result = substituteImageTags(composeFile, 'ghcr.io/org/project', 'pr-42')
      expect(result).toContain('postgres:16-alpine')
    })

    it('handles different tag formats', () => {
      const content = '    image: ghcr.io/org/project/api:v1.2.3'
      const result = substituteImageTags(content, 'ghcr.io/org/project', 'latest')
      expect(result).toContain('ghcr.io/org/project/api:latest')
    })

    it('returns content unchanged when no images match', () => {
      const result = substituteImageTags(composeFile, 'ghcr.io/other/repo', 'pr-42')
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
})
