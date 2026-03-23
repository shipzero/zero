import { createClient, unwrap } from '../client.ts'
import type { AppSummary } from '../../../src/types.ts'
import { dim, logInfo, logError, timeAgo, timeUntil, formatStatus, formatAppUrl, printTable, spinner } from '../ui.ts'
import type { Column } from '../ui.ts'

export async function list(): Promise<void> {
  const client = createClient()
  const spin = spinner('Loading apps...')
  const res = await client.get<AppSummary[]>('/apps')
  spin.stop()
  const data = unwrap(res, logError)

  if (data.length === 0) {
    logInfo('No apps registered')
    return
  }

  const serverUrl = new URL(client.config.host)
  const rows: Record<string, string>[] = []

  for (const app of data) {
    rows.push({
      name: app.name,
      status: formatStatus(app.status),
      url: formatAppUrl(app.domains[0], app.hostPort, serverUrl),
      image: app.currentImage ?? '—',
      deployed: dim(app.deployedAt ? timeAgo(app.deployedAt) : '—'),
      expires: ''
    })
    for (const p of app.previews ?? []) {
      rows.push({
        name: ` └ ${p.label}`,
        status: formatStatus(p.status),
        url: formatAppUrl(p.domain, undefined, serverUrl),
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
