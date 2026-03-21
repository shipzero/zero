import { createClient, unwrap } from '../client.ts'
import { logSuccess, logError, requireAppName } from '../ui.ts'

interface WebhookResetResponse {
  webhookSecret: string
  webhookUrl: string
}

export async function webhook(subcommand: string | null, positionals: string[]): Promise<void> {
  if (subcommand === 'reset') {
    await webhookReset(positionals)
  } else {
    logError('usage: zero webhook reset <app>')
    process.exit(1)
  }
}

async function webhookReset(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero webhook reset <app>')

  const client = createClient()
  const data = unwrap(
    await client.post<WebhookResetResponse>(`/apps/${encodeURIComponent(appName)}/webhooks/reset`),
    logError
  )

  logSuccess(`webhook secret reset for ${appName}`)
  console.log(`  url: ${data.webhookUrl}`)
}
