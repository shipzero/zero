import { execSync } from 'node:child_process'
import { createClient, unwrap, type MessageResponse } from '../client.ts'
import { VERSION } from '../version.ts'
import { logSuccess, logInfo, logError } from '../ui.ts'

const REPO = 'shipzero/zero'

function baseVersion(version: string): string {
  return version.split('+')[0]
}

export async function upgrade(flags: Record<string, string | true>): Promise<void> {
  const shouldUpgradeServer = flags['server'] === true || flags['all'] === true
  const shouldUpgradeCli = flags['server'] !== true || flags['all'] === true
  const isForce = flags['force'] === true

  if (shouldUpgradeCli) {
    await upgradeCli(isForce)
  }

  if (shouldUpgradeServer) {
    await upgradeServer()
  }
}

async function upgradeCli(isForce: boolean): Promise<void> {
  const platform = process.platform === 'darwin' ? 'zero-macos' : 'zero-linux'

  const latestJson = execSync(`curl -fsSL https://api.github.com/repos/${REPO}/releases/latest`, { encoding: 'utf8' })
  const latest = JSON.parse(latestJson)
  const tag = latest.tag_name as string

  if (tag === baseVersion(VERSION) && !isForce) {
    logInfo(`cli already up to date (${VERSION})`)
    return
  }

  logInfo(
    tag === baseVersion(VERSION)
      ? `reinstalling cli ${baseVersion(VERSION)}...`
      : `upgrading cli ${baseVersion(VERSION)} → ${tag}...`
  )

  const downloadUrl = `https://github.com/${REPO}/releases/download/${tag}/${platform}`
  const installDir = `${process.env.HOME}/.zero/bin`

  execSync(
    `mkdir -p "${installDir}" && curl -fsSL "${downloadUrl}" -o /tmp/zero && chmod +x /tmp/zero && mv /tmp/zero "${installDir}/zero"`,
    { stdio: 'inherit' }
  )

  logSuccess(`cli upgraded to ${tag}`)
}

async function upgradeServer(): Promise<void> {
  logInfo('upgrading server...')

  const client = createClient()
  const data = unwrap(await client.post<MessageResponse>('/upgrade'), logError)

  logSuccess(data.message)
}
