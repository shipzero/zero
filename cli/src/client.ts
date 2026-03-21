import http from 'node:http'
import https from 'node:https'
import { loadConfig, saveConfig, type Config } from './config.ts'
import { sshMintJwt } from './commands/login.ts'
import type { ErrorResponse } from '../../src/types.ts'
export type { ErrorResponse, MessageResponse } from '../../src/types.ts'

interface RequestOptions {
  method: string
  path: string
  body?: unknown
}

interface ApiResponse<T = unknown> {
  status: number
  data: T | ErrorResponse
}

export function unwrap<T>(response: ApiResponse<T>, logError: (msg: string) => void): T {
  if (response.status === 401) {
    logError('session expired — run: zero login user@server')
    process.exit(1)
  }
  if (response.status >= 400) {
    logError((response.data as ErrorResponse)?.error ?? `HTTP ${response.status}`)
    process.exit(1)
  }
  return response.data as T
}

function request<T = unknown>(config: Config, opts: RequestOptions): Promise<ApiResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(config.host)
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`
    }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: opts.path,
        method: opts.method,
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString()
          let data: T | ErrorResponse | null = null
          try {
            data = raw ? JSON.parse(raw) : null
          } catch {
            data = { error: raw || `HTTP ${res.statusCode}` } as ErrorResponse
          }
          resolve({ status: res.statusCode ?? 0, data: data as T })
        })
      }
    )

    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
        reject(new Error('server unreachable'))
      } else {
        reject(err)
      }
    })

    if (opts.body !== undefined) {
      req.write(JSON.stringify(opts.body))
    }
    req.end()
  })
}

async function refreshToken(config: Config): Promise<boolean> {
  if (!config.ssh) return false
  const jwt = await sshMintJwt(config.ssh)
  if (!jwt) return false
  config.token = jwt
  saveConfig(config)
  return true
}

async function requestWithRefresh<T>(config: Config, opts: RequestOptions): Promise<ApiResponse<T>> {
  const res = await request<T>(config, opts)
  if (res.status !== 401) return res
  if (!(await refreshToken(config))) return res
  return request<T>(config, opts)
}

/** Shared client that loads config once per command */
function createClient() {
  const config = loadConfig()

  return {
    config,

    async get<T = unknown>(path: string) {
      return requestWithRefresh<T>(config, { method: 'GET', path })
    },

    async post<T = unknown>(path: string, body?: unknown) {
      return requestWithRefresh<T>(config, { method: 'POST', path, body })
    },

    async patch<T = unknown>(path: string, body?: unknown) {
      return requestWithRefresh<T>(config, { method: 'PATCH', path, body })
    },

    async del<T = unknown>(path: string, body?: unknown) {
      return requestWithRefresh<T>(config, { method: 'DELETE', path, body })
    },

    streamSSE(path: string, onData: (line: string) => void, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        const url = new URL(config.host)
        const isHttps = url.protocol === 'https:'
        const transport = isHttps ? https : http

        const req = transport.request(
          {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path,
            method: 'GET',
            headers: { Authorization: `Bearer ${config.token}` }
          },
          (res) => {
            if (res.statusCode !== 200) {
              const chunks: Buffer[] = []
              res.on('data', (c) => chunks.push(c))
              res.on('end', () => {
                const raw = Buffer.concat(chunks).toString()
                let message = raw
                try {
                  const parsed = JSON.parse(raw)
                  if (parsed.error) message = parsed.error
                } catch {}
                reject(new Error(message))
              })
              return
            }

            let buffer = ''
            res.on('data', (chunk: Buffer) => {
              buffer += chunk.toString()
              const lines = buffer.split('\n')
              buffer = lines.pop() ?? ''
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  onData(line.slice(6))
                }
              }
            })
            res.on('end', () => resolve())
          }
        )

        req.on('error', (err) => {
          if (signal?.aborted) resolve()
          else reject(err)
        })
        signal?.addEventListener('abort', () => {
          req.destroy()
          resolve()
        })
        req.end()
      })
    }
  }
}

export { createClient }
