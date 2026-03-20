import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { saveConfig } from '../config.ts'
import { logSuccess, logInfo, logWarn, logError } from '../ui.ts'

export async function login(positionals: string[], _flags: Record<string, string | true>): Promise<void> {
  const [host, token] = positionals

  if (!host || !token) {
    logError('usage: zero login <host> <token>')
    console.error('Example: zero login https://myserver.com:2020 abc123...')
    process.exit(1)
  }

  const normalizedHost = host.startsWith('http') ? host : `https://${host}`

  // Verify connection before saving
  const ok = await verifyConnection(normalizedHost, token)
  if (!ok) {
    logWarn('could not reach server — credentials saved anyway')
  }

  saveConfig({ host: normalizedHost, token })
  ensureGitignore()
  logSuccess(`linked to ${normalizedHost}`)
}

async function verifyConnection(host: string, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(host)
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: '/version',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        rejectUnauthorized: false,
        timeout: 30_000
      },
      (res) => {
        res.resume()
        if (res.statusCode === 200) {
          resolve(true)
        } else if (res.statusCode === 401) {
          logError('invalid token')
          resolve(false)
        } else {
          resolve(false)
        }
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

/** Adds .zero/ to .gitignore if it exists but doesn't contain the entry yet. */
function ensureGitignore(): void {
  const gitignorePath = path.join(process.cwd(), '.gitignore')
  if (!fs.existsSync(gitignorePath)) return

  const content = fs.readFileSync(gitignorePath, 'utf-8')
  if (content.includes('.zero')) return

  fs.appendFileSync(gitignorePath, '\n# zero\n.zero/\n')
  logInfo('added .zero/ to .gitignore')
}
