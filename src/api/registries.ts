import { getRegistryAuths, setRegistryAuth, removeRegistryAuth } from '../state.ts'
import type { MessageResponse } from '../types.ts'
import { route, json, readBody, parseJSON } from './router.ts'

route('GET', '/registries', async (_req, res) => {
  const auths = getRegistryAuths()
  const servers = Object.keys(auths)
  json(res, 200, servers)
})

route('POST', '/registries', async (req, res) => {
  const body = parseJSON<{ server?: string; username?: string; password?: string }>((await readBody(req)).toString())
  if (!body?.server || !body.username || !body.password) {
    json(res, 400, { error: '--user and --password required' })
    return
  }
  setRegistryAuth(body.server, { username: body.username, password: body.password })
  json<MessageResponse>(res, 200, { message: `Registry ${body.server} saved` })
})

route('DELETE', '/registries/:server', async (_req, res, { server }) => {
  if (!removeRegistryAuth(server)) {
    json(res, 404, { error: `No credentials for ${server}` })
    return
  }
  json<MessageResponse>(res, 200, { message: `Registry ${server} removed` })
})
