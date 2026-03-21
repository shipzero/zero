import fs from 'node:fs'
import path from 'node:path'
import { logError } from './ui.ts'

export interface Config {
  host: string
  token: string
  ssh: string
}

const CONFIG_DIR = path.join(process.cwd(), '.zero')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    logError('not linked — run: zero login user@server')
    process.exit(1)
  }

  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
  return JSON.parse(raw) as Config
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')
}
