import { createClient, unwrap } from '../client.ts'
import { formatDeployLog } from './deploy.ts'
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
  formatStatus,
  printTable,
  requireAppName
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

  const abort = new AbortController()

  client
    .streamSSE(
      `/apps/${encodeURIComponent(appName)}/deploy-logs`,
      (line) => {
        const formatted = formatDeployLog(line)
        if (formatted) console.log(formatted)
      },
      abort.signal
    )
    .catch(() => {})

  const { data } = await client.post<PreviewDeployResponse>(`/apps/${encodeURIComponent(appName)}/previews`, {
    label,
    tag,
    ...(ttlHours !== undefined ? { ttlHours } : {})
  })

  abort.abort()

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
  const appName = requireAppName(positionals, 'zero preview ls <app>')

  const client = createClient()
  const data = unwrap(await client.get<PreviewSummary[]>(`/apps/${encodeURIComponent(appName)}/previews`), logError)

  if (data.length === 0) {
    logInfo(`no previews for ${appName}`)
    return
  }

  const serverUrl = new URL(client.config.host)
  const rows = data.map((p) => ({
    label: p.label,
    status: formatStatus(p.status),
    url: `${serverUrl.protocol}//${p.domain}`,
    image: p.image ?? '—',
    deployed: dim(p.deployedAt ? timeAgo(p.deployedAt) : '—'),
    expires: dim(p.expiresAt ? timeUntil(p.expiresAt) : '—')
  }))

  printTable(
    [
      { header: 'LABEL', key: 'label' },
      { header: 'STATUS', key: 'status' },
      { header: 'URL', key: 'url' },
      { header: 'IMAGE', key: 'image' },
      { header: 'DEPLOYED', key: 'deployed' },
      { header: 'EXPIRES', key: 'expires' }
    ],
    rows
  )
}

async function previewRm(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = requireAppName(
    positionals,
    'zero preview rm <app> <label> [--force] | zero preview rm <app> --all [--force]'
  )

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
