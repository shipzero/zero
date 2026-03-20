import { createClient, unwrap } from '../client.ts'
import type { PreviewDeployResponse, PreviewSummary, MessageResponse } from '../../../src/types.ts'
import {
  logInfo,
  logSuccess,
  logError,
  logHint,
  bold,
  dim,
  cyan,
  confirm,
  timeAgo,
  timeUntil,
  formatStatus
} from '../ui.ts'

async function previewDeploy(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = positionals[0]
  const tag = flags['tag'] as string | undefined
  if (!appName || !tag) {
    logError('usage: zero preview deploy <app> --tag <tag> [--label <label>] [--ttl <hours>]')
    process.exit(1)
  }

  const label = (flags['label'] as string | undefined) ?? tag
  const ttlHours = flags['ttl'] ? Number(flags['ttl']) : undefined
  const client = createClient()

  logInfo(`deploying preview ${bold(label)} for ${bold(appName)}...`)
  logHint('ctrl+c to disconnect (deploy will continue in background)')

  process.on('SIGINT', () => {
    console.log(dim('\n[disconnected — deploy continues on the server]'))
    process.exit(0)
  })

  const { data } = await client.post<PreviewDeployResponse>(`/apps/${encodeURIComponent(appName)}/previews`, {
    label,
    tag,
    ...(ttlHours !== undefined ? { ttlHours } : {})
  })

  const result = data as PreviewDeployResponse
  if (result.success) {
    logSuccess(`preview deployed: ${cyan(result.url)}`)
    logHint(`remove with: zero preview rm ${appName} ${label}`)
  } else {
    logError(result.error ?? 'preview deploy failed')
    process.exit(1)
  }
}

async function previewLs(positionals: string[]): Promise<void> {
  const appName = positionals[0]
  if (!appName) {
    logError('usage: zero preview ls <app>')
    process.exit(1)
  }

  const client = createClient()
  const data = unwrap(await client.get<PreviewSummary[]>(`/apps/${encodeURIComponent(appName)}/previews`), logError)

  if (data.length === 0) {
    logInfo(`no previews for ${appName}`)
    return
  }

  const serverUrl = new URL(client.config.host)
  const labelWidth = Math.max(5, ...data.map((p) => p.label.length))
  const statusWidth = 7
  const urlWidth = Math.max(3, ...data.map((p) => `${serverUrl.protocol}//${p.domain}`.length))

  const header = bold(
    ['LABEL'.padEnd(labelWidth), 'STATUS'.padEnd(statusWidth), 'URL'.padEnd(urlWidth), 'DEPLOYED', 'EXPIRES'].join('  ')
  )
  console.log(header)

  for (const p of data) {
    const url = `${serverUrl.protocol}//${p.domain}`
    const statusText = formatStatus(p.status)
    const statusPad = ' '.repeat(Math.max(0, statusWidth - (p.status === 'no deployment' ? 1 : p.status.length)))
    const row = [
      p.label.padEnd(labelWidth),
      statusText + statusPad,
      url.padEnd(urlWidth),
      p.deployedAt ? dim(timeAgo(p.deployedAt)) : dim('—'),
      p.expiresAt ? dim(timeUntil(p.expiresAt)) : dim('—')
    ].join('  ')
    console.log(row)
  }
}

async function previewRm(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = positionals[0]
  if (!appName) {
    logError('usage: zero preview rm <app> <label> [--force] | zero preview rm <app> --all [--force]')
    process.exit(1)
  }

  const client = createClient()
  const isAll = !!flags['all']
  const label = positionals[1]

  if (!isAll && !label) {
    logError('usage: zero preview rm <app> <label> [--force] | zero preview rm <app> --all [--force]')
    process.exit(1)
  }

  if (!flags['force']) {
    const message = isAll
      ? `remove all previews for ${bold(appName)}?`
      : `remove preview ${bold(label)} for ${bold(appName)}?`
    const ok = await confirm(message)
    if (!ok) process.exit(0)
  }

  if (isAll) {
    const data = unwrap(await client.del<MessageResponse>(`/apps/${encodeURIComponent(appName)}/previews`), logError)
    logSuccess(data.message)
  } else {
    const data = unwrap(
      await client.del<MessageResponse>(`/apps/${encodeURIComponent(appName)}/previews/${encodeURIComponent(label)}`),
      logError
    )
    logSuccess(data.message)
  }
}

export async function preview(
  subcommand: string | null,
  positionals: string[],
  flags: Record<string, string | true>
): Promise<void> {
  switch (subcommand) {
    case 'deploy':
      await previewDeploy(positionals, flags)
      break
    case 'ls':
      await previewLs(positionals)
      break
    case 'rm':
      await previewRm(positionals, flags)
      break
    default:
      logError('usage: zero preview <deploy|ls|rm> ...')
      process.exit(1)
  }
}
