import { createClient, unwrap } from '../client.ts'
import type { AppDetail, MessageResponse } from '../../../src/types.ts'
import { logSuccess, logInfo, logWarn, logError, logHint, bold, requireAppName } from '../ui.ts'

export async function env(
  subcommand: string | null,
  positionals: string[],
  _flags: Record<string, string | true>
): Promise<void> {
  if (subcommand === 'set') {
    await envSet(positionals)
  } else if (subcommand === 'ls') {
    await envLs(positionals)
  } else if (subcommand === 'rm') {
    await envRm(positionals)
  } else {
    logError('usage: zero env set <app> KEY [KEY ...]')
    console.error('       zero env ls <app>')
    console.error('       zero env rm <app> KEY [KEY ...]')
    process.exit(1)
  }
}

async function envSet(positionals: string[]): Promise<void> {
  const appName = positionals[0]
  const pairs = positionals.slice(1)

  if (!appName || pairs.length === 0) {
    logError('usage: zero env set <app> KEY=val [KEY=val ...]')
    process.exit(1)
  }

  const envObj: Record<string, string> = {}
  for (const pair of pairs) {
    const equalsIndex = pair.indexOf('=')
    if (equalsIndex === -1) {
      logError(`invalid format: "${pair}" — expected KEY=val`)
      process.exit(1)
    }
    envObj[pair.slice(0, equalsIndex)] = pair.slice(equalsIndex + 1)
  }

  const client = createClient()
  unwrap(await client.patch<MessageResponse>(`/apps/${encodeURIComponent(appName)}/env`, envObj), logError)

  const keys = Object.keys(envObj)
  logSuccess(`set ${keys.length} variable${keys.length !== 1 ? 's' : ''}: ${keys.join(', ')}`)
  logWarn('changes are not live yet')
  logHint(`run: zero deploy ${appName}`)
}

async function envRm(positionals: string[]): Promise<void> {
  const appName = positionals[0]
  const keys = positionals.slice(1)

  if (!appName || keys.length === 0) {
    logError('usage: zero env rm <app> KEY [KEY ...]')
    process.exit(1)
  }

  const client = createClient()
  const query = keys.map((k) => `key=${encodeURIComponent(k)}`).join('&')
  unwrap(await client.del<MessageResponse>(`/apps/${encodeURIComponent(appName)}/env?${query}`), logError)

  logSuccess(`removed ${keys.length} variable${keys.length !== 1 ? 's' : ''}: ${keys.join(', ')}`)
  logWarn('changes are not live yet')
  logHint(`run: zero deploy ${appName}`)
}

async function envLs(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero env ls <app>')

  const client = createClient()
  const data = unwrap(await client.get<AppDetail>(`/apps/${encodeURIComponent(appName)}`), logError)

  const entries = Object.entries(data.env)
  if (entries.length === 0) {
    logInfo('no environment variables set')
    return
  }

  for (const [key, val] of entries) {
    console.log(`${bold(key)}=${val}`)
  }
}
