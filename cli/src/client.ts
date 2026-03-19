import http from 'node:http'
import https from 'node:https'
import { loadConfig, type Config } from './config.ts'
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
      'Authorization': `Bearer ${config.token}`,
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
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString()
          const data = raw ? JSON.parse(raw) : null
          resolve({ status: res.statusCode ?? 0, data: data as T })
        })
      },
    )

    req.on('error', reject)

    if (opts.body !== undefined) {
      req.write(JSON.stringify(opts.body))
    }
    req.end()
  })
}

/** Shared client that loads config once per command */
function createClient() {
  const config = loadConfig()

  return {
    config,

    async get<T = unknown>(path: string) {
      return request<T>(config, { method: 'GET', path })
    },

    async post<T = unknown>(path: string, body?: unknown) {
      return request<T>(config, { method: 'POST', path, body })
    },

    async patch<T = unknown>(path: string, body?: unknown) {
      return request<T>(config, { method: 'PATCH', path, body })
    },

    async del<T = unknown>(path: string, body?: unknown) {
      return request<T>(config, { method: 'DELETE', path, body })
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
            headers: { 'Authorization': `Bearer ${config.token}` },
          },
          (res) => {
            if (res.statusCode !== 200) {
              const chunks: Buffer[] = []
              res.on('data', (c) => chunks.push(c))
              res.on('end', () => {
                const raw = Buffer.concat(chunks).toString()
                reject(new Error(`HTTP ${res.statusCode}: ${raw}`))
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
          },
        )

        req.on('error', (err) => {
          if (signal?.aborted) resolve()
          else reject(err)
        })
        signal?.addEventListener('abort', () => { req.destroy(); resolve() })
        req.end()
      })
    },
  }
}

export { createClient }
