import { createClient, unwrap } from '../client.ts'
import { formatDeployLog } from './deploy.ts'
import type { PreviewSummary, MessageResponse } from '../../../src/types.ts'
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
  requireAppName,
  spinner
} from '../ui.ts'

async function previewDeploy(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const appName = positionals[0]
  const tag = flags['tag'] as string | undefined
  if (!appName || !tag) {
    logError('usage: zero preview deploy <app> --tag <tag> [--label <label>] [--ttl <duration>]')
    process.exit(1)
  }

  const label = (flags['label'] as string | undefined) ?? tag
  const ttl = flags['ttl'] as string | undefined
  const client = createClient()

  logInfo(`deploying preview ${bold(label)} for ${bold(appName)}...`)

  process.on('SIGINT', () => {
    console.log(dim('\n[disconnected — deploy continues on the server]'))
    process.exit(0)
  })

  interface PreviewEvent {
    event: string
    message?: string
    success?: boolean
    url?: string
    error?: string
  }

  let result: PreviewEvent | undefined

  await client.postSSE(
    `/apps/${encodeURIComponent(appName)}/previews`,
    { label, tag, ...(ttl ? { ttl } : {}) },
    (raw) => {
      const event = JSON.parse(raw) as PreviewEvent

      if (event.event === 'log' && event.message) {
        const formatted = formatDeployLog(event.message)
        if (formatted) console.log(formatted)
        return
      }

      if (event.event === 'complete') {
        result = event
      }
    }
  )

  if (result?.success) {
    logSuccess(`preview deployed: ${cyan(result.url ?? '')}`)
    logHint(`remove with: zero preview rm ${appName} ${label}`)
  } else {
    logError(result?.error ?? 'preview deploy failed')
    process.exit(1)
  }
}

async function previewLs(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero preview ls <app>')

  const client = createClient()
  const spin = spinner('loading previews...')
  const res = await client.get<PreviewSummary[]>(`/apps/${encodeURIComponent(appName)}/previews`)
  spin.stop()
  const data = unwrap(res, logError)

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
