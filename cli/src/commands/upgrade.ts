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
  const isPreview = flags['preview'] === true

  if (shouldUpgradeCli) {
    await upgradeCli(isForce, isPreview)
  }

  if (shouldUpgradeServer) {
    await upgradeServer(isPreview)
  }
}

function fetchLatestRelease(isPreview: boolean): { tag: string } {
  if (isPreview) {
    const json = execSync(`curl -fsSL https://api.github.com/repos/${REPO}/releases`, { encoding: 'utf8' })
    const releases = JSON.parse(json) as Array<{ tag_name: string; prerelease: boolean }>
    const preview = releases.find((r) => r.prerelease)
    if (!preview) {
      logError('no preview release found')
      process.exit(1)
    }
    return { tag: preview.tag_name }
  }

  const json = execSync(`curl -fsSL https://api.github.com/repos/${REPO}/releases/latest`, { encoding: 'utf8' })
  const latest = JSON.parse(json) as { tag_name: string }
  return { tag: latest.tag_name }
}

async function upgradeCli(isForce: boolean, isPreview: boolean): Promise<void> {
  const platform = process.platform === 'darwin' ? 'zero-macos' : 'zero-linux'

  const { tag } = fetchLatestRelease(isPreview)

  if (tag === baseVersion(VERSION) && !isForce && !isPreview) {
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

async function upgradeServer(isPreview: boolean): Promise<void> {
  const { tag } = fetchLatestRelease(isPreview)
  logInfo(`upgrading server to ${tag}...`)

  const client = createClient()
  const data = unwrap(await client.post<MessageResponse>('/upgrade', { tag }), logError)

  logSuccess(data.message)
}
