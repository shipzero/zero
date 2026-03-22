const UNITS: Record<string, number> = {
  k: 1_024,
  m: 1_024 * 1_024,
  g: 1_024 * 1_024 * 1_024
}

/** Parses a size string like "100m", "1g", "512k" into bytes. */
export function parseSize(input: string): number {
  const matches = input.matchAll(/(\d+)\s*([kmg])/gi)
  let total = 0
  let matched = false
  for (const [, value, unit] of matches) {
    total += Number(value) * UNITS[unit.toLowerCase()]
    matched = true
  }
  if (!matched) throw new Error(`invalid size "${input}" — use e.g. 512k, 100m, 1g`)
  return total
}
