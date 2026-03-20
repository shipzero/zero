import nodeFs from 'node:fs'
import path from 'node:path'

export function ensureDir(dirPath: string): void {
  nodeFs.mkdirSync(dirPath, { recursive: true })
}

export function ensureParentDir(filePath: string): void {
  ensureDir(path.dirname(filePath))
}

export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const tmpPath = `${filePath}.tmp`
  nodeFs.writeFileSync(tmpPath, data)
  nodeFs.renameSync(tmpPath, filePath)
}
