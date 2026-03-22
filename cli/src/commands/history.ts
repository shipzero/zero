import { createClient, unwrap } from '../client.ts'
import type { DeploymentInfo } from '../../../src/types.ts'
import { dim, green, logInfo, logError, printTable, requireAppName, spinner } from '../ui.ts'

export async function history(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero history <app>')

  const client = createClient()
  const spin = spinner('loading deployments...')
  const res = await client.get<DeploymentInfo[]>(`/apps/${encodeURIComponent(appName)}/deployments`)
  spin.stop()
  const data = unwrap(res, logError)

  if (data.length === 0) {
    logInfo('No deployments')
    return
  }

  const rows = data.map((d) => ({
    id: d.containerId.slice(0, 12),
    image: d.image + (d.isCurrent ? green(' ← current') : ''),
    deployed: dim(new Date(d.deployedAt).toLocaleString())
  }))

  printTable(
    [
      { header: 'ID', key: 'id', minWidth: 12 },
      { header: 'IMAGE', key: 'image' },
      { header: 'DEPLOYED', key: 'deployed' }
    ],
    rows
  )
}
