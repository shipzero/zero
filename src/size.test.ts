import { describe, it, expect } from 'vitest'
import { parseSize } from './size.ts'

describe('parseSize', () => {
  it('parses kilobytes', () => {
    expect(parseSize('512k')).toBe(524_288)
  })

  it('parses megabytes', () => {
    expect(parseSize('100m')).toBe(104_857_600)
  })

  it('parses gigabytes', () => {
    expect(parseSize('1g')).toBe(1_073_741_824)
  })

  it('parses combined sizes', () => {
    expect(parseSize('1g512m')).toBe(1_073_741_824 + 536_870_912)
  })

  it('is case insensitive', () => {
    expect(parseSize('100M')).toBe(104_857_600)
    expect(parseSize('1G')).toBe(1_073_741_824)
  })

  it('allows whitespace between value and unit', () => {
    expect(parseSize('100 m')).toBe(104_857_600)
  })

  it('throws on invalid input', () => {
    expect(() => parseSize('')).toThrow('Invalid size')
    expect(() => parseSize('abc')).toThrow('Invalid size')
    expect(() => parseSize('100')).toThrow('Invalid size')
  })
})
