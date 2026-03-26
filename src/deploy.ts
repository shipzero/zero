import { EventEmitter } from 'node:events'
import { parseDuration } from './duration.ts'
import {
  getApp,
  addDeployment,
  findRollbackTarget,
  isComposeApp,
  getPreview,
  setPreview,
  updateInternalPort,
  updateHostPort,
  AppConfig
} from './state.ts'
import type { Preview } from './state.ts'
import {
  pullImage,
  inspectImage,
  runContainer,
  removeContainer,
  tailLogs,
  waitForHealthy,
  getFreePort
} from './docker.ts'
import {
  writeComposeFiles,
  composePull,
  composeUp,
  composeDown,
  composeDir,
  removeComposeDir,
  substituteImageTags,
  extractImageTag
} from './compose.ts'
import { routeApp, updateProxyRoute } from './proxy.ts'
import { buildDomainUrl, buildAppUrl } from './url.ts'
import { getErrorMessage } from './errors.ts'

const DEFAULT_PORT = 3000
const MAX_LOG_LINES = 500

export interface DeployResult {
  success: boolean
  image: string
  port: number
  containerId: string
  url?: string
  error?: string
}

interface ContainerDeployOptions {
  imageWithTag: string
  containerName: string
  internalPort?: number
  env: Record<string, string>
  healthPath?: string
  healthTimeout?: string
  command?: string[]
  volumes?: string[]
  appName: string
  label?: string
}

interface ContainerDeployResult {
  containerId: string
  port: number
  digest?: string
}

interface ComposeDeployContext {
  app: AppConfig
  projectName: string
  appName: string
  tag?: string
  label?: string
}

/** Emits `log:<appName>` events with the formatted log line as payload. */
export const deployEvents = new EventEmitter()

const deployLogs = new Map<string, string[]>()

function log(appName: string, line: string, label?: string) {
  const prefix = label ? `${appName}/${label}` : appName
  const formatted = `${new Date().toISOString()} ${line}`
  const lines = deployLogs.get(prefix) ?? []
  lines.push(formatted)
  if (lines.length > MAX_LOG_LINES) lines.shift()
  deployLogs.set(prefix, lines)
  deployEvents.emit(`log:${appName}`, formatted)
  console.log(`[${prefix}] ${line}`)
}

export function getDeployLogs(appName: string): string[] {
  return deployLogs.get(appName) ?? []
}

export function clearDeployLogs(appName: string, label?: string): void {
  const key = label ? `${appName}/${label}` : appName
  deployLogs.delete(key)
}

const locks = new Set<string>()

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(key)) {
    throw new Error(`Deploy already in progress for "${key}"`)
  }
  locks.add(key)
  return fn().finally(() => locks.delete(key))
}

async function deployContainer(opts: ContainerDeployOptions): Promise<ContainerDeployResult> {
  const { appName, label } = opts

  log(appName, `Deploying ${opts.imageWithTag}`, label)

  await pullImage(opts.imageWithTag, (line) => log(appName, line, label))
  log(appName, 'Pulling image done', label)

  const inspection = await inspectImage(opts.imageWithTag)

  if (!opts.internalPort) {
    const detected = inspection.exposedPorts[0]
    if (detected) {
      opts.internalPort = detected
      log(appName, `Detected port: ${detected}`, label)
    } else {
      opts.internalPort = DEFAULT_PORT
      log(appName, `Using default port: ${DEFAULT_PORT}`, label)
    }
    updateInternalPort(opts.appName, opts.internalPort)
  }

  const port = await getFreePort()
  const containerId = await runContainer({
    image: opts.imageWithTag,
    appName: opts.containerName,
    internalPort: opts.internalPort!,
    hostPort: port,
    env: opts.env,
    command: opts.command,
    volumes: opts.volumes
  })
  log(appName, 'Starting container done', label)

  try {
    await waitForHealthy(
      port,
      opts.healthPath,
      opts.healthTimeout ? parseDuration(opts.healthTimeout) : undefined,
      containerId
    )
    log(appName, 'Health check passed', label)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error'
    const healthPath = opts.healthPath ?? '/'
    log(appName, `Health check failed — ${reason}`, label)
    log(appName, `Make sure your app listens on port ${opts.internalPort} and responds to GET ${healthPath}`, label)
    try {
      const lines = await tailLogs(containerId)
      if (lines.length > 0) {
        log(appName, 'Container logs:', label)
        for (const line of lines) log(appName, `  ${line}`, label)
      }
    } catch {
      /* container may already be gone */
    }
    log(appName, 'Run `zero logs --server` to see full server logs', label)
    await removeContainer(containerId)
    throw new Error('Health check failed')
  }

  return { containerId, port, digest: inspection.digest }
}

async function deploySingleContainer(appName: string, imageWithTag: string): Promise<DeployResult> {
  const app = getApp(appName)!

  const { containerId, port, digest } = await deployContainer({
    imageWithTag,
    containerName: appName,
    internalPort: app.internalPort,
    env: app.env,
    healthPath: app.healthPath,
    healthTimeout: app.healthTimeout,
    command: app.command,
    volumes: app.volumes,
    appName
  })

  if (app.domains.length === 0 && !app.hostPort) {
    const externalPort = await getFreePort()
    updateHostPort(appName, externalPort, true)
    app.hostPort = externalPort
  }

  routeApp(app, port)

  const deployment = { image: imageWithTag, digest, containerId, port, deployedAt: new Date().toISOString() }
  const evicted = addDeployment(appName, deployment)

  const oldContainerIds = [
    ...evicted.map((d) => d.containerId),
    ...app.deployments.filter((d) => d.containerId !== containerId).map((d) => d.containerId)
  ]

  for (const oldContainerId of oldContainerIds) {
    removeContainer(oldContainerId).catch((err) =>
      log(appName, `Warning: cleanup ${oldContainerId.slice(0, 12)} failed: ${err}`)
    )
  }

  const url = buildAppUrl(app.domains[0], app.hostPort)
  if (url) log(appName, `🚀 Your app is live: ${url}`)
  return { success: true, image: imageWithTag, port, containerId, url }
}

function resolveComposeTag(app: AppConfig, tag?: string): string {
  if (tag) return tag
  if (app.trackTag) return app.trackTag
  if (app.imagePrefix && app.composeFile) {
    return extractImageTag(app.composeFile, app.imagePrefix) ?? ''
  }
  return ''
}

function resolveComposeContent(app: AppConfig, tag: string): string {
  if (tag && app.imagePrefix) {
    return substituteImageTags(app.composeFile!, app.imagePrefix, tag)
  }
  return app.composeFile!
}

async function runComposeDeploy(ctx: ComposeDeployContext): Promise<{ port: number; deployTag: string }> {
  const { app, projectName, appName, tag, label } = ctx
  const deployTag = resolveComposeTag(app, tag)
  log(appName, `Deploying compose${tag ? ` (tag: ${tag})` : ''}`, label)

  const composeContent = resolveComposeContent(app, deployTag)

  const containerPort = await getFreePort()
  const projectDir = writeComposeFiles(
    projectName,
    composeContent,
    app.entryService!,
    containerPort,
    app.internalPort!,
    app.env
  )

  try {
    await composePull(projectDir, (line) => log(appName, line, label))
  } catch (err) {
    throw new Error(`Pull failed: ${getErrorMessage(err)}`)
  }
  log(appName, 'Pulling images done', label)

  try {
    await composeUp(projectDir, (line) => log(appName, line, label))
  } catch (err) {
    throw new Error(`Compose up failed: ${getErrorMessage(err)}`)
  }
  log(appName, 'Starting services done', label)

  try {
    await waitForHealthy(
      containerPort,
      app.healthPath,
      app.healthTimeout ? parseDuration(app.healthTimeout) : undefined
    )
    log(appName, 'Health check passed', label)
  } catch {
    const healthPath = app.healthPath ?? '/'
    log(appName, `Health check failed — entry service did not respond on port ${app.internalPort}`, label)
    log(
      appName,
      `Make sure service "${app.entryService}" listens on port ${app.internalPort} and responds to GET ${healthPath}`,
      label
    )
    try {
      await composeDown(projectDir)
    } catch {
      /* best effort */
    }
    log(appName, 'Run `zero logs --server` to see full server logs', label)
    if (projectName !== app.name) removeComposeDir(projectName)
    throw new Error('Health check failed')
  }

  return { port: containerPort, deployTag }
}

async function deployCompose(appName: string, tag?: string): Promise<DeployResult> {
  const app = getApp(appName)!

  const { port, deployTag } = await runComposeDeploy({
    app,
    projectName: appName,
    appName,
    tag
  })

  if (app.domains.length === 0 && !app.hostPort) {
    const externalPort = await getFreePort()
    updateHostPort(appName, externalPort, true)
    app.hostPort = externalPort
  }

  routeApp(app, port)

  const deployment = {
    image: deployTag,
    containerId: 'compose',
    port,
    deployedAt: new Date().toISOString()
  }
  addDeployment(appName, deployment)

  const url = buildAppUrl(app.domains[0], app.hostPort)
  if (url) log(appName, `🚀 Your app is live: ${url}`)
  return { success: true, image: deployTag, port, containerId: 'compose', url }
}

export async function deploy(appName: string, imageWithTag?: string): Promise<DeployResult> {
  const app = getApp(appName)
  if (!app) throw new Error(`App "${appName}" not registered`)

  return withLock(appName, async () => {
    deployLogs.delete(appName)

    if (isComposeApp(app)) {
      return deployCompose(appName, imageWithTag)
    } else if (!imageWithTag) {
      throw new Error('Image is required for single-container deploys')
    } else {
      return deploySingleContainer(appName, imageWithTag)
    }
  }).catch((err) => ({
    success: false,
    image: imageWithTag ?? '',
    port: 0,
    containerId: '',
    error: getErrorMessage(err)
  }))
}

export async function deployPreview(
  appName: string,
  label: string,
  tag: string,
  domain: string,
  expiresAt: string
): Promise<Preview> {
  const app = getApp(appName)
  if (!app) throw new Error(`App "${appName}" not registered`)

  return withLock(`${appName}--preview--${label}`, async () => {
    const imageWithTag = `${app.image}:${tag}`

    const existing = getPreview(appName, label)
    if (existing) {
      log(appName, `Removing old container ${existing.containerId.slice(0, 12)}`, label)
      await removeContainer(existing.containerId)
    }

    const { containerId, port, digest } = await deployContainer({
      imageWithTag,
      containerName: `${appName}-preview-${label}`,
      internalPort: app.internalPort,
      env: app.env,
      healthPath: app.healthPath,
      healthTimeout: app.healthTimeout,
      command: app.command,
      volumes: app.volumes,
      appName,
      label
    })

    updateProxyRoute(domain, port)

    const preview: Preview = {
      label,
      domain,
      image: imageWithTag,
      digest,
      containerId,
      port,
      deployedAt: new Date().toISOString(),
      expiresAt
    }
    setPreview(appName, label, preview)

    log(appName, `Preview is live: ${buildDomainUrl(domain)}`, label)
    return preview
  })
}

export async function deployComposePreview(
  appName: string,
  label: string,
  domain: string,
  expiresAt: string,
  tag?: string
): Promise<Preview> {
  const app = getApp(appName)
  if (!app) throw new Error(`App "${appName}" not registered`)

  return withLock(`${appName}--preview--${label}`, async () => {
    const previewProjectName = `${appName}-preview-${label}`

    const existing = getPreview(appName, label)
    if (existing) {
      log(appName, 'Removing old compose preview', label)
      try {
        await composeDown(composeDir(previewProjectName))
      } catch {
        /* may not exist yet */
      }
      removeComposeDir(previewProjectName)
    }

    const { port, deployTag } = await runComposeDeploy({
      app,
      projectName: previewProjectName,
      appName,
      tag,
      label
    })

    updateProxyRoute(domain, port)

    const preview: Preview = {
      label,
      domain,
      image: deployTag,
      containerId: previewProjectName,
      port,
      deployedAt: new Date().toISOString(),
      expiresAt,
      isCompose: true
    }
    setPreview(appName, label, preview)

    log(appName, `Preview is live: ${buildDomainUrl(domain)}`, label)
    return preview
  })
}

/** Rollback = redeploy the most recent image that differs from the current one. */
export async function rollback(appName: string): Promise<DeployResult> {
  const app = getApp(appName)
  if (!app) throw new Error(`App "${appName}" not registered`)

  const target = findRollbackTarget(appName)
  const rollbackRef = target.digest ? `${app.image}@${target.digest}` : target.image
  return deploy(appName, rollbackRef)
}
