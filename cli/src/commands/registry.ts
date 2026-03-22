import { createClient, unwrap } from '../client.ts'
import type { MessageResponse } from '../../../src/types.ts'
import { logSuccess, logInfo, logError, dim, spinner, printCommandHelp } from '../ui.ts'

export async function registry(
  subcommand: string | null,
  positionals: string[],
  flags: Record<string, string | true>
): Promise<void> {
  switch (subcommand) {
    case 'login':
      return registryLogin(positionals, flags)
    case 'logout':
      return registryLogout(positionals)
    case 'list':
    case 'ls':
      return registryList()
    default:
      printCommandHelp(
        'zero registry <subcommand> [args]',
        [
          ['--user <u>', 'Registry username'],
          ['--password <p>', 'Registry password or token']
        ],
        [
          'zero registry login ghcr.io --user <u> --password <token>',
          'zero registry logout ghcr.io',
          'zero registry list'
        ]
      )
      process.exit(1)
  }
}

async function registryLogin(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const server = positionals[0]
  const username = flags['user'] as string | undefined
  const password = flags['password'] as string | undefined

  if (!server || !username || !password) {
    logError('Usage: zero registry login <server> --user <u> --password <p>')
    process.exit(1)
  }

  const client = createClient()
  unwrap(await client.post<MessageResponse>('/registries', { server, username, password }), logError)
  logSuccess(`Logged in to ${server}`)
}

async function registryLogout(positionals: string[]): Promise<void> {
  const server = positionals[0]
  if (!server) {
    logError('Usage: zero registry logout <server>')
    process.exit(1)
  }

  const client = createClient()
  unwrap(await client.del<MessageResponse>(`/registries/${encodeURIComponent(server)}`), logError)
  logSuccess(`Logged out from ${server}`)
}

async function registryList(): Promise<void> {
  const client = createClient()
  const spin = spinner('loading registries...')
  const res = await client.get<string[]>('/registries')
  spin.stop()
  const servers = unwrap(res, logError)

  if (servers.length === 0) {
    logInfo('No registries configured')
    return
  }

  for (const server of servers) {
    console.log(`  ${dim('•')} ${server}`)
  }
}
