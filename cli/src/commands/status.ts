import { createClient } from '../client.ts'
import { logInfo, logError, spinner } from '../ui.ts'

export async function status(): Promise<void> {
  const client = createClient()

  logInfo(`server: ${client.config.host}`)

  const spin = spinner('connecting...')
  try {
    const { data } = await client.get<{ version: string }>('/version')
    const { data: apps } = await client.get<unknown[]>('/apps')
    spin.stop()

    logInfo(`version: ${'version' in data ? data.version : 'unknown'}`)
    logInfo(`apps: ${Array.isArray(apps) ? apps.length : 0}`)
  } catch {
    spin.stop()
    logError('Server unreachable')
  }
}
