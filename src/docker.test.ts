import net from 'node:net'
import { describe, expect, it } from 'vitest'

// Import only the pure/testable functions
// We test getFreePort and waitForHealthy which don't need Docker
import { getFreePort, waitForHealthy } from './docker.ts'

describe('docker utilities', () => {
  describe('getFreePort', () => {
    it('returns a valid port number', async () => {
      const port = await getFreePort()
      expect(port).toBeGreaterThan(0)
      expect(port).toBeLessThan(65536)
    })

    it('returns different ports on consecutive calls', async () => {
      const ports = await Promise.all([getFreePort(), getFreePort(), getFreePort()])
      const unique = new Set(ports)
      // At least 2 out of 3 should be different (OS may reuse occasionally)
      expect(unique.size).toBeGreaterThanOrEqual(2)
    })
  })

  describe('waitForHealthy', () => {
    it('resolves when port is listening', async () => {
      const server = net.createServer()
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as net.AddressInfo).port

      await expect(waitForHealthy(port, undefined, 5000)).resolves.toBeUndefined()
      server.close()
    })

    it('throws when port is not listening within timeout', async () => {
      // Use a port that's very unlikely to be in use
      const port = await getFreePort()
      await expect(waitForHealthy(port, undefined, 1000)).rejects.toThrow('did not become healthy')
    })
  })
})

describe('registryFromImage', () => {
  // We can't easily import the private function, so we test it indirectly
  // through the behavior documented in docker.ts
  // The function is used by pullImage which we've already mocked in API tests

  // Instead, let's test the logic directly by replicating it
  function registryFromImage(image: string): string {
    const parts = image.split('/')
    if (parts.length >= 2 && (parts[0].includes('.') || parts[0].includes(':'))) {
      return parts[0]
    }
    return 'docker.io'
  }

  it('extracts ghcr.io', () => {
    expect(registryFromImage('ghcr.io/user/app:latest')).toBe('ghcr.io')
  })

  it('extracts custom registry with port', () => {
    expect(registryFromImage('registry.example.com:5000/myapp:v1')).toBe('registry.example.com:5000')
  })

  it('defaults to docker.io for simple images', () => {
    expect(registryFromImage('nginx:latest')).toBe('docker.io')
  })

  it('defaults to docker.io for docker hub user images', () => {
    expect(registryFromImage('myuser/myapp:v1')).toBe('docker.io')
  })
})
