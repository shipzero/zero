const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
}

/** Parses a duration string like "3m", "2h", "7d6h" into milliseconds. */
export function parseDuration(input: string): number {
  const matches = input.matchAll(/(\d+)\s*([smhd])/g)
  let total = 0
  let matched = false
  for (const [, value, unit] of matches) {
    total += Number(value) * UNITS[unit]
    matched = true
  }
  if (!matched) throw new Error(`invalid duration "${input}" — use e.g. 30s, 5m, 2h, 7d`)
  return total
}
