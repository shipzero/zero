import { createClient, unwrap } from '../client.ts'
import type { AppSummary } from '../../../src/types.ts'
import { bold, dim, logInfo, logError, timeAgo, formatStatus } from '../ui.ts'

function formatUrl(app: AppSummary, serverUrl: URL): string {
  if (app.domain) return `${serverUrl.protocol}//${app.domain}`
  if (app.hostPort) return `http://${serverUrl.hostname}:${app.hostPort}`
  return '—'
}

export async function ls(): Promise<void> {
  const client = createClient()
  const data = unwrap(await client.get<AppSummary[]>('/apps'), logError)

  if (data.length === 0) {
    logInfo('no apps registered')
    return
  }

  const serverUrl = new URL(client.config.host)
  const urls = data.map((app) => formatUrl(app, serverUrl))
  const nameWidth = Math.max(4, ...data.map((app) => app.name.length))
  const statusWidth = 7 // "running" is longest
  const urlWidth = Math.max(3, ...urls.map((u) => u.length))
  const imageWidth = Math.max(5, ...data.map((app) => (app.currentImage ?? '—').length))

  const header = bold(
    ['NAME'.padEnd(nameWidth), 'STATUS'.padEnd(statusWidth), 'URL'.padEnd(urlWidth), 'IMAGE'.padEnd(imageWidth), 'DEPLOYED'].join('  ')
  )
  console.log(header)

  for (let i = 0; i < data.length; i++) {
    const app = data[i]
    const deployedAt = app.deployedAt ? dim(timeAgo(app.deployedAt)) : dim('—')
    const statusText = formatStatus(app.status)
    const statusPad = ' '.repeat(Math.max(0, statusWidth - (app.status === 'no deployment' ? 1 : app.status.length)))
    const row = [
      app.name.padEnd(nameWidth),
      statusText + statusPad,
      urls[i].padEnd(urlWidth),
      (app.currentImage ?? '—').padEnd(imageWidth),
      deployedAt
    ].join('  ')
    console.log(row)
  }
}
