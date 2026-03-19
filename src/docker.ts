import Dockerode from 'dockerode'
import http from 'node:http'
import net from 'node:net'
import { getRegistryAuth } from './state.ts'
import type { ContainerStats } from './types.ts'

export const docker = new Dockerode({ socketPath: '/var/run/docker.sock' })

/** Extracts the registry hostname from an image reference. */
function registryFromImage(image: string): string {
  const parts = image.split('/')
  if (parts.length >= 2 && (parts[0].includes('.') || parts[0].includes(':'))) {
    return parts[0]
  }
  return 'docker.io'
}

export async function pullImage(
  image: string,
  onProgress?: (status: string) => void
): Promise<void> {
  console.log(`[docker] pulling ${image}`)

  const auth = getRegistryAuth(registryFromImage(image))

  await new Promise<void>((resolve, reject) => {
    docker.pull(image, { authconfig: auth }, (err, stream) => {
      if (err) return reject(err)
      if (!stream) return reject(new Error('no stream from docker pull'))

      docker.modem.followProgress(
        stream,
        (err2) => (err2 ? reject(err2) : resolve()),
        (event: { status?: string; progress?: string }) => {
          const line = [event.status, event.progress].filter(Boolean).join(' ')
          if (line) onProgress?.(line)
        }
      )
    })
  })

  console.log(`[docker] pulled ${image}`)
}

export interface RunOpts {
  image: string
  appName: string
  internalPort: number
  hostPort: number
  env: Record<string, string>
  command?: string[]
  volumes?: string[]
}

export async function runContainer(opts: RunOpts): Promise<string> {
  const { image, appName, internalPort, hostPort, env, command, volumes } = opts

  const container = await docker.createContainer({
    Image: image,
    ...(command ? { Cmd: command } : {}),
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    Labels: { 'deploy.app': appName },
    HostConfig: {
      PortBindings: {
        [`${internalPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }]
      },
      Binds: volumes,
      RestartPolicy: { Name: 'unless-stopped' }
    },
    ExposedPorts: { [`${internalPort}/tcp`]: {} }
  })

  await container.start()
  console.log(`[docker] started ${appName} → 127.0.0.1:${hostPort} (container ${container.id.slice(0, 12)})`)
  return container.id
}

export async function startContainer(containerId: string): Promise<void> {
  const container = docker.getContainer(containerId)
  await container.start()
  console.log(`[docker] started ${containerId.slice(0, 12)}`)
}

function dockerStatusCode(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode
}

export async function stopContainer(containerId: string, gracefulMs = 30_000): Promise<void> {
  try {
    const container = docker.getContainer(containerId)
    await container.stop({ t: Math.floor(gracefulMs / 1000) })
    console.log(`[docker] stopped ${containerId.slice(0, 12)}`)
  } catch (err: unknown) {
    const code = dockerStatusCode(err)
    if (code !== 304 && code !== 404) throw err
  }
}

export async function removeContainer(containerId: string, gracefulMs = 30_000): Promise<void> {
  try {
    const container = docker.getContainer(containerId)
    await container.stop({ t: Math.floor(gracefulMs / 1000) })
    await container.remove()
    console.log(`[docker] stopped + removed ${containerId.slice(0, 12)}`)
  } catch (err: unknown) {
    const code = dockerStatusCode(err)
    if (code !== 304 && code !== 404) {
      console.warn(`[docker] remove warning: ${err instanceof Error ? err.message : err}`)
    }
  }
}

export async function tailLogs(containerId: string, tail = 50): Promise<string[]> {
  const container = docker.getContainer(containerId)
  const buffer = await container.logs({ follow: false, stdout: true, stderr: true, tail, timestamps: true }) as Buffer
  const lines: string[] = []
  let offset = 0
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) break
    const size = buffer.readUInt32BE(offset + 4)
    const line = buffer.subarray(offset + 8, offset + 8 + size).toString('utf8').trimEnd()
    if (line) lines.push(line)
    offset += 8 + size
  }
  return lines
}

export async function* streamLogs(containerId: string): AsyncGenerator<string> {
  const container = docker.getContainer(containerId)
  const logStream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail: 100,
    timestamps: true
  })

  for await (const chunk of logStream as AsyncIterable<Buffer>) {
    let offset = 0
    while (offset < chunk.length) {
      if (chunk.length - offset < 8) break
      const size = chunk.readUInt32BE(offset + 4)
      const line = chunk
        .subarray(offset + 8, offset + 8 + size)
        .toString('utf8')
        .trimEnd()
      if (line) yield line
      offset += 8 + size
    }
  }
}

export async function* streamStats(containerId: string): AsyncGenerator<ContainerStats> {
  const container = docker.getContainer(containerId)
  const statsStream = await container.stats({ stream: true })

  let prevCpu = 0
  let prevSystem = 0
  let prevRx = 0
  let prevTx = 0
  let isFirst = true

  let buffer = ''
  for await (const chunk of statsStream as AsyncIterable<Buffer>) {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      const raw = JSON.parse(line)

      const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - prevCpu
      const systemDelta = raw.cpu_stats.system_cpu_usage - prevSystem
      const numCpus = raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1
      const cpu = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0

      const memory = raw.memory_stats.usage ?? 0
      const memoryLimit = raw.memory_stats.limit ?? 0

      let totalRx = 0
      let totalTx = 0
      if (raw.networks) {
        for (const iface of Object.values(raw.networks) as { rx_bytes: number; tx_bytes: number }[]) {
          totalRx += iface.rx_bytes
          totalTx += iface.tx_bytes
        }
      }

      const networkRx = totalRx - prevRx
      const networkTx = totalTx - prevTx

      prevCpu = raw.cpu_stats.cpu_usage.total_usage
      prevSystem = raw.cpu_stats.system_cpu_usage
      prevRx = totalRx
      prevTx = totalTx

      if (isFirst) {
        isFirst = false
        continue
      }

      yield { cpu, memory, memoryLimit, networkRx, networkTx }
    }
  }
}

export async function waitForHealthy(port: number, healthPath?: string, timeoutMs = 60_000, containerId?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const check = healthPath ? () => httpCheck(port, healthPath) : () => tcpCheck(port)
  const initialRestartCount = containerId ? await getRestartCount(containerId) : 0
  while (Date.now() < deadline) {
    if (containerId) {
      const state = await getContainerState(containerId)
      if (!state.running) throw new Error('container exited during health check')
      if (state.restartCount > initialRestartCount) throw new Error('container is crash-looping')
    }
    if (await check()) return
    await sleep(500)
  }
  throw new Error(`Container on port ${port} did not become healthy within ${timeoutMs}ms`)
}

export async function getContainerState(containerId: string): Promise<{ running: boolean; restartCount: number }> {
  try {
    const info = await docker.getContainer(containerId).inspect()
    return { running: info.State.Running, restartCount: info.RestartCount }
  } catch {
    return { running: false, restartCount: 0 }
  }
}

async function getRestartCount(containerId: string): Promise<number> {
  const state = await getContainerState(containerId)
  return state.restartCount
}

function tcpCheck(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(500, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function httpCheck(port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no address'))
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
