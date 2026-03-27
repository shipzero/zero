/**
 * Parses a `KEY=value` string into a tuple.
 * Returns `null` if the string doesn't contain `=`.
 */
export function parseEnvPair(pair: string): [key: string, value: string] | null {
  const equalsIndex = pair.indexOf('=')
  if (equalsIndex === -1) return null
  return [pair.slice(0, equalsIndex), pair.slice(equalsIndex + 1)]
}
