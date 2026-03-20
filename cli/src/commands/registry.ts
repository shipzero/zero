import { createClient, unwrap } from '../client.ts'
import type { MessageResponse } from '../../../src/types.ts'
import { logSuccess, logInfo, logError, dim } from '../ui.ts'

export async function registry(subcommand: string | null, positionals: string[], flags: Record<string, string | true>): Promise<void> {
  switch (subcommand) {
    case 'login':
      return registryLogin(positionals, flags)
    case 'logout':
      return registryLogout(positionals)
    case 'ls':
      return registryLs()
    default:
      logError('usage: zero registry login <server> --user <u> --password <p>')
      logError('       zero registry logout <server>')
      logError('       zero registry ls')
      process.exit(1)
  }
}

async function registryLogin(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const server = positionals[0]
  const username = flags['user'] as string | undefined
  const password = flags['password'] as string | undefined

  if (!server || !username || !password) {
    logError('usage: zero registry login <server> --user <u> --password <p>')
    process.exit(1)
  }

  const client = createClient()
  unwrap(await client.post<MessageResponse>('/registries', { server, username, password }), logError)
  logSuccess(`logged in to ${server}`)
}

async function registryLogout(positionals: string[]): Promise<void> {
  const server = positionals[0]
  if (!server) {
    logError('usage: zero registry logout <server>')
    process.exit(1)
  }

  const client = createClient()
  unwrap(await client.del<MessageResponse>(`/registries/${encodeURIComponent(server)}`), logError)
  logSuccess(`logged out from ${server}`)
}

async function registryLs(): Promise<void> {
  const client = createClient()
  const servers = unwrap(await client.get<string[]>('/registries'), logError)

  if (servers.length === 0) {
    logInfo('no registries configured')
    return
  }

  for (const server of servers) {
    console.log(`  ${dim('•')} ${server}`)
  }
}
