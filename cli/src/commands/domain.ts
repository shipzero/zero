import { createClient, unwrap } from '../client.ts'
import { logSuccess, logError, logInfo, dim, requireAppName, spinner, printCommandHelp } from '../ui.ts'

interface DomainsResponse {
  domains: string[]
  added?: string
  removed?: string
}

export async function domain(
  subcommand: string | null,
  positionals: string[],
  _flags: Record<string, string | true>
): Promise<void> {
  switch (subcommand) {
    case 'add':
      return domainAdd(positionals)
    case 'remove':
    case 'rm':
      return domainRemove(positionals)
    case 'list':
    case 'ls':
      return domainList(positionals)
    default:
      printCommandHelp('zero domain <subcommand> <app> [domain]', undefined, [
        'zero domain add myapp staging.example.com',
        'zero domain remove myapp staging.example.com',
        'zero domain list myapp'
      ])
      process.exit(1)
  }
}

async function domainAdd(positionals: string[]): Promise<void> {
  const appName = positionals[0]
  const domainName = positionals[1]

  if (!appName || !domainName) {
    logError('Usage: zero domain add <app> <domain>')
    process.exit(1)
  }

  const client = createClient()
  const spin = spinner(`Adding ${domainName}...`)
  const res = await client.post<DomainsResponse>(`/apps/${encodeURIComponent(appName)}/domains`, {
    domain: domainName
  })
  spin.stop()
  unwrap(res, logError)

  logSuccess(`Added ${domainName} to ${appName}`)
}

async function domainRemove(positionals: string[]): Promise<void> {
  const appName = positionals[0]
  const domainName = positionals[1]

  if (!appName || !domainName) {
    logError('Usage: zero domain remove <app> <domain>')
    process.exit(1)
  }

  const client = createClient()
  const spin = spinner(`Removing ${domainName}...`)
  const res = await client.del<DomainsResponse>(
    `/apps/${encodeURIComponent(appName)}/domains/${encodeURIComponent(domainName)}`
  )
  spin.stop()
  unwrap(res, logError)

  logSuccess(`Removed ${domainName} from ${appName}`)
}

async function domainList(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero domain list <app>')

  const client = createClient()
  const spin = spinner('Loading domains...')
  const res = await client.get<DomainsResponse>(`/apps/${encodeURIComponent(appName)}/domains`)
  spin.stop()
  const data = unwrap(res, logError)

  if (data.domains.length === 0) {
    logInfo('No domains configured')
    return
  }

  for (let i = 0; i < data.domains.length; i++) {
    const label = i === 0 ? dim('(primary)') : ''
    console.log(`  ${dim('•')} ${data.domains[i]} ${label}`)
  }
}
