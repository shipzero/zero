import fs from 'node:fs'
import crypto from 'node:crypto'
import { STATE_PATH } from './env.ts'
import { ensureParentDir, writeFileAtomic } from './fs.ts'

const MAX_DEPLOYMENTS = 10

export interface Deployment {
  image: string
  digest?: string
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
  domains: string[]
  internalPort?: number
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
  imagePrefix?: string
  previews: Record<string, Preview>
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
      app.domains ??= []
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

export function addApp(
  config: Omit<AppConfig, 'webhookSecret' | 'deployments' | 'previews' | 'domains'> & { domains?: string[] }
): AppConfig {
  const app: AppConfig = {
    ...config,
    domains: config.domains ?? [],
    webhookSecret: crypto.randomBytes(24).toString('hex'),
    deployments: [],
    previews: {}
  }
  _state.apps[config.name] = app
  saveState()
  return app
}

export function removeApp(appName: string): void {
  delete _state.apps[appName]
  saveState()
}

export function isComposeApp(app: AppConfig): boolean {
  return !!app.composeFile
}

export function resetWebhookSecret(appName: string): string {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)
  app.webhookSecret = crypto.randomBytes(24).toString('hex')
  saveState()
  return app.webhookSecret
}

export function updateInternalPort(appName: string, port: number): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)
  app.internalPort = port
  saveState()
}

export function updateEnv(appName: string, env: Record<string, string>): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)
  app.env = { ...app.env, ...env }
  saveState()
}

export function removeEnv(appName: string, keys: string[]): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)
  for (const key of keys) {
    delete app.env[key]
  }
  saveState()
}

export function getCurrentDeployment(app: AppConfig): Deployment | undefined {
  return app.deployments[0]
}

export function addDeployment(appName: string, deployment: Deployment): Deployment[] {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)

  app.deployments.unshift(deployment)

  let evicted: Deployment[] = []
  if (app.deployments.length > MAX_DEPLOYMENTS) {
    evicted = app.deployments.splice(MAX_DEPLOYMENTS)
  }

  saveState()
  return evicted
}

export function findRollbackTarget(appName: string): Deployment {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)

  const current = app.deployments[0]
  const currentId = current?.digest ?? current?.image
  const target = app.deployments.find((d) => (d.digest ?? d.image) !== currentId)
  if (!target) {
    throw new Error('No previous deployment with a different image to roll back to')
  }

  return target
}

export function addDomain(appName: string, domain: string): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)

  const conflict = getApps().find((a) => a.domains.includes(domain))
  if (conflict) {
    throw new Error(`Domain "${domain}" is already used by app "${conflict.name}"`)
  }

  app.domains.push(domain)
  saveState()
}

export function removeDomain(appName: string, domain: string): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)

  const idx = app.domains.indexOf(domain)
  if (idx === -1) {
    throw new Error(`Domain "${domain}" not found on app "${appName}"`)
  }

  app.domains.splice(idx, 1)
  saveState()
}

export function buildPreviewDomain(parentDomain: string, label: string): string {
  return `preview-${label}.${parentDomain}`
}

export function getPreview(appName: string, label: string): Preview | undefined {
  return _state.apps[appName]?.previews[label]
}

export function setPreview(appName: string, label: string, preview: Preview): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)
  app.previews[label] = preview
  saveState()
}

export function removePreview(appName: string, label: string): void {
  const app = _state.apps[appName]
  if (!app) throw new Error(`App "${appName}" not found`)
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
