/**
 * The app store: a tiny framework-agnostic pub/sub + a TTL cache for tool
 * payloads. React binds through useSyncExternalStore; the cache keeps the
 * 60/min-per-key MCP budget untrampled (switching tabs re-reads memory, not
 * the wire).
 */

type Listener = () => void

export class Store<T> {
  private listeners = new Set<Listener>()
  constructor(private value: T) {}

  get(): T {
    return this.value
  }

  set(v: T): void {
    this.value = v
    for (const l of [...this.listeners]) l()
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

interface CacheEntry {
  at: number
  value: any
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<any>>()

/** A long session must not accumulate payloads without bound. */
const CACHE_MAX_ENTRIES = 500

export const CACHE_TTLS = {
  insights: 60_000,
  analytics: 60_000,
  keywords: 5 * 60_000,
  subscription: 10 * 60_000,
  portfolio: 60_000,
  history: 5 * 60_000,
} as const

/** Read-through TTL cache with in-flight dedupe. Never caches rejections. */
export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T
  const pending = inflight.get(key)
  if (pending) return pending as Promise<T>
  const p = loader()
    .then((value) => {
      storeCached(key, { at: Date.now(), value })
      inflight.delete(key)
      return value
    })
    .catch((e) => {
      inflight.delete(key)
      throw e
    })
  inflight.set(key, p)
  return p
}

function storeCached(key: string, entry: CacheEntry): void {
  // Opportunistic sweep of expired entries, then FIFO eviction of the
  // oldest survivors when still over the cap (Map iteration = insert order).
  const now = Date.now()
  for (const [k, v] of cache) {
    if (now - v.at >= CACHE_TTLS.subscription) cache.delete(k)
  }
  while (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  cache.set(key, entry)
}

export function invalidate(prefix: string): void {
  for (const key of [...cache.keys()]) {
    // Exact match, or a full-segment prefix — 'insights|acme' must not
    // evict 'insights|acme-beta'.
    if (key === prefix || key.startsWith(`${prefix}|`)) cache.delete(key)
  }
}

export function clearCache(): void {
  cache.clear()
}

/** Deterministic JSON cache keys without a dependency. */
export function cacheKey(parts: Array<string | number | undefined | null>): string {
  return parts.map((p) => (p == null ? '' : String(p))).join('|')
}
