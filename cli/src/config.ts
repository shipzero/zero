import fs from 'node:fs'
import path from 'node:path'
import { logError } from './ui.ts'

export interface Config {
  host: string
  token: string
  ssh: string
}

function configPath(): string {
  return path.join(process.cwd(), '.zero', 'config.json')
}

export function loadConfig(): Config {
  const filePath = configPath()
  if (!fs.existsSync(filePath)) {
    logError('Not linked — run: zero login user@server')
    process.exit(1)
  }

  const raw = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(raw) as Config
}

export function saveConfig(config: Config): void {
  const filePath = configPath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n')
}
