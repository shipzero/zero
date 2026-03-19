import { EventEmitter } from 'node:events'
import { getApp, addDeployment, findRollbackTarget, isComposeApp } from './state.ts'
import { pullImage, runContainer, stopContainer, removeContainer, tailLogs, waitForHealthy, getFreePort } from './docker.ts'
import { writeComposeFiles, composePull, composeUp } from './compose.ts'
import { routeApp } from './proxy.ts'
import { isTLSEnabled } from './certs.ts'

const DOMAIN = process.env.DOMAIN ?? ''

function buildUrl(appDomain: string | undefined, port: number): string {
  if (appDomain) {
    return `${isTLSEnabled() ? 'https' : 'http'}://${appDomain}`
  }
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

const locks = new Set<string>()

export interface DeployResult {
  success: boolean
  image: string
  port: number
  containerId: string
  error?: string
}

export async function deploy(appName: string, imageWithTag?: string): Promise<DeployResult> {
  const app = getApp(appName)
  if (!app) throw new Error(`App "${appName}" not registered`)

  if (locks.has(appName)) {
    throw new Error(`Deploy already in progress for "${appName}"`)
  }
  locks.add(appName)

  let result: DeployResult
  try {
    deployLogs.delete(appName)

    if (isComposeApp(app)) {
      result = await deployCompose(appName)
    } else if (!imageWithTag) {
      throw new Error('image is required for single-container deploys')
    } else {
      result = await deploySingleContainer(appName, imageWithTag)
    }
  } catch (err) {
    result = { success: false, image: imageWithTag ?? '', port: 0, containerId: '', error: err instanceof Error ? err.message : String(err) }
  } finally {
    locks.delete(appName)
  }
  return result!
}

async function deploySingleContainer(appName: string, imageWithTag: string): Promise<DeployResult> {
  const app = getApp(appName)!

  log(appName, `── deploy start: ${imageWithTag}`)

  log(appName, 'phase 1/4: pulling image')
  try {
    await pullImage(imageWithTag, (status) => log(appName, status))
  } catch (err) {
    const message = `pull failed: ${err instanceof Error ? err.message : err}`
    log(appName, message)
    return { success: false, image: imageWithTag, port: 0, containerId: '', error: message }
  }

  log(appName, 'phase 2/4: starting new container')
  const containerPort = await getFreePort()
  let containerId: string
  try {
    containerId = await runContainer({
      image: imageWithTag,
      appName,
      internalPort: app.internalPort,
      hostPort: containerPort,
      env: app.env,
      command: app.command,
      volumes: app.volumes
    })
  } catch (err) {
    const message = `container start failed: ${err instanceof Error ? err.message : err}`
    log(appName, message)
    return { success: false, image: imageWithTag, port: 0, containerId: '', error: message }
  }
  log(appName, `container ${containerId.slice(0, 12)} on port ${containerPort}`)

  const healthPath = app.healthPath ?? '/'
  log(appName, `phase 3/4: waiting for healthy on port ${containerPort} (GET ${healthPath})`)
  try {
    await waitForHealthy(containerPort, app.healthPath, undefined, containerId)
    log(appName, 'container is healthy')
  } catch (err) {
    log(appName, `health check failed — container did not respond at http://127.0.0.1:${containerPort}${healthPath}`)
    log(appName, `make sure your app listens on port ${app.internalPort} and responds to GET ${healthPath}`)
    try {
      await stopContainer(containerId)
      log(appName, 'container logs:')
      const lines = await tailLogs(containerId)
      for (const line of lines) log(appName, `  ${line}`)
    } catch { /* container may already be gone */ }
    await removeContainer(containerId)
    return { success: false, image: imageWithTag, port: containerPort, containerId, error: `health check failed on port ${containerPort}${healthPath}` }
  }

  log(appName, 'phase 4/4: swapping proxy route')
  routeApp(app, containerPort)

  const deployment = { image: imageWithTag, containerId, port: containerPort, deployedAt: new Date().toISOString() }
  const evicted = addDeployment(appName, deployment)

  const oldContainerIds = [
    ...evicted.map((deployment) => deployment.containerId),
    ...app.deployments
      .filter((deployment) => deployment.containerId !== containerId)
      .map((deployment) => deployment.containerId)
  ]

  for (const oldContainerId of oldContainerIds) {
    removeContainer(oldContainerId).catch((err) =>
      log(appName, `warning: cleanup ${oldContainerId.slice(0, 12)} failed: ${err}`)
    )
  }

  log(appName, `deploy complete — ${buildUrl(app.domain, app.hostPort ?? containerPort)}`)
  return { success: true, image: imageWithTag, port: containerPort, containerId }
}

async function deployCompose(appName: string): Promise<DeployResult> {
  const app = getApp(appName)!

  log(appName, '── deploy start: compose')

  const containerPort = await getFreePort()
  const projectDir = writeComposeFiles(appName, app.composeFile!, app.entryService!, containerPort, app.internalPort)

  log(appName, 'phase 1/3: pulling images')
  try {
    await composePull(projectDir, (line) => log(appName, line))
  } catch (err) {
    const message = `pull failed: ${err instanceof Error ? err.message : err}`
    log(appName, message)
    return { success: false, image: 'compose', port: 0, containerId: '', error: message }
  }

  log(appName, 'phase 2/3: starting services')
  try {
    await composeUp(projectDir, (line) => log(appName, line))
  } catch (err) {
    const message = `compose up failed: ${err instanceof Error ? err.message : err}`
    log(appName, message)
    return { success: false, image: 'compose', port: containerPort, containerId: '', error: message }
  }

  const composeHealthPath = app.healthPath ?? '/'
  log(appName, `phase 3/3: waiting for healthy on port ${containerPort} (GET ${composeHealthPath})`)
  try {
    await waitForHealthy(containerPort, app.healthPath)
    log(appName, 'entry service is healthy')
  } catch {
    log(appName, `health check failed — entry service did not respond at http://127.0.0.1:${containerPort}${composeHealthPath}`)
    log(appName, `make sure service "${app.entryService}" listens on port ${app.internalPort} and responds to GET ${composeHealthPath}`)
    return { success: false, image: 'compose', port: containerPort, containerId: '', error: `health check failed on port ${containerPort}${composeHealthPath}` }
  }

  routeApp(app, containerPort)

  const deployment = { image: 'compose', containerId: 'compose', port: containerPort, deployedAt: new Date().toISOString() }
  addDeployment(appName, deployment)

  log(appName, `deploy complete — ${buildUrl(app.domain, app.hostPort ?? containerPort)}`)
  return { success: true, image: 'compose', port: containerPort, containerId: 'compose' }
}

/** Rollback = redeploy the most recent image that differs from the current one. */
export async function rollback(appName: string): Promise<DeployResult> {
  const app = getApp(appName)
  if (!app) throw new Error(`App "${appName}" not registered`)

  if (isComposeApp(app)) {
    throw new Error('rollback is not supported for compose apps — redeploy with the desired image tags')
  }

  const target = findRollbackTarget(appName)
  return deploy(appName, target.image)
}
