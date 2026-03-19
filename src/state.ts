import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const IS_DEV = process.env.NODE_ENV !== 'production'
const STATE_PATH = process.env.STATE_PATH ?? (IS_DEV ? '.zero/state.json' : '/data/state/state.json')
const MAX_DEPLOYMENTS = 10

export interface Deployment {
  image: string
  containerId: string
  port: number
  deployedAt: string
}

export interface RegistryAuth {
  username: string
  password: string
}

export interface AppConfig {
  name: string
  image: string
  trackTag: string
  domain?: string
  internalPort: number
  hostPort?: number
  webhookSecret: string
  command?: string[]
  volumes?: string[]
  healthPath?: string
  env: Record<string, string>
  deployments: Deployment[]
  composeFile?: string
  entryService?: string
}

export function isComposeApp(app: AppConfig): boolean {
  return !!app.composeFile
}

export interface State {
  apps: Record<string, AppConfig>
  registryAuths: Record<string, RegistryAuth>
}

let _state: State = { apps: {}, registryAuths: {} }

export function loadState(): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })

  if (fs.existsSync(STATE_PATH)) {
    const raw = fs.readFileSync(STATE_PATH, 'utf8')
    _state = JSON.parse(raw) as State
    _state.registryAuths ??= {}
    console.log(`[state] loaded ${Object.keys(_state.apps).length} app(s)`)
  } else {
    saveState()
    console.log('[state] initialized fresh state')
  }
}

export function saveState(): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  const tmpPath = STATE_PATH + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(_state, null, 2), 'utf8')
  fs.renameSync(tmpPath, STATE_PATH)
}

export function getApp(name: string): AppConfig | undefined {
  return _state.apps[name]
}

export function getApps(): AppConfig[] {
  return Object.values(_state.apps)
}

export function findAppBySecret(secret: string): AppConfig | undefined {
  return getApps().find((app) => app.webhookSecret === secret)
}

export function addApp(config: Omit<AppConfig, 'webhookSecret' | 'deployments'>): AppConfig {
  const app: AppConfig = {
    ...config,
    webhookSecret: crypto.randomBytes(24).toString('hex'),
    deployments: []
  }
  _state.apps[config.name] = app
  saveState()
  return app
}

export function resetWebhookSecret(appName: string): string {
  const app = _state.apps[appName]
  if (!app) throw new Error(`app "${appName}" not found`)
  app.webhookSecret = crypto.randomBytes(24).toString('hex')
  saveState()
  return app.webhookSecret
}

export function updateEnv(appName: string, env: Record<string, string>): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`app "${appName}" not found`)
  app.env = { ...app.env, ...env }
  saveState()
}

export function removeEnv(appName: string, keys: string[]): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`app "${appName}" not found`)
  for (const key of keys) {
    delete app.env[key]
  }
  saveState()
}

export function removeApp(appName: string): void {
  delete _state.apps[appName]
  saveState()
}

export function getCurrentDeployment(app: AppConfig): Deployment | undefined {
  return app.deployments[0]
}

export function addDeployment(appName: string, deployment: Deployment): Deployment[] {
  const app = _state.apps[appName]
  if (!app) throw new Error(`app "${appName}" not found`)

  app.deployments.unshift(deployment)

  let evicted: Deployment[] = []
  if (app.deployments.length > MAX_DEPLOYMENTS) {
    evicted = app.deployments.splice(MAX_DEPLOYMENTS)
  }

  saveState()
  return evicted
}

export function getRegistryAuths(): Record<string, RegistryAuth> {
  return _state.registryAuths
}

export function getRegistryAuth(server: string): RegistryAuth | undefined {
  return _state.registryAuths[server]
}

export function setRegistryAuth(server: string, auth: RegistryAuth): void {
  _state.registryAuths[server] = auth
  saveState()
}

export function removeRegistryAuth(server: string): boolean {
  if (!_state.registryAuths[server]) return false
  delete _state.registryAuths[server]
  saveState()
  return true
}

export function findRollbackTarget(appName: string): Deployment {
  const app = _state.apps[appName]
  if (!app) throw new Error(`app "${appName}" not found`)

  const currentImage = app.deployments[0]?.image
  const target = app.deployments.find((deployment) => deployment.image !== currentImage)
  if (!target) {
    throw new Error('no previous deployment with a different image to roll back to')
  }

  return target
}
