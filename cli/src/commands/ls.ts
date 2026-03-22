import { createClient, unwrap } from '../client.ts'
import type { AppSummary } from '../../../src/types.ts'
import { dim, logInfo, logError, timeAgo, timeUntil, formatStatus, printTable, spinner } from '../ui.ts'
import type { Column } from '../ui.ts'

function formatUrl(
  domain: string | undefined,
  hostPort: number | undefined,
  port: number | undefined,
  serverUrl: URL
): string {
  if (domain) return `${serverUrl.protocol}//${domain}`
  const displayPort = hostPort ?? port
  if (displayPort) return `http://${serverUrl.hostname}:${displayPort}`
  return '—'
}

export async function ls(): Promise<void> {
  const client = createClient()
  const spin = spinner('loading apps...')
  const res = await client.get<AppSummary[]>('/apps')
  spin.stop()
  const data = unwrap(res, logError)

  if (data.length === 0) {
    logInfo('no apps registered')
    return
  }

  const serverUrl = new URL(client.config.host)
  const rows: Record<string, string>[] = []

  for (const app of data) {
    rows.push({
      name: app.name,
      status: formatStatus(app.status),
      url: formatUrl(app.domain, app.hostPort, app.port, serverUrl),
      image: app.currentImage ?? '—',
      deployed: dim(app.deployedAt ? timeAgo(app.deployedAt) : '—'),
      expires: ''
    })
    for (const p of app.previews ?? []) {
      rows.push({
        name: ` └ ${p.label}`,
        status: formatStatus(p.status),
        url: formatUrl(p.domain, undefined, undefined, serverUrl),
        image: p.image ?? '—',
        deployed: dim(p.deployedAt ? timeAgo(p.deployedAt) : '—'),
        expires: dim(p.expiresAt ? timeUntil(p.expiresAt) : '')
      })
    }
  }

  const hasExpires = rows.some((r) => r.expires !== '')
  const columns: Column[] = [
    { header: 'NAME', key: 'name' },
    { header: 'STATUS', key: 'status' },
    { header: 'URL', key: 'url' },
    { header: 'IMAGE', key: 'image' },
    { header: 'DEPLOYED', key: 'deployed' }
  ]
  if (hasExpires) columns.push({ header: 'EXPIRES', key: 'expires' })

  printTable(columns, rows)
}
