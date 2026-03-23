import { execSync } from 'node:child_process'
import { createClient, unwrap, type MessageResponse } from '../client.ts'
import { VERSION } from '../version.ts'
import { logSuccess, logInfo, logError, spinner } from '../ui.ts'

const REPO = 'shipzero/zero'

function baseVersion(version: string): string {
  return version.split('+')[0]
}

export async function upgrade(flags: Record<string, string | true>): Promise<void> {
  const shouldUpgradeServer = flags['server'] === true || flags['all'] === true
  const shouldUpgradeCli = flags['server'] !== true || flags['all'] === true
  const isForce = flags['force'] === true
  const isCanary = flags['canary'] === true

  if (shouldUpgradeCli) {
    await upgradeCli(isForce, isCanary)
  }

  if (shouldUpgradeServer) {
    await upgradeServer(isCanary)
  }
}

function fetchLatestRelease(isCanary: boolean): { tag: string } {
  if (isCanary) {
    const json = execSync(`curl -fsSL https://api.github.com/repos/${REPO}/releases`, { encoding: 'utf8' })
    const releases = JSON.parse(json) as Array<{ tag_name: string; prerelease: boolean }>
    const preview = releases.find((r) => r.prerelease)
    if (!preview) {
      logError('No canary release found')
      process.exit(1)
    }
    return { tag: preview.tag_name }
  }

  const json = execSync(`curl -fsSL https://api.github.com/repos/${REPO}/releases/latest`, { encoding: 'utf8' })
  const latest = JSON.parse(json) as { tag_name: string }
  return { tag: latest.tag_name }
}

async function upgradeCli(isForce: boolean, isCanary: boolean): Promise<void> {
  const platform = process.platform === 'darwin' ? 'zero-macos' : 'zero-linux'

  const { tag } = fetchLatestRelease(isCanary)

  if (tag === baseVersion(VERSION) && !isForce && !isCanary) {
    logInfo(`CLI already up to date (${VERSION})`)
    return
  }

  logInfo(
    tag === baseVersion(VERSION)
      ? `Reinstalling CLI ${baseVersion(VERSION)}...`
      : `Upgrading CLI ${baseVersion(VERSION)} → ${tag}...`
  )

  const downloadUrl = `https://github.com/${REPO}/releases/download/${tag}/${platform}`
  const installDir = `${process.env.HOME}/.zero/bin`

  execSync(
    `mkdir -p "${installDir}" && curl -fsSL "${downloadUrl}" -o /tmp/zero && chmod +x /tmp/zero && mv /tmp/zero "${installDir}/zero"`,
    { stdio: 'inherit' }
  )

  logSuccess(`CLI upgraded to ${tag}`)
}

async function upgradeServer(isCanary: boolean): Promise<void> {
  const { tag } = fetchLatestRelease(isCanary)
  const client = createClient()
  const spin = spinner(`Upgrading server to ${tag}...`)
  const res = await client.post<MessageResponse>('/upgrade', { tag })
  spin.stop()
  const data = unwrap(res, logError)

  logSuccess(data.message)
}
