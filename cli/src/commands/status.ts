import { createClient } from '../client.ts'
import { logInfo, logError } from '../ui.ts'

export async function status(): Promise<void> {
  const client = createClient()

  logInfo(`server: ${client.config.host}`)

  try {
    const { data } = await client.get<{ version: string }>('/version')
    logInfo(`version: ${'version' in data ? data.version : 'unknown'}`)

    const { data: apps } = await client.get<unknown[]>('/apps')
    logInfo(`apps: ${Array.isArray(apps) ? apps.length : 0}`)
  } catch {
    logError('server unreachable')
  }
}
