import { createClient, unwrap } from '../client.ts'
import { logSuccess, logError, logHint, confirm, bold, requireAppName } from '../ui.ts'

interface WebhookResponse {
  webhookSecret: string
  webhookUrl: string
}

export async function webhook(subcommand: string | null, positionals: string[]): Promise<void> {
  if (subcommand === 'url') {
    await webhookUrl(positionals)
  } else {
    logError('Usage: zero webhook url <app>')
    process.exit(1)
  }
}

async function webhookUrl(positionals: string[]): Promise<void> {
  const appName = requireAppName(positionals, 'zero webhook url <app>')
  const client = createClient()

  unwrap(await client.get(`/apps/${encodeURIComponent(appName)}`), logError)

  const ok = await confirm(`Rotate webhook secret for ${bold(appName)}? The current secret will stop working.`)
  if (!ok) process.exit(0)
  const data = unwrap(await client.post<WebhookResponse>(`/apps/${encodeURIComponent(appName)}/webhook`), logError)

  logSuccess(`Webhook secret rotated for ${appName}`)
  console.log(`  URL: ${data.webhookUrl}`)
  logHint('Update the webhook URL in your registry')
}
