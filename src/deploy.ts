import { EventEmitter } from 'node:events'
import { getApp, addDeployment, findRollbackTarget, isComposeApp, getPreview, setPreview, AppConfig } from './state.ts'
import type { Preview } from './state.ts'
import {
  pullImage,
  runContainer,
  stopContainer,
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
  substituteImageTags
} from './compose.ts'
import { routeApp, updateProxyRoute } from './proxy.ts'
import { buildDomainUrl } from './url.ts'
import { DOMAIN } from './env.ts'
import { getErrorMessage } from './errors.ts'

function buildUrl(appDomain: string | undefined, port: number): string {
  if (appDomain) return buildDomainUrl(appDomain)
  return DOMAIN ? `http://${DOMAIN}:${port}` : `:${port}`
}

const deployLogs = new Map<string, string[]>()
const MAX_LOG_LINES = 500

/** Emits `log:<appName>` events with the formatted log line as payload. */
export const deployEvents = new EventEmitter()

function log(appName: string, line: string) {
  const formatted = `${new Date().toISOString()} ${line}`
  const lines = deployLogs.get(appName) ?? []
  lines.push(formatted)
  if (lines.length > MAX_LOG_LINES) lines.shift()
  deployLogs.set(appName, lines)
  deployEvents.emit(`log:${appName}`, formatted)
  console.log(`[${appName}] ${line}`)
}

export function getDeployLogs(appName: string): string[] {
  return deployLogs.get(appName) ?? []
}

interface ContainerDeployOptions {
  imageWithTag: string
  containerName: string
  internalPort: number
  env: Record<string, string>
  healthPath?: string
  command?: string[]
  volumes?: string[]
  logKey: string
}

interface ContainerDeployResult {
  containerId: string
  port: number
}

async function deployContainer(opts: ContainerDeployOptions): Promise<ContainerDeployResult> {
  log(opts.logKey, `── deploy start: ${opts.imageWithTag}`)

  log(opts.logKey, 'phase 1/3: pulling image')
  await pullImage(opts.imageWithTag, (status) => log(opts.logKey, status))

  log(opts.logKey, 'phase 2/3: starting container')
  const port = await getFreePort()
  const containerId = await runContainer({
    image: opts.imageWithTag,
    appName: opts.containerName,
    internalPort: opts.internalPort,
    hostPort: port,
    env: opts.env,
    command: opts.command,
    volumes: opts.volumes
  })
  log(opts.logKey, `container ${containerId.slice(0, 12)} on port ${port}`)

  const healthPath = opts.healthPath ?? '/'
  log(opts.logKey, `phase 3/3: waiting for healthy on port ${port} (GET ${healthPath})`)
  try {
    await waitForHealthy(port, opts.healthPath, undefined, containerId)
    log(opts.logKey, 'container is healthy')
  } catch {
    log(opts.logKey, `health check failed — container did not respond at http://127.0.0.1:${port}${healthPath}`)
    log(opts.logKey, `make sure your app listens on port ${opts.internalPort} and responds to GET ${healthPath}`)
    try {
      await stopContainer(containerId)
      log(opts.logKey, 'container logs:')
      const lines = await tailLogs(containerId)
      for (const line of lines) log(opts.logKey, `  ${line}`)
    } catch {
      /* container may already be gone */
    }
    await removeContainer(containerId)
    throw new Error(`health check failed on port ${port}${healthPath}`)
  }

  return { containerId, port }
}

const locks = new Set<string>()

export interface DeployResult {
  success: boolean
  image: string
  port: number
  containerId: string
  url?: string
  error?: string
}

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(key)) {
    throw new Error(`Deploy already in progress for "${key}"`)
  }
  locks.add(key)
  return fn().finally(() => locks.delete(key))
}

export async function deploy(appName: string, imageWithTag?: string): Promise<DeployResult> {
  const app = getApp(appName)
  if (!app) throw new Error(`App "${appName}" not registered`)

  return withLock(appName, async () => {
    deployLogs.delete(appName)

    if (isComposeApp(app)) {
      return deployCompose(appName, imageWithTag)
    } else if (!imageWithTag) {
      throw new Error('image is required for single-container deploys')
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

async function deploySingleContainer(appName: string, imageWithTag: string): Promise<DeployResult> {
  const app = getApp(appName)!

  const { containerId, port } = await deployContainer({
    imageWithTag,
    containerName: appName,
    internalPort: app.internalPort,
    env: app.env,
    healthPath: app.healthPath,
    command: app.command,
    volumes: app.volumes,
    logKey: appName
  })

  routeApp(app, port)

  const deployment = { image: imageWithTag, containerId, port, deployedAt: new Date().toISOString() }
  const evicted = addDeployment(appName, deployment)

  const oldContainerIds = [
    ...evicted.map((d) => d.containerId),
    ...app.deployments.filter((d) => d.containerId !== containerId).map((d) => d.containerId)
  ]

  for (const oldContainerId of oldContainerIds) {
    removeContainer(oldContainerId).catch((err) =>
      log(appName, `warning: cleanup ${oldContainerId.slice(0, 12)} failed: ${err}`)
    )
  }

  const url = buildUrl(app.domain, app.hostPort ?? port)
  log(appName, `deploy complete — ${url}`)
  return { success: true, image: imageWithTag, port, containerId, url }
}

function resolveComposeTag(app: AppConfig, tag?: string): string {
  return tag ?? (app.trackTag || 'compose')
}

function resolveComposeContent(app: AppConfig, tag: string): string {
  if (tag !== 'compose' && app.repo) {
    return substituteImageTags(app.composeFile!, app.repo, tag)
  }
  return app.composeFile!
}

interface ComposeDeployContext {
  app: AppConfig
  projectName: string
  logKey: string
  tag?: string
}

async function runComposeDeploy(ctx: ComposeDeployContext): Promise<{ port: number; deployTag: string }> {
  const { app, projectName, logKey, tag } = ctx
  const deployTag = resolveComposeTag(app, tag)
  log(logKey, `── deploy start: compose${tag ? ` (tag: ${tag})` : ''}`)

  const composeContent = resolveComposeContent(app, deployTag)

  const containerPort = await getFreePort()
  const projectDir = writeComposeFiles(
    projectName,
    composeContent,
    app.entryService!,
    containerPort,
    app.internalPort,
    app.env
  )

  log(logKey, 'phase 1/3: pulling images')
  try {
    await composePull(projectDir, (line) => log(logKey, line))
  } catch (err) {
    throw new Error(`pull failed: ${getErrorMessage(err)}`)
  }

  log(logKey, 'phase 2/3: starting services')
  try {
    await composeUp(projectDir, (line) => log(logKey, line))
  } catch (err) {
    throw new Error(`compose up failed: ${getErrorMessage(err)}`)
  }

  const healthPath = app.healthPath ?? '/'
  log(logKey, `phase 3/3: waiting for healthy on port ${containerPort} (GET ${healthPath})`)
  try {
    await waitForHealthy(containerPort, app.healthPath)
    log(logKey, 'entry service is healthy')
  } catch {
    log(logKey, `health check failed — entry service did not respond at http://127.0.0.1:${containerPort}${healthPath}`)
    log(
      logKey,
      `make sure service "${app.entryService}" listens on port ${app.internalPort} and responds to GET ${healthPath}`
    )
    try {
      await composeDown(projectDir)
    } catch {
      /* best effort */
    }
    if (projectName !== app.name) removeComposeDir(projectName)
    throw new Error(`health check failed on port ${containerPort}${healthPath}`)
  }

  return { port: containerPort, deployTag }
}

async function deployCompose(appName: string, tag?: string): Promise<DeployResult> {
  const app = getApp(appName)!

  const { port, deployTag } = await runComposeDeploy({
    app,
    projectName: appName,
    logKey: appName,
    tag
  })

  routeApp(app, port)

  const deployment = {
    image: deployTag,
    containerId: 'compose',
    port,
    deployedAt: new Date().toISOString()
  }
  addDeployment(appName, deployment)

  const url = buildUrl(app.domain, app.hostPort ?? port)
  log(appName, `deploy complete — ${url}`)
  return { success: true, image: deployTag, port, containerId: 'compose', url }
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
    const logKey = `${appName}/preview/${label}`

    const existing = getPreview(appName, label)
    if (existing) {
      log(logKey, `removing old container ${existing.containerId.slice(0, 12)}`)
      await removeContainer(existing.containerId)
    }

    const { containerId, port } = await deployContainer({
      imageWithTag,
      containerName: `${appName}-preview-${label}`,
      internalPort: app.internalPort,
      env: app.env,
      healthPath: app.healthPath,
      command: app.command,
      volumes: app.volumes,
      logKey
    })

    updateProxyRoute(domain, port)

    const preview: Preview = {
      label,
      domain,
      image: imageWithTag,
      containerId,
      port,
      deployedAt: new Date().toISOString(),
      expiresAt
    }
    setPreview(appName, label, preview)

    log(logKey, `deploy complete — ${buildDomainUrl(domain)}`)
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
    const logKey = `${appName}/preview/${label}`
    const previewProjectName = `${appName}-preview-${label}`

    const existing = getPreview(appName, label)
    if (existing) {
      log(logKey, 'removing old compose preview')
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
      logKey,
      tag
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

    log(logKey, `deploy complete — ${buildDomainUrl(domain)}`)
    return preview
  })
}

/** Rollback = redeploy the most recent image that differs from the current one. */
export async function rollback(appName: string): Promise<DeployResult> {
  const app = getApp(appName)
  if (!app) throw new Error(`App "${appName}" not registered`)

  const target = findRollbackTarget(appName)
  return deploy(appName, target.image)
}
