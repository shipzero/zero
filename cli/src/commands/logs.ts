import { createClient } from '../client.ts'
import { buildStreamPath, dim } from '../ui.ts'

function formatLogLine(line: string): string {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)/)
  if (match) {
    return `${dim(match[1])} ${match[2]}`
  }
  return line
}

export async function logs(positionals: string[], flags: Record<string, string | true>): Promise<void> {
  const target = buildStreamPath(positionals, flags, 'logs', 'server')
  const tail = flags['tail'] as string | undefined
  const path = tail ? `${target.path}?tail=${encodeURIComponent(tail)}` : target.path
  const client = createClient()

  process.on('SIGINT', () => {
    console.log(dim('\n[disconnected]'))
    process.exit(0)
  })

  let isFirst = true
  await client.streamSSE(path, (line) => {
    if (isFirst) {
      console.log(dim('ctrl+c to stop\n'))
      isFirst = false
    }
    console.log(formatLogLine(line))
  })
}
