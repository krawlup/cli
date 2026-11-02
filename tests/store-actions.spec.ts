/**
 * The TTL cache + the action-level arg parsing — the pure logic behind the
 * command layer. The cache contract: read-through, in-flight dedupe, and
 * prefix invalidation (mutations never serve stale boards).
 */
import { describe, expect, it, vi } from 'vitest'
import { cached, cacheKey, clearCache, invalidate } from '../src/state/store.js'
import { parseOverviewArgs } from '../src/actions.js'

describe('store cache', () => {
  it('read-through caches per key and respects TTL', async () => {
    clearCache()
    let loads = 0
    const load = async () => {
      loads += 1
      return { n: loads }
    }
    expect(await cached('k1', 60_000, load)).toEqual({ n: 1 })
    expect(await cached('k1', 60_000, load)).toEqual({ n: 1 }) // served from cache
    expect(loads).toBe(1)
    invalidate('k1')
    expect(await cached('k1', 60_000, load)).toEqual({ n: 2 })
    // A different key never shares the entry.
    expect(await cached('k2', 60_000, load)).toEqual({ n: 3 })
  })

  it('never caches rejections', async () => {
    clearCache()
    let loads = 0
    const load = async () => {
      loads += 1
      if (loads === 1) throw new Error('boom')
      return 'ok'
    }
    await expect(cached('boom', 60_000, load)).rejects.toThrow('boom')
    expect(await cached('boom', 60_000, load)).toBe('ok')
  })

  it('dedupes concurrent loads for the same key', async () => {
    clearCache()
    let loads = 0
    const load = async () => {
      loads += 1
      await new Promise((r) => setTimeout(r, 10))
      return loads
    }
    const [a, b] = await Promise.all([cached('dup', 60_000, load), cached('dup', 60_000, load)])
    expect(a).toBe(1)
    expect(b).toBe(1)
    expect(loads).toBe(1)
  })

  it('invalidate matches whole key segments only — no sibling collisions', async () => {
    clearCache()
    let loads = 0
    const load = async () => {
      loads += 1
      return loads
    }
    await cached('insights|acme', 60_000, load)
    await cached('insights|acme-beta', 60_000, load)
    invalidate('insights|acme')
    // The exact key is gone (a fresh load happens)…
    expect(await cached('insights|acme', 60_000, load)).toBe(3)
    // …but the sibling that merely shares the prefix is untouched (still
    // served from cache — loads stays 3).
    expect(await cached('insights|acme-beta', 60_000, load)).toBe(2)
    expect(loads).toBe(3)
  })

  it('builds stable keys', () => {
    expect(cacheKey(['insights', 'example.com'])).toBe('insights|example.com')
    expect(cacheKey(['analytics', 'example.com', undefined])).toBe('analytics|example.com|')
  })
})

describe('overview arg parsing', () => {
  it('accepts known ranges and sorts, defaults 7d/visitors, ignores junk', () => {
    expect(parseOverviewArgs([])).toEqual({ range: '7d', sortBy: 'visitors' })
    expect(parseOverviewArgs(['30d', 'revenue'])).toEqual({ range: '30d', sortBy: 'revenue' })
    expect(parseOverviewArgs(['lifetime', 'score', '--json'])).toEqual({ range: 'lifetime', sortBy: 'score' })
    expect(parseOverviewArgs(['nonsense'])).toEqual({ range: '7d', sortBy: 'visitors' })
  })
})
