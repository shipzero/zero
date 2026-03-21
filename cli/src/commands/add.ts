import fs from 'node:fs'
import { createClient, unwrap } from '../client.ts'
import type { AddAppResponse } from '../../../src/types.ts'
import dns from 'node:dns/promises'
import { logSuccess, logInfo, logHint, logError, bold, dim } from '../ui.ts'

async function resolveServerIp(serverHost: string): Promise<string> {
  const hostname = new URL(serverHost).hostname
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname
  try {
    const addresses = await dns.resolve4(hostname)
    return addresses[0]
  } catch {
    return hostname
  }
}

async function printDnsTable(domain: string, serverHost: string): Promise<void> {
  const ip = await resolveServerIp(serverHost)
  const typeWidth = 4
  const nameWidth = Math.max(4, domain.length, `*.${domain}`.length)

  console.log()
  console.log(bold('  DNS records required:'))
  console.log()
  console.log(bold(`  ${'TYPE'.padEnd(typeWidth)}  ${'NAME'.padEnd(nameWidth)}  VALUE`))
  console.log(`  ${'A'.padEnd(typeWidth)}  ${domain.padEnd(nameWidth)}  ${ip}`)
  console.log(
    `  ${'A'.padEnd(typeWidth)}  ${`*.${domain}`.padEnd(nameWidth)}  ${ip}  ${dim('(for preview deployments)')}`
  )
  console.log()
}

export async function add(flags: Record<string, string | true>): Promise<void> {
  const name = flags['name'] as string | undefined
  const image = flags['image'] as string | undefined
  const domain = flags['domain'] as string | undefined
  const port = flags['port'] ? Number(flags['port']) : undefined
  const hostPort = flags['host-port'] ? Number(flags['host-port']) : undefined
  const command = flags['command'] as string | undefined
  const volume = flags['volume'] as string | undefined
  const healthPath = flags['health-path'] as string | undefined
  const healthTimeout = flags['health-timeout'] ? Number(flags['health-timeout']) * 1000 : undefined
  const composePath = flags['compose'] as string | undefined
  const service = flags['service'] as string | undefined
  const repo = flags['repo'] as string | undefined
  const tag = flags['tag'] as string | undefined

  if (!name) {
    logError(
      'usage: zero add --name <n> --image <img> [--domain <d>] [--port <p>] [--host-port <p>] [--command <cmd>] [--volume <v>] [--health-path <path>]'
    )
    logError(
      '       zero add --name <n> --compose <file> --service <svc> [--domain <d>] [--port <p>] [--host-port <p>] [--repo <r>] [--tag <t>]'
    )
    process.exit(1)
  }

  if (composePath && image) {
    logError('cannot use both --image and --compose')
    process.exit(1)
  }

  if (!composePath && !image) {
    logError('either --image or --compose is required')
    process.exit(1)
  }

  const client = createClient()

  if (composePath) {
    if (!service) {
      logError('--service is required for compose apps')
      process.exit(1)
    }

    if (!fs.existsSync(composePath)) {
      logError(`file not found: ${composePath}`)
      process.exit(1)
    }

    const composeFile = fs.readFileSync(composePath, 'utf8')
    const resolvedPort = port ?? 80

    const data = unwrap(
      await client.post<AddAppResponse>('/apps', {
        name,
        domain,
        internalPort: resolvedPort,
        hostPort: !domain ? (hostPort ?? resolvedPort) : undefined,
        composeFile,
        entryService: service,
        healthPath,
        healthTimeout,
        repo,
        trackTag: tag
      }),
      logError
    )

    logSuccess(`compose app "${data.name}" added`)
    logInfo(`entry service: ${service}, port: ${resolvedPort}`)
    if (domain) {
      logInfo(`domain: ${domain}`)
      await printDnsTable(domain, client.config.host)
    }
    logHint(`deploy with: zero deploy ${name}`)
    return
  }

  const resolvedPort = port ?? 3000

  const data = unwrap(
    await client.post<AddAppResponse>('/apps', {
      name,
      image,
      domain,
      internalPort: resolvedPort,
      hostPort: !domain ? (hostPort ?? resolvedPort) : undefined,
      command: command ? command.split(' ') : undefined,
      volumes: volume ? volume.split(',') : undefined,
      healthPath,
      healthTimeout
    }),
    logError
  )

  logSuccess(`app "${data.name}" added`)
  logInfo(`image: ${image}, port: ${resolvedPort}${domain ? `, domain: ${domain}` : ''}`)
  logInfo(`webhook: ${data.webhookUrl}`)
  if (domain) await printDnsTable(domain, client.config.host)
  logHint(`deploy with: zero deploy ${name}`)
}
