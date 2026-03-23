import { createClient, unwrap } from '../client.ts'
import type { DeploymentInfo, PreviewSummary } from '../../../src/types.ts'
import { dim, green, cyan, logInfo, logError, printTable, requireAppName, spinner, timeAgo, timeUntil } from '../ui.ts'

export async function history(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero history <app>')

  const client = createClient()
  const spin = spinner('Loading history...')
  const [deploymentsRes, previewsRes] = await Promise.all([
    client.get<DeploymentInfo[]>(`/apps/${encodeURIComponent(appName)}/deployments`),
    client.get<PreviewSummary[]>(`/apps/${encodeURIComponent(appName)}/previews`)
  ])
  spin.stop()

  const deployments = unwrap(deploymentsRes, logError)
  const previews = unwrap(previewsRes, logError)

  if (deployments.length === 0 && previews.length === 0) {
    logInfo('No deployments')
    return
  }

  const rows: Record<string, string>[] = []

  for (const d of deployments) {
    rows.push({
      type: d.isCurrent ? green('production') : dim('production'),
      image: d.image + (d.isCurrent ? green(' ← current') : ''),
      deployed: dim(timeAgo(d.deployedAt)),
      expires: ''
    })
  }

  for (const p of previews) {
    rows.push({
      type: cyan('preview'),
      image: `${p.label} ${dim(`(${p.image ?? '—'})`)}`,
      deployed: dim(p.deployedAt ? timeAgo(p.deployedAt) : '—'),
      expires: dim(p.expiresAt ? timeUntil(p.expiresAt) : '')
    })
  }

  const hasExpires = rows.some((r) => r.expires !== '')
  const columns = [
    { header: 'TYPE', key: 'type' },
    { header: 'IMAGE', key: 'image' },
    { header: 'DEPLOYED', key: 'deployed' },
    ...(hasExpires ? [{ header: 'EXPIRES', key: 'expires' }] : [])
  ]

  printTable(columns, rows)
}
