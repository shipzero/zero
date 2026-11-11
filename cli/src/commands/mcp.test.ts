import { describe, expect, it } from 'vitest'
import { defaultEntryName } from './mcp.ts'

describe('defaultEntryName', () => {
  it('prefixes the directory name', () => {
    expect(defaultEntryName('/home/me/shop')).toBe('zero-shop')
  })

  it('keeps a name that already carries the prefix', () => {
    expect(defaultEntryName('/home/me/zero-staging')).toBe('zero-staging')
  })

  it('falls back to zero for the repo itself and for names without usable characters', () => {
    expect(defaultEntryName('/home/me/zero')).toBe('zero')
    expect(defaultEntryName('/home/me/___')).toBe('zero')
  })

  it('lowercases, replaces other characters and strips dashes at both ends', () => {
    expect(defaultEntryName('/home/me/My Shop (v2)')).toBe('zero-my-shop-v2')
    expect(defaultEntryName('/home/me/--edge--')).toBe('zero-edge')
  })
})
