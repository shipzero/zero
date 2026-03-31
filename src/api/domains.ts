import { obtainCert } from '../certs.ts'
import { getFreePort } from '../docker.ts'
import { removePortRoute, removeProxyRoute, routeApp, updateProxyRoute } from '../proxy.ts'
import {
  addDomain,
  clearHostPort,
  getCurrentDeployment,
  getPreviewsForApp,
  removeDomain,
  updateHostPort
} from '../state.ts'
import { isTLSEnabled } from '../url.ts'
import { getErrorMessage, json, parseJSON, readBody, requireApp, route } from './router.ts'

route('GET', '/apps/:name/domains', async (_req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  json(res, 200, { domains: app.domains })
})

route('POST', '/apps/:name/domains', async (req, res, { name }) => {
  const app = requireApp(name, res)
  if (!app) return

  const body = parseJSON<{ domain?: string }>((await readBody(req)).toString())
  if (!body?.domain) {
    json(res, 400, { error: 'Domain required' })
    return
  }

  try {
    addDomain(name, body.domain)
  } catch (err) {
    json(res, 400, { error: getErrorMessage(err) })
    return
  }

  const deployment = getCurrentDeployment(app)
  if (deployment) {
    updateProxyRoute(body.domain, deployment.port)
  }

  if (isTLSEnabled()) {
    obtainCert(body.domain).catch((err) => {
      console.error(`[domains] Failed to obtain cert for ${body.domain}:`, err)
    })
  }

  let removedHostPort: number | undefined
  if (app.isAutoHostPort && app.hostPort) {
    removedHostPort = app.hostPort
    removePortRoute(app.hostPort)
    clearHostPort(name)
    console.log(`[domains] Removed auto-assigned host port :${removedHostPort} for ${name}`)
  }

  json(res, 200, {
    domains: app.domains,
    added: body.domain,
    hostPort: app.hostPort,
    removedHostPort
  })
})

route('DELETE', '/apps/:name/domains/:domain', async (_req, res, { name, domain }) => {
  const app = requireApp(name, res)
  if (!app) return

  if (!app.domains.includes(domain)) {
    json(res, 404, { error: `Domain "${domain}" not found on app "${name}"` })
    return
  }

  const isLastDomain = app.domains.length === 1
  const hasPreviews = getPreviewsForApp(name).length > 0
  if (isLastDomain && hasPreviews) {
    json(res, 400, { error: 'Cannot remove the last domain while previews exist' })
    return
  }

  removeDomain(name, domain)
  removeProxyRoute(domain)

  if (app.domains.length === 0 && !app.hostPort) {
    const deployment = getCurrentDeployment(app)
    if (deployment) {
      const port = await getFreePort()
      updateHostPort(name, port, true)
      routeApp(app, deployment.port)
      console.log(`[domains] Auto-assigned host port :${port} for ${name}`)
    }
  }

  json(res, 200, { domains: app.domains, removed: domain, hostPort: app.hostPort })
})
