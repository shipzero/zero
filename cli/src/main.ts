#!/usr/bin/env bun
import { login } from './commands/login.ts'
import { add } from './commands/add.ts'
import { ls } from './commands/ls.ts'
import { deploy } from './commands/deploy.ts'
import { logs } from './commands/logs.ts'
import { rollback } from './commands/rollback.ts'
import { deployments } from './commands/deployments.ts'
import { env } from './commands/env.ts'
import { rm } from './commands/rm.ts'
import { stop } from './commands/stop.ts'
import { start } from './commands/start.ts'
import { status } from './commands/status.ts'
import { registry } from './commands/registry.ts'
import { upgrade } from './commands/upgrade.ts'
import { webhook } from './commands/webhook.ts'
import { VERSION } from './version.ts'
import { bold, cyan, dim, logInfo, logError } from './ui.ts'

interface ParsedArgs {
  command: string
  subcommand: string | null
  positionals: string[]
  flags: Record<string, string | true>
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  const command = args[0] ?? 'help'
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}

  let subcommand: string | null = null
  let isFirstPositional = true

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=')
      if (equalsIndex !== -1) {
        flags[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1)
      } else {
        const next = args[i + 1]
        if (next && !next.startsWith('--')) {
          flags[arg.slice(2)] = next
          i++
        } else {
          flags[arg.slice(2)] = true
        }
      }
    } else if (isFirstPositional && (command === 'env' || command === 'registry' || command === 'webhook')) {
      subcommand = arg
      isFirstPositional = false
    } else {
      positionals.push(arg)
      isFirstPositional = false
    }
  }

  return { command, subcommand, positionals, flags }
}

function formatHelp(): string {
  const commands = [
    ['add --name --image [--domain] [--port] [--host-port] [--command] [--volume] [--health-path]', 'Add a new app'],
    ['deploy <app> [--tag <tag>]', 'Trigger deployment'],
    ['deployments <app>', 'Show deployment history'],
    ['env ls <app>', 'List environment variables'],
    ['env rm <app> KEY [KEY ...]', 'Remove environment variables'],
    ['env set <app> KEY=val [KEY=val ...]', 'Set environment variables'],
    ['login <host> <token>', 'Save server credentials'],
    ['logs <app> | --server', 'Stream app or server logs'],
    ['ls', 'List all apps'],
    ['registry login <server> --user --password', 'Add registry credentials'],
    ['registry logout <server>', 'Remove registry credentials'],
    ['registry ls', 'List configured registries'],
    ['rm <app> [--force]', 'Remove an app and its containers'],
    ['rollback <app> [--force]', 'Roll back to previous deployment'],
    ['start <app>', 'Start a stopped container'],
    ['status', 'Show server connection and info'],
    ['stop <app> [--force]', 'Stop running container'],
    ['upgrade [--server] [--all] [--force]', 'Upgrade CLI and/or server'],
    ['version', 'Show CLI and server version'],
    ['webhook reset <app>', 'Reset webhook secret and show new URL']
  ]

  const maxCmd = Math.max(...commands.map(([cmd]) => cmd.length))
  const lines = commands.map(([cmd, desc]) => `  ${cyan(cmd.padEnd(maxCmd))}  ${dim(desc)}`)

  return [
    bold('zero') + ' — self-hosted deployment platform',
    '',
    `usage: ${cyan('zero <command>')} [options]`,
    '',
    'Commands:',
    ...lines
  ].join('\n')
}

async function main() {
  const parsed = parseArgs(process.argv)

  try {
    switch (parsed.command) {
      case 'add':
        await add(parsed.flags)
        break
      case 'deploy':
        await deploy(parsed.positionals, parsed.flags)
        break
      case 'deployments':
        await deployments(parsed.positionals)
        break
      case 'env':
        await env(parsed.subcommand, parsed.positionals, parsed.flags)
        break
      case 'help':
      case '--help':
      case '-h':
        console.log(formatHelp())
        break
      case 'login':
        await login(parsed.positionals, parsed.flags)
        break
      case 'logs':
        await logs(parsed.positionals, parsed.flags)
        break
      case 'ls':
        await ls()
        break
      case 'registry':
        await registry(parsed.subcommand, parsed.positionals, parsed.flags)
        break
      case 'rm':
        await rm(parsed.positionals, parsed.flags)
        break
      case 'rollback':
        await rollback(parsed.positionals, parsed.flags)
        break
      case 'start':
        await start(parsed.positionals)
        break
      case 'status':
        await status()
        break
      case 'stop':
        await stop(parsed.positionals, parsed.flags)
        break
      case 'upgrade':
        await upgrade(parsed.flags)
        break
      case 'webhook':
        await webhook(parsed.subcommand, parsed.positionals)
        break
      case 'version':
      case '--version':
      case '-v': {
        logInfo(`cli: ${VERSION}`)
        try {
          const { createClient } = await import('./client.ts')
          const client = createClient()
          const { data } = await client.get<{ version: string }>('/version')
          logInfo(`server: ${'version' in data ? data.version : 'unknown'}`)
        } catch {
          logInfo('server: not connected')
        }
        break
      }
      default:
        logError(`unknown command: ${parsed.command}`)
        console.log(formatHelp())
        process.exit(1)
    }
  } catch (err) {
    logError(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
