const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const BLUE = '\x1b[34m'
const CYAN = '\x1b[36m'

const isColorEnabled = !process.env['NO_COLOR'] && process.stdout.isTTY

function wrap(code: string, text: string): string {
  return isColorEnabled ? `${code}${text}${RESET}` : text
}

export function bold(text: string): string {
  return wrap(BOLD, text)
}

export function dim(text: string): string {
  return wrap(DIM, text)
}

export function red(text: string): string {
  return wrap(RED, text)
}

export function green(text: string): string {
  return wrap(GREEN, text)
}

export function yellow(text: string): string {
  return wrap(YELLOW, text)
}

export function blue(text: string): string {
  return wrap(BLUE, text)
}

export function cyan(text: string): string {
  return wrap(CYAN, text)
}

export function logSuccess(message: string): void {
  console.log(`${green('✓')} ${message}`)
}

export function logInfo(message: string): void {
  console.log(`${blue('ℹ')} ${message}`)
}

export function logError(message: string): void {
  console.error(`${red('✗')} ${message}`)
}

export function logWarn(message: string): void {
  console.log(`${yellow('!')} ${message}`)
}

export function logHint(message: string): void {
  console.log(`  ${dim(message)}`)
}

export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true
  process.stdout.write(`${yellow('?')} ${message} ${dim('[y/N]')} `)
  return new Promise((resolve) => {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.once('data', (data) => {
      const char = data.toString().trim().toLowerCase()
      process.stdin.setRawMode(false)
      process.stdin.pause()
      console.log(char || 'n')
      resolve(char === 'y')
    })
  })
}
