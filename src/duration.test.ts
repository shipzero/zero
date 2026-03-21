import { describe, it, expect } from 'vitest'
import { parseDuration } from './duration.ts'

describe('parseDuration', () => {
  it('parses seconds', () => {
    expect(parseDuration('30s')).toBe(30_000)
  })

  it('parses minutes', () => {
    expect(parseDuration('5m')).toBe(300_000)
  })

  it('parses hours', () => {
    expect(parseDuration('2h')).toBe(7_200_000)
  })

  it('parses days', () => {
    expect(parseDuration('7d')).toBe(604_800_000)
  })

  it('parses combined durations', () => {
    expect(parseDuration('1d12h')).toBe(129_600_000)
    expect(parseDuration('2h30m')).toBe(9_000_000)
    expect(parseDuration('1h30m15s')).toBe(5_415_000)
  })

  it('allows whitespace between value and unit', () => {
    expect(parseDuration('30 s')).toBe(30_000)
  })

  it('throws on invalid input', () => {
    expect(() => parseDuration('')).toThrow('invalid duration')
    expect(() => parseDuration('abc')).toThrow('invalid duration')
    expect(() => parseDuration('100')).toThrow('invalid duration')
  })
})
