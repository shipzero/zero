import { createClient } from '../client.ts'
import { bold, dim, cyan, yellow, green, red, logError } from '../ui.ts'
import type { ContainerStats } from '../../../src/types.ts'

const BAR_WIDTH = 20

function barColor(ratio: number): (text: string) => string {
  if (ratio > 0.9) return red
  if (ratio > 0.7) return yellow
  return green
}

function progressBar(ratio: number): string {
  const clamped = Math.min(Math.max(ratio, 0), 1)
  const filled = Math.round(clamped * BAR_WIDTH)
  const color = barColor(clamped)
  return color('█'.repeat(filled)) + dim('░'.repeat(BAR_WIDTH - filled))
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function renderStats(label: string, stats: ContainerStats, isFirst: boolean): void {
  const cpuRatio = Math.min(stats.cpu / 100, 1)
  const memRatio = stats.memoryLimit > 0 ? stats.memory / stats.memoryLimit : 0

  const lines = [
    bold(label),
    '',
    `  ${cyan('cpu')}     ${progressBar(cpuRatio)}  ${bold(stats.cpu.toFixed(1) + '%')}`,
    `  ${cyan('memory')}  ${progressBar(memRatio)}  ${bold(formatBytes(stats.memory))} ${dim('/')} ${formatBytes(stats.memoryLimit)} ${dim(`(${(memRatio * 100).toFixed(1)}%)`)}`,
    `  ${cyan('net ↓')}   ${bold(formatBytes(stats.networkRx) + '/s')}`,
    `  ${cyan('net ↑')}   ${bold(formatBytes(stats.networkTx) + '/s')}`,
    '',
    dim('  ctrl+c to stop')
  ]

  if (!isFirst) {
    process.stdout.write(`\x1b[${lines.length}A`)
  }

  for (const line of lines) {
    process.stdout.write(`\x1b[2K${line}\n`)
  }
}

function buildPath(
  positionals: string[],
  flags: Record<string, string | true>
): { path: string; label: string } | null {
  const isServer = flags['server'] === true
  const appName = positionals[0]
  const previewLabel = flags['preview'] as string | undefined

  if (isServer) return { path: '/metrics', label: 'zero' }

  if (!appName) {
    logError('usage: zero metrics <app> [--preview <label>]')
    logError('       zero metrics --server')
    process.exit(1)
  }

  const encodedApp = encodeURIComponent(appName)
  if (previewLabel) {
    const encodedLabel = encodeURIComponent(previewLabel)
    return { path: `/apps/${encodedApp}/previews/${encodedLabel}/metrics`, label: `${appName}/${previewLabel}` }
  }

  return { path: `/apps/${encodedApp}/metrics`, label: appName }
}

export async function metrics(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const target = buildPath(positionals, flags)
  if (!target) return

  const client = createClient()

  process.on('SIGINT', () => {
    console.log(dim('\n[disconnected]'))
    process.exit(0)
  })

  let isFirst = true
  await client.streamSSE(target.path, (line) => {
    const stats: ContainerStats = JSON.parse(line)
    renderStats(target.label, stats, isFirst)
    isFirst = false
  })
}
