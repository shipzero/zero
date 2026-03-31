import { docker, streamLogs, streamStats } from '../docker.ts'
import { IS_DEV, JWT_SECRET } from '../env.ts'
import { signJwt } from '../jwt.ts'
import type { MessageResponse, VersionResponse } from '../types.ts'
import { VERSION } from '../version.ts'
import {
  getErrorMessage,
  isZeroContainerRunning,
  json,
  parseJSON,
  parseTail,
  pipeSSE,
  readBody,
  route,
  sendSSE,
  startSSE,
  ZERO_CONTAINER
} from './router.ts'

const JWT_TTL_SECONDS = 24 * 60 * 60

route('GET', '/version', async (_req, res) => {
  json<VersionResponse>(res, 200, { version: VERSION })
})

route('POST', '/auth/token', async (_req, res) => {
  const now = Math.floor(Date.now() / 1000)
  const token = signJwt(JWT_SECRET, { exp: now + JWT_TTL_SECONDS })
  json(res, 200, { token })
})

route('POST', '/upgrade', async (req, res) => {
  if (IS_DEV) {
    json(res, 400, { error: 'Upgrade is only available in production mode' })
    return
  }

  const raw = (await readBody(req)).toString()
  const body = raw ? parseJSON<{ tag?: string }>(raw) : null
  const tag = body?.tag

  if (tag && !/^[a-zA-Z0-9._-]+$/.test(tag)) {
    json(res, 400, { error: 'Invalid --tag' })
    return
  }

  console.log(`[upgrade] Pulling ${tag ?? 'latest'} image and restarting...`)

  const COMPOSE_FILE = '/opt/zero/docker-compose.yml'
  const effectiveTag = tag ?? 'latest'
  const swapTag = `sed -i 's|image: ghcr.io/shipzero/zero:.*|image: ghcr.io/shipzero/zero:${effectiveTag}|' ${COMPOSE_FILE} && `
  const pullCmd = `${swapTag}docker compose -f ${COMPOSE_FILE} pull && docker compose -f ${COMPOSE_FILE} up -d`

  try {
    const upgrader = await docker.createContainer({
      Image: 'docker:cli',
      Cmd: ['sh', '-c', `sleep 2 && ${pullCmd}`],
      HostConfig: {
        Binds: ['/var/run/docker.sock:/var/run/docker.sock', '/opt/zero:/opt/zero'],
        AutoRemove: true
      }
    })
    await upgrader.start()
    json<MessageResponse>(res, 200, { message: `Upgrade started (${tag ?? 'latest'}) — zero will restart` })
  } catch (err) {
    console.error('[upgrade] Upgrade failed:', err)
    json(res, 500, { error: getErrorMessage(err) })
  }
})

route('GET', '/logs', async (req, res) => {
  if (!(await isZeroContainerRunning())) {
    json(res, 400, { error: 'Server logs are only available in production (zero container not found)' })
    return
  }

  const tail = parseTail(req.url)

  startSSE(res)
  await pipeSSE(res, streamLogs(ZERO_CONTAINER, tail))
  sendSSE(res, '[log stream ended]')
})

route('GET', '/metrics', async (_req, res) => {
  if (!(await isZeroContainerRunning())) {
    json(res, 400, { error: 'Server metrics are only available in production (zero container not found)' })
    return
  }

  startSSE(res)
  await pipeSSE(res, streamStats(ZERO_CONTAINER))
})
