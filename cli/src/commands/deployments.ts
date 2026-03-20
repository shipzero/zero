import { createClient, unwrap } from '../client.ts'
import type { DeploymentInfo } from '../../../src/types.ts'
import { bold, dim, green, logInfo, logError } from '../ui.ts'

export async function deployments(positionals: string[]): Promise<void> {
  const appName = positionals[0]
  if (!appName) {
    logError('usage: zero deployments <app>')
    process.exit(1)
  }

  const client = createClient()
  const data = unwrap(await client.get<DeploymentInfo[]>(`/apps/${encodeURIComponent(appName)}/deployments`), logError)

  if (data.length === 0) {
    logInfo('no deployments')
    return
  }

  const idWidth = 12
  const imageWidth = Math.max(5, ...data.map((deployment) => deployment.image.length))

  const header = bold(['ID'.padEnd(idWidth), 'IMAGE'.padEnd(imageWidth), 'DEPLOYED'].join('  '))
  console.log(header)

  for (const deployment of data) {
    const shortId = deployment.containerId.slice(0, 12)
    const deployedAt = dim(new Date(deployment.deployedAt).toLocaleString())
    const currentMarker = deployment.isCurrent ? green(' ← current') : ''
    console.log([shortId.padEnd(idWidth), deployment.image.padEnd(imageWidth), deployedAt].join('  ') + currentMarker)
  }
}
