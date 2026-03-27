import { parseEnvPair } from '../../../shared/env.ts'
import type { AppDetail, MessageResponse } from '../../../src/types.ts'
import { createClient, unwrap } from '../client.ts'
import {
  bold,
  logError,
  logHint,
  logInfo,
  logSuccess,
  logWarn,
  printCommandHelp,
  requireAppName,
  spinner
} from '../ui.ts'

export async function env(
  subcommand: string | null,
  positionals: string[],
  _flags: Record<string, string | true>
): Promise<void> {
  if (subcommand === 'set') {
    await envSet(positionals)
  } else if (subcommand === 'list' || subcommand === 'ls') {
    await envList(positionals)
  } else if (subcommand === 'remove' || subcommand === 'rm') {
    await envRemove(positionals)
  } else {
    printCommandHelp('zero env <subcommand> <app> [args]', undefined, [
      'zero env set myapp KEY=val [KEY=val ...]',
      'zero env list myapp',
      'zero env remove myapp KEY [KEY ...]'
    ])
    process.exit(1)
  }
}

async function envSet(positionals: string[]): Promise<void> {
  const appName = positionals[0]
  const pairs = positionals.slice(1)

  if (!appName || pairs.length === 0) {
    logError('Usage: zero env set <app> KEY=val [KEY=val ...]')
    process.exit(1)
  }

  const envObj: Record<string, string> = {}
  for (const pair of pairs) {
    const parsed = parseEnvPair(pair)
    if (!parsed) {
      logError(`Invalid format: "${pair}" — expected KEY=val`)
      process.exit(1)
    }
    envObj[parsed[0]] = parsed[1]
  }

  const client = createClient()
  unwrap(await client.patch<MessageResponse>(`/apps/${encodeURIComponent(appName)}/env`, envObj), logError)

  const keys = Object.keys(envObj)
  logSuccess(`Set ${keys.length} variable${keys.length !== 1 ? 's' : ''}: ${keys.join(', ')}`)
  logWarn('Changes are not live yet')
  logHint(`Run: zero deploy ${appName}`)
}

async function envRemove(positionals: string[]): Promise<void> {
  const appName = positionals[0]
  const keys = positionals.slice(1)

  if (!appName || keys.length === 0) {
    logError('Usage: zero env remove <app> KEY [KEY ...]')
    process.exit(1)
  }

  const client = createClient()
  const query = keys.map((k) => `key=${encodeURIComponent(k)}`).join('&')
  unwrap(await client.del<MessageResponse>(`/apps/${encodeURIComponent(appName)}/env?${query}`), logError)

  logSuccess(`Removed ${keys.length} variable${keys.length !== 1 ? 's' : ''}: ${keys.join(', ')}`)
  logWarn('Changes are not live yet')
  logHint(`Run: zero deploy ${appName}`)
}

async function envList(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero env list <app>')

  const client = createClient()
  const spin = spinner('Loading environment...')
  const res = await client.get<AppDetail>(`/apps/${encodeURIComponent(appName)}`)
  spin.stop()
  const data = unwrap(res, logError)

  const entries = Object.entries(data.env)
  if (entries.length === 0) {
    logInfo('No environment variables set')
    return
  }

  for (const [key, val] of entries) {
    console.log(`${bold(key)}=${val}`)
  }
}
