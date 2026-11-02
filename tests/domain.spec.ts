/**
 * The one domain normalizer both doors share — the argv `report` command and
 * the TUI DomainInput. Pinned: scheme stripping, trailing-slash stripping,
 * and the rejection of anything that still cannot be a bare host.
 */
import { describe, expect, it } from 'vitest'
import { normalizeDomainArg } from '../src/lib/domain.js'

describe('normalizeDomainArg', () => {
  it('passes a bare host through untouched', () => {
    expect(normalizeDomainArg('example.com')).toBe('example.com')
    expect(normalizeDomainArg('  example.com  ')).toBe('example.com')
  })

  it('strips both schemes and trailing slashes', () => {
    expect(normalizeDomainArg('https://example.com')).toBe('example.com')
    expect(normalizeDomainArg('http://example.com')).toBe('example.com')
    expect(normalizeDomainArg('https://example.com/')).toBe('example.com')
    expect(normalizeDomainArg('HTTPS://EXAMPLE.com')).toBe('EXAMPLE.com')
  })

  it('rejects whitespace and paths instead of sending them as a key', () => {
    expect(normalizeDomainArg('example.com/pricing')).toBeNull()
    expect(normalizeDomainArg('exa mple.com')).toBeNull()
    expect(normalizeDomainArg('')).toBeNull()
    expect(normalizeDomainArg('   ')).toBeNull()
  })
})
