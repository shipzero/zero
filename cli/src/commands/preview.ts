import { createClient, unwrap } from '../client.ts'
import type { PreviewSummary, MessageResponse } from '../../../src/types.ts'
import {
  logInfo,
  logSuccess,
  logError,
  bold,
  dim,
  confirm,
  timeAgo,
  timeUntil,
  formatStatus,
  printTable,
  requireAppName,
  spinner,
  printCommandHelp
} from '../ui.ts'

async function previewLs(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero preview ls <app>')

  const client = createClient()
  const spin = spinner('loading previews...')
  const res = await client.get<PreviewSummary[]>(`/apps/${encodeURIComponent(appName)}/previews`)
  spin.stop()
  const data = unwrap(res, logError)

  if (data.length === 0) {
    logInfo(`No previews for ${appName}`)
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
    logError('Usage: zero preview rm <app> <label> [--force] | zero preview rm <app> --all [--force]')
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
    case 'list':
    case 'ls':
      await previewLs(positionals)
      break
    case 'remove':
    case 'rm':
      await previewRm(positionals, flags)
      break
    default:
      printCommandHelp(
        'zero preview <subcommand> <app> [args]',
        [
          ['--force', 'Skip confirmation prompt'],
          ['--all', 'Remove all previews']
        ],
        [
          'zero deploy myapp --preview pr-42        Deploy a preview',
          'zero preview list myapp                  List previews',
          'zero preview remove myapp pr-42          Remove a preview',
          'zero preview remove myapp --all          Remove all previews'
        ]
      )
      process.exit(1)
  }
}
