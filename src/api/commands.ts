/**
 * The typed command layer: every TUI/argv action maps to exactly one MCP
 * tool call (plus caching). This is the file that keeps the UI honest about
 * what the server can do — nothing here invents data the tools don't return.
 */
import {
  CACHE_TTLS,
  cacheKey,
  cached,
  invalidate,
} from '../state/store.js'
import { createRpc, ReLoginRequired, ToolError, type Rpc } from './rpc.js'
import { bearer, forceRefresh, getSession } from './session.js'
import type {
  AnalyticsSnippetPayload,
  AnalyticsTotals,
  FixCardEntry,
  InsightsPayload,
  KeywordIdeasPayload,
  KeywordRanksPayload,
  PortfolioOverview,
  ProductStatus,
  ReadinessPayload,
  RescanResult,
  ScanHistoryEntry,
  SubscriptionSummary,
  WebsiteAnalyticsPayload,
} from './types.js'

export { ReLoginRequired, ToolError }

let rpc: Rpc | null = null

export async function getRpc(): Promise<Rpc> {
  const s = getSession()
  if (!s) throw new ReLoginRequired()
  rpc ??= await createRpc({
    apiBase: s.api,
    getAccessToken: bearer,
    forceRefresh,
  })
  return rpc
}

export async function resetRpc(): Promise<void> {
  await rpc?.close().catch(() => {})
  rpc = null
}

// ── Reads (cached) ─────────────────────────────────────────────────

export async function fetchSubscription(): Promise<SubscriptionSummary> {
  return cached(cacheKey(['subscription']), CACHE_TTLS.subscription, async () => {
    return (await (await getRpc()).call('get_my_subscription')) as SubscriptionSummary
  })
}

export type OverviewRange = 'lifetime' | 'today' | '7d' | '30d' | '90d'
export type OverviewSort = 'visitors' | 'views' | 'revenue' | 'conversions' | 'avgRevenue' | 'score' | 'performance' | 'recent'

export async function fetchOverview(range: OverviewRange = '7d', sortBy: OverviewSort = 'visitors'): Promise<PortfolioOverview> {
  const key = cacheKey(['overview', range, sortBy])
  return cached(key, CACHE_TTLS.portfolio, async () => {
    return (await (await getRpc()).call('compare_products', { range, sortBy, order: 'desc' })) as PortfolioOverview
  })
}

export async function fetchProductStatuses(): Promise<ProductStatus[]> {
  return cached(cacheKey(['statuses']), CACHE_TTLS.portfolio, async () => {
    const res = (await (await getRpc()).call('get_my_products_status')) as any
    return Array.isArray(res) ? res : res?.products ?? []
  })
}

/** The server's sentence for a product with no stored insights doc. */
export class NoInsightsYetError extends ToolError {}

export async function fetchInsights(productKey: string): Promise<InsightsPayload> {
  return cached(cacheKey(['insights', productKey]), CACHE_TTLS.insights, async () => {
    const res = await (await getRpc()).call('get_insights', { productKey })
    // A product with no stored insights gets the server's plain-text
    // sentence ("No insights yet — call trigger_rescan first.") — relay it
    // verbatim instead of rendering an empty block over a string. It is
    // singled out (vs every other refusal) because scan polling treats it
    // as "the doc will appear once the worker starts".
    if (typeof res === 'string') {
      if (/^No insights yet/i.test(res)) throw new NoInsightsYetError(res)
      throw new ToolError(res)
    }
    return res as InsightsPayload
  })
}

export async function fetchAnalytics(productKey: string, range: 'today' | '7d' | '30d' = '7d'): Promise<WebsiteAnalyticsPayload> {
  return cached(cacheKey(['analytics', productKey, range]), CACHE_TTLS.analytics, async () => {
    return (await (await getRpc()).call('get_website_analytics', { productKey, range })) as WebsiteAnalyticsPayload
  })
}

export async function fetchScanHistory(productKey: string): Promise<ScanHistoryEntry[]> {
  return cached(cacheKey(['history', productKey]), CACHE_TTLS.history, async () => {
    const res = (await (await getRpc()).call('get_scan_history', { productKey })) as any
    return Array.isArray(res) ? res : res?.history ?? res?.scans ?? []
  })
}

export async function fetchKeywordRanks(productKey: string): Promise<KeywordRanksPayload> {
  return cached(cacheKey(['ranks', productKey]), CACHE_TTLS.keywords, async () => {
    return (await (await getRpc()).call('get_keyword_ranks', { productKey })) as KeywordRanksPayload
  })
}

export async function fetchKeywordIdeas(productKey: string): Promise<KeywordIdeasPayload> {
  return cached(cacheKey(['ideas', productKey]), CACHE_TTLS.keywords, async () => {
    return (await (await getRpc()).call('get_keyword_ideas', { productKey })) as KeywordIdeasPayload
  })
}

export async function fetchFixCards(productKey: string): Promise<FixCardEntry[]> {
  return cached(cacheKey(['fixcards', productKey]), CACHE_TTLS.insights, async () => {
    const res = (await (await getRpc()).call('get_fix_cards', { productKey })) as any
    return Array.isArray(res) ? res : res?.cards ?? []
  })
}

export async function fetchSnippet(productKey: string): Promise<AnalyticsSnippetPayload> {
  return (await (await getRpc()).call('get_analytics_snippet', { productKey })) as AnalyticsSnippetPayload
}

export async function fetchReadiness(url: string): Promise<ReadinessPayload> {
  return (await (await getRpc()).call('check_launch_readiness', { url })) as ReadinessPayload
}

// ── Mutations (never cached) ───────────────────────────────────────

export async function triggerRescan(productKey: string): Promise<RescanResult> {
  invalidate(cacheKey(['insights', productKey]))
  invalidate(cacheKey(['history', productKey]))
  invalidate(cacheKey(['overview']))
  invalidate('subscription') // budget meters moved
  return (await (await getRpc()).call('trigger_rescan', { productKey })) as RescanResult
}

export async function setProductVisibility(productKey: string, makePublic: boolean): Promise<void> {
  await (await getRpc()).call(makePublic ? 'set_product_public' : 'set_product_private', { productKey })
  invalidate(cacheKey(['statuses']))
  invalidate(cacheKey(['overview']))
}

export async function runKeywordResearch(productKey: string, seed?: string): Promise<KeywordIdeasPayload> {
  invalidate(cacheKey(['ideas', productKey]))
  invalidate('subscription')
  return (await (await getRpc()).call('run_keyword_research', seed ? { productKey, seed } : { productKey })) as KeywordIdeasPayload
}

export async function addTrackedKeywords(productKey: string, keywords: string[]): Promise<any> {
  invalidate(cacheKey(['ranks', productKey]))
  return (await (await getRpc()).call('add_tracked_keywords', { productKey, keywords }))
}

export async function removeTrackedKeywords(productKey: string, keywords: string[]): Promise<any> {
  invalidate(cacheKey(['ranks', productKey]))
  return (await (await getRpc()).call('remove_tracked_keywords', { productKey, keywords }))
}

export async function addProduct(input: {
  url: string
  name?: string
  tagline?: string
  description?: string
  categories?: string[]
}): Promise<any> {
  invalidate(cacheKey(['statuses']))
  invalidate(cacheKey(['overview']))
  return (await (await getRpc()).call('add_product', input))
}

export async function setExcludedPages(productKey: string, paths: string[]): Promise<any> {
  return (await (await getRpc()).call('set_excluded_pages', { productKey, paths, confirm: true }))
}

// ── Scan waiting (the one polling loop) ────────────────────────────

export interface ScanWaitUpdate {
  pending: boolean
  insights?: InsightsPayload
}

/**
 * Poll get_insights until scanPending clears (the agent-scan pipeline keeps
 * only the boolean — no stage markers) or the deadline passes. Yields after
 * every poll so the UI can show progress honestly.
 */
export async function waitForScan(
  productKey: string,
  onUpdate: (update: ScanWaitUpdate) => void,
  opts: { intervalMs?: number; deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const interval = opts.intervalMs ?? 5_000
  const deadline = Date.now() + (opts.deadlineMs ?? 13 * 60_000)
  for (;;) {
    if (opts.signal?.aborted) return
    let pending: boolean
    let insights: InsightsPayload | undefined
    try {
      // Polling must read the wire, not the 60s insights cache.
      invalidate(cacheKey(['insights', productKey]))
      insights = await fetchInsights(productKey)
      pending = insights?.scanPending === true
    } catch (e) {
      // ONLY the never-scanned sentence means "the doc will appear" —
      // every other refusal (plan gate, rate limit, dead session, network)
      // is a real answer the caller must see immediately.
      if (e instanceof NoInsightsYetError) {
        pending = true
      } else {
        throw e
      }
    }
    onUpdate({ pending, insights })
    if (!pending) return
    if (Date.now() + interval > deadline) return // report honestly: still pending at deadline
    if (opts.signal?.aborted) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, interval)
      opts.signal?.addEventListener('abort', done)
    })
  }
}

/** The analytics totals shape used by the overview renderers. */
export type { AnalyticsTotals }
