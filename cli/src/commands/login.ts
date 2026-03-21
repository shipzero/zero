import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { saveConfig } from '../config.ts'
import { logSuccess, logInfo, logError } from '../ui.ts'

export async function login(positionals: string[], _flags: Record<string, string | true>): Promise<void> {
  const destination = positionals[0]

  if (!destination || !destination.includes('@')) {
    logError('usage: zero login <user@server>')
    console.error('Example: zero login root@your-server.com')
    process.exit(1)
  }

  const server = destination.split('@').pop()!

  const jwt = await sshMintJwt(destination)
  if (!jwt) {
    process.exit(1)
  }

  const host = await resolveApiUrl(server, jwt)
  if (!host) {
    logError('authentication failed')
    process.exit(1)
  }

  saveConfig({ host, token: jwt, destination })
  ensureGitignore()
  logSuccess(`linked to ${host}`)
}

const SSH_COMMAND =
  'source /opt/zero/.env && curl -sf -H "Authorization: Bearer ${TOKEN}" -X POST http://127.0.0.1:2020/auth/token'

function sshExec(destination: string, command: string): Promise<{ stdout: string; ok: boolean }> {
  return new Promise((resolve) => {
    execFile('ssh', [destination, command], { timeout: 30_000 }, (err, stdout) => {
      if (err) {
        logError(`SSH connection failed — check that you can ssh to ${destination}`)
        resolve({ stdout: '', ok: false })
        return
      }
      resolve({ stdout: stdout.trim(), ok: true })
    })
  })
}

export async function sshMintJwt(destination: string): Promise<string | null> {
  const { stdout, ok } = await sshExec(destination, SSH_COMMAND)
  if (!ok) return null

  if (!stdout) {
    logError('failed to obtain token — is zero running on the server?')
    return null
  }

  try {
    const parsed = JSON.parse(stdout) as { token?: string }
    if (parsed.token) return parsed.token
  } catch {
    // not JSON
  }

  logError('unexpected response from server')
  return null
}

function tryUrl(url: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: '/version',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000
      },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}

async function resolveApiUrl(server: string, token: string): Promise<string | null> {
  const httpsUrl = `https://${server}`
  if (await tryUrl(httpsUrl, token)) return httpsUrl

  const httpUrl = `http://${server}`
  if (await tryUrl(httpUrl, token)) return httpUrl

  return null
}

function ensureGitignore(): void {
  const gitignorePath = path.join(process.cwd(), '.gitignore')
  if (!fs.existsSync(gitignorePath)) return

  const content = fs.readFileSync(gitignorePath, 'utf-8')
  if (content.includes('.zero')) return

  fs.appendFileSync(gitignorePath, '\n# zero\n.zero/\n')
  logInfo('added .zero/ to .gitignore')
}
