import { createClient, unwrap } from '../client.ts'
import type { AppSummary } from '../../../src/types.ts'
import { bold, dim, logInfo, logError, timeAgo, timeUntil, formatStatus } from '../ui.ts'

function formatUrl(domain: string | undefined, hostPort: number | undefined, serverUrl: URL): string {
  if (domain) return `${serverUrl.protocol}//${domain}`
  if (hostPort) return `http://${serverUrl.hostname}:${hostPort}`
  return '—'
}

interface Row {
  name: string
  status: string
  statusRaw: string
  url: string
  image: string
  deployed: string
  expires?: string
}

function collectRows(apps: AppSummary[], serverUrl: URL): Row[] {
  const rows: Row[] = []
  for (const app of apps) {
    rows.push({
      name: app.name,
      status: formatStatus(app.status),
      statusRaw: app.status,
      url: formatUrl(app.domain, app.hostPort, serverUrl),
      image: app.currentImage ?? '—',
      deployed: app.deployedAt ? timeAgo(app.deployedAt) : '—'
    })
    for (const p of app.previews) {
      rows.push({
        name: ` └ ${p.label}`,
        status: formatStatus(p.status),
        statusRaw: p.status,
        url: formatUrl(p.domain, undefined, serverUrl),
        image: p.image ?? '—',
        deployed: p.deployedAt ? timeAgo(p.deployedAt) : '—',
        expires: p.expiresAt ? timeUntil(p.expiresAt) : undefined
      })
    }
  }
  return rows
}

export async function ls(): Promise<void> {
  const client = createClient()
  const data = unwrap(await client.get<AppSummary[]>('/apps'), logError)

  if (data.length === 0) {
    logInfo('no apps registered')
    return
  }

  const serverUrl = new URL(client.config.host)
  const rows = collectRows(data, serverUrl)
  const hasExpires = rows.some((r) => r.expires)

  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length))
  const statusWidth = 7
  const urlWidth = Math.max(3, ...rows.map((r) => r.url.length))
  const imageWidth = Math.max(5, ...rows.map((r) => r.image.length))

  const columns = [
    'NAME'.padEnd(nameWidth),
    'STATUS'.padEnd(statusWidth),
    'URL'.padEnd(urlWidth),
    'IMAGE'.padEnd(imageWidth),
    'DEPLOYED'
  ]
  if (hasExpires) columns.push('EXPIRES')
  console.log(bold(columns.join('  ')))

  for (const row of rows) {
    const statusPad = ' '.repeat(
      Math.max(0, statusWidth - (row.statusRaw === 'no deployment' ? 1 : row.statusRaw.length))
    )
    const cols = [
      row.name.padEnd(nameWidth),
      row.status + statusPad,
      row.url.padEnd(urlWidth),
      row.image.padEnd(imageWidth),
      dim(row.deployed)
    ]
    if (hasExpires) cols.push(row.expires ? dim(row.expires) : '')
    console.log(cols.join('  '))
  }
}
