import fs from 'node:fs'
import crypto from 'node:crypto'
import { STATE_PATH } from './env.ts'
import { ensureParentDir, writeFileAtomic } from './fs.ts'
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

export interface Preview {
  label: string
  domain: string
  image: string
  containerId: string
  port: number
  deployedAt: string
  expiresAt: string
  isCompose?: boolean
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
  healthTimeout?: string
  env: Record<string, string>
  deployments: Deployment[]
  composeFile?: string
  entryService?: string
  repo?: string
  previews: Record<string, Preview>
}

export function isComposeApp(app: AppConfig): boolean {
  return !!app.composeFile
}

export function buildPreviewDomain(parentDomain: string, label: string): string {
  return `${label}.${parentDomain}`
}

export function getPreview(appName: string, label: string): Preview | undefined {
  return _state.apps[appName]?.previews[label]
}

export function setPreview(appName: string, label: string, preview: Preview): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`app "${appName}" not found`)
  app.previews[label] = preview
  saveState()
}

export function removePreview(appName: string, label: string): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`app "${appName}" not found`)
  delete app.previews[label]
  saveState()
}

export function getPreviewsForApp(appName: string): Preview[] {
  const app = _state.apps[appName]
  if (!app) return []
  return Object.values(app.previews)
}

export function getAllExpiredPreviews(): Array<{ appName: string; label: string; preview: Preview }> {
  const now = new Date().toISOString()
  const expired: Array<{ appName: string; label: string; preview: Preview }> = []
  for (const app of Object.values(_state.apps)) {
    for (const [label, preview] of Object.entries(app.previews)) {
      if (preview.expiresAt < now) {
        expired.push({ appName: app.name, label, preview })
      }
    }
  }
  return expired
}

export interface State {
  apps: Record<string, AppConfig>
  registryAuths: Record<string, RegistryAuth>
}

let _state: State = { apps: {}, registryAuths: {} }

export function loadState(): void {
  ensureParentDir(STATE_PATH)

  if (fs.existsSync(STATE_PATH)) {
    const raw = fs.readFileSync(STATE_PATH, 'utf8')
    _state = JSON.parse(raw) as State
    _state.registryAuths ??= {}
    for (const app of Object.values(_state.apps)) {
      app.previews ??= {}
    }
    console.log(`[state] loaded ${Object.keys(_state.apps).length} app(s)`)
  } else {
    saveState()
    console.log('[state] initialized fresh state')
  }
}

export function saveState(): void {
  ensureParentDir(STATE_PATH)
  writeFileAtomic(STATE_PATH, JSON.stringify(_state, null, 2))
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

export function addApp(config: Omit<AppConfig, 'webhookSecret' | 'deployments' | 'previews'>): AppConfig {
  const app: AppConfig = {
    ...config,
    webhookSecret: crypto.randomBytes(24).toString('hex'),
    deployments: [],
    previews: {}
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
