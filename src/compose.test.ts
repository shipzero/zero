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

const { composeDir, writeComposeFiles, removeComposeDir } = await import('./compose.ts')

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
