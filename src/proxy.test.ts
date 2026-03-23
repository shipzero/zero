import { describe, it, expect } from 'vitest'
import http from 'node:http'
import net from 'node:net'

// Don't load ACME module
process.env.EMAIL = ''
// Use port 0 so each startDevProxy gets a free port
process.env.DEV_PORT = '0'

import { vi } from 'vitest'
vi.mock('./certs.ts', () => ({
  getCachedCert: vi.fn().mockReturnValue(undefined),
  loadCachedCert: vi.fn().mockReturnValue(null),
  obtainCert: vi.fn().mockRejectedValue(new Error('No cert')),
  handleAcmeChallenge: vi.fn().mockReturnValue(false),
  isTLSEnabled: vi.fn().mockReturnValue(false)
}))

const { updateProxyRoute, removeProxyRoute, startDevProxy, restoreRoutes } = await import('./proxy.ts')

function makeRequest(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        headers: { Host: host }
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, body: data }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

describe('proxy route management', () => {
  it('forwards HTTP traffic to the correct backend port', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('hello from upstream')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as net.AddressInfo).port

    const proxy = startDevProxy()
    await new Promise<void>((resolve) => {
      if (proxy.listening) return resolve()
      proxy.on('listening', resolve)
    })
    const proxyPort = (proxy.address() as net.AddressInfo).port

    updateProxyRoute('test.local', upstreamPort)

    const res = await makeRequest(proxyPort, 'test.local')
    expect(res.status).toBe(200)
    expect(res.body).toBe('hello from upstream')

    removeProxyRoute('test.local')
    proxy.close()
    upstream.close()
  })

  it('returns 502 when no route exists for host', async () => {
    const proxy = startDevProxy()
    await new Promise<void>((resolve) => {
      if (proxy.listening) return resolve()
      proxy.on('listening', resolve)
    })
    const proxyPort = (proxy.address() as net.AddressInfo).port

    const res = await makeRequest(proxyPort, 'unknown.local')
    expect(res.status).toBe(502)
    expect(res.body).toContain('Bad gateway')

    proxy.close()
  })

  it('restoreRoutes handles apps without previews field', () => {
    const apps = [{ domain: 'old.local', deployments: [{ port: 3000 }], previews: undefined as any }]
    expect(() => restoreRoutes(apps)).not.toThrow()
  })

  it('removeProxyRoute stops forwarding', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamPort = (upstream.address() as net.AddressInfo).port

    const proxy = startDevProxy()
    await new Promise<void>((resolve) => {
      if (proxy.listening) return resolve()
      proxy.on('listening', resolve)
    })
    const proxyPort = (proxy.address() as net.AddressInfo).port

    updateProxyRoute('remove.local', upstreamPort)
    removeProxyRoute('remove.local')

    const res = await makeRequest(proxyPort, 'remove.local')
    expect(res.status).toBe(502)

    proxy.close()
    upstream.close()
  })
})
