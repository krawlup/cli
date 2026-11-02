/**
 * Actions: the async layer between a command and its renderable result.
 * Both the interactive TUI and the non-TTY argv mode run these — the TUI
 * pushes the returned blocks into its history, argv renders them once.
 * Every server refusal (ToolError) propagates verbatim to the renderer.
 */
import * as api from './api/commands.js'
import { runPublicScan, type PublicReportPayload, type PublicScanState } from './api/public-scan.js'
import { scanConfig } from './state/scan-config.js'
import type {
  AnalyticsSnippetPayload,
  FixCardEntry,
  InsightsPayload,
  KeywordIdeasPayload,
  KeywordRanksPayload,
  PortfolioOverview,
  ProductStatus,
  ScanHistoryEntry,
  SubscriptionSummary,
  WebsiteAnalyticsPayload,
} from './api/types.js'
import type { OverviewRange, OverviewSort } from './api/commands.js'

export type ActionResult =
  | { kind: 'text'; text: string }
  | { kind: 'overview'; overview: PortfolioOverview }
  | { kind: 'products'; statuses: ProductStatus[] }
  | { kind: 'subscription'; subscription: SubscriptionSummary }
  | { kind: 'insights'; productKey: string; insights: InsightsPayload; fixCards?: FixCardEntry[]; fixCardsNote?: string }
  | { kind: 'analytics'; productKey: string; analytics: WebsiteAnalyticsPayload }
  | { kind: 'keywords'; productKey: string; ranks: KeywordRanksPayload; ideas?: KeywordIdeasPayload }
  | { kind: 'history'; productKey: string; entries: ScanHistoryEntry[] }
  | { kind: 'snippet'; productKey: string; snippet: AnalyticsSnippetPayload }
  | { kind: 'scan-started'; productKey: string; fullAnalysesLeft?: number | null; pageSpeedChecksLeft?: number | null }
  | { kind: 'public-report'; domain: string; report: PublicReportPayload }
  | { kind: 'scan-update'; productKey: string; note: string }
  | { kind: 'added'; result: any }
  | { kind: 'visibility'; productKey: string; nowPublic: boolean }
  | { kind: 'excluded'; productKey: string; paths: string[] }

const OVERVIEW_RANGES: OverviewRange[] = ['lifetime', 'today', '7d', '30d', '90d']
const OVERVIEW_SORTS: OverviewSort[] = ['visitors', 'views', 'revenue', 'conversions', 'avgRevenue', 'score', 'performance', 'recent']

export function parseOverviewArgs(args: string[]): { range: OverviewRange; sortBy: OverviewSort } {
  const range = (args.find((a) => OVERVIEW_RANGES.includes(a as OverviewRange)) ?? '7d') as OverviewRange
  const sortBy = (args.find((a) => OVERVIEW_SORTS.includes(a as OverviewSort)) ?? 'visitors') as OverviewSort
  return { range, sortBy }
}

/** Fuzzy product resolution: exact key → exact title → prefix → substring. */
export async function resolveProduct(query: string): Promise<ProductStatus | null> {
  const statuses = await api.fetchProductStatuses()
  const q = query.trim().toLowerCase()
  if (!q) return null
  const exactKey = statuses.find((p) => p.productKey.toLowerCase() === q)
  if (exactKey) return exactKey
  const exactTitle = statuses.find((p) => (p.title || '').toLowerCase() === q)
  if (exactTitle) return exactTitle
  const prefix = statuses.find((p) => p.productKey.toLowerCase().startsWith(q) || (p.title || '').toLowerCase().startsWith(q))
  if (prefix) return prefix
  return statuses.find((p) => p.productKey.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q)) ?? null
}

export async function overviewAction(args: string[]): Promise<ActionResult> {
  const { range, sortBy } = parseOverviewArgs(args)
  return { kind: 'overview', overview: await api.fetchOverview(range, sortBy) }
}

export async function productsAction(): Promise<ActionResult> {
  return { kind: 'products', statuses: await api.fetchProductStatuses() }
}

export async function subscriptionAction(): Promise<ActionResult> {
  return { kind: 'subscription', subscription: await api.fetchSubscription() }
}

export async function insightsAction(product: ProductStatus): Promise<ActionResult> {
  const insights = await api.fetchInsights(product.productKey)
  let fixCards: FixCardEntry[] | undefined
  if (Array.isArray(insights.unresolvedCards) && insights.unresolvedCards.length) {
    // The summary truncates agentPrompt; the full cards come from the
    // facility-gated tool — best effort, the summary data still renders.
    fixCards = insights.unresolvedCards
  }
  return {
    kind: 'insights',
    productKey: product.productKey,
    insights,
    fixCards,
    fixCardsNote: insights.fixCardsNote,
  }
}

export async function analyticsAction(product: ProductStatus, range: 'today' | '7d' | '30d' = '7d'): Promise<ActionResult> {
  return { kind: 'analytics', productKey: product.productKey, analytics: await api.fetchAnalytics(product.productKey, range) }
}

export async function keywordsAction(product: ProductStatus, withIdeas: boolean): Promise<ActionResult> {
  const ranks = await api.fetchKeywordRanks(product.productKey)
  const ideas = withIdeas ? await api.fetchKeywordIdeas(product.productKey).catch(() => undefined) : undefined
  return { kind: 'keywords', productKey: product.productKey, ranks, ideas }
}

export async function historyAction(product: ProductStatus): Promise<ActionResult> {
  return { kind: 'history', productKey: product.productKey, entries: await api.fetchScanHistory(product.productKey) }
}

export async function snippetAction(product: ProductStatus): Promise<ActionResult> {
  return { kind: 'snippet', productKey: product.productKey, snippet: await api.fetchSnippet(product.productKey) }
}

/** Trigger a rescan; onWait streams the honest poll state (boolean pending). */
export async function scanAction(
  product: ProductStatus,
  onWait?: (update: api.ScanWaitUpdate) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<ActionResult> {
  const result = await api.triggerRescan(product.productKey)
  const started: ActionResult = {
    kind: 'scan-started',
    productKey: product.productKey,
    fullAnalysesLeft: result.fullAnalysesLeft,
    pageSpeedChecksLeft: result.pageSpeedChecksLeft,
  }
  if (!onWait) return started
  onWait({ pending: true })
  await api.waitForScan(product.productKey, onWait, opts)
  return started
}

/**
 * The free site report over the server's own public endpoints (device-keyed,
 * no login — see api/public-scan.ts). `onWait` streams the live stage
 * snapshot; the resolver only returns once the report is actually stored.
 */
export async function publicReportAction(
  domain: string,
  onWait?: (state: PublicScanState) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<ActionResult> {
  // The fetched allowance rides along so a quota refusal quotes the number in
  // force (an admin can zero the CLI pool), not a baked-in "one free scan".
  const report = await runPublicScan(domain, (state) => onWait?.(state), {
    ...opts,
    config: scanConfig.get(),
  })
  return { kind: 'public-report', domain, report }
}

export async function addAction(url: string): Promise<ActionResult> {
  const readiness = await api.fetchReadiness(url)
  if (!readiness.ready) {
    const issues = (readiness.issues || []).map((i) => `  • ${i.message || JSON.stringify(i)}`).join('\n')
    return { kind: 'text', text: `not ready to add yet:\n${issues || readiness.note || 'the readiness check failed'}` }
  }
  const result = await api.addProduct({ url })
  return { kind: 'added', result }
}

export async function visibilityAction(product: ProductStatus, makePublic: boolean): Promise<ActionResult> {
  await api.setProductVisibility(product.productKey, makePublic)
  return { kind: 'visibility', productKey: product.productKey, nowPublic: makePublic }
}

export async function excludeAction(product: ProductStatus, paths: string[]): Promise<ActionResult> {
  await api.setExcludedPages(product.productKey, paths)
  return { kind: 'excluded', productKey: product.productKey, paths }
}

/** `/research <product> [seed]` — spends a monthly run; the caller confirms. */
export async function researchAction(product: ProductStatus, seed?: string): Promise<ActionResult> {
  const ideas = await api.runKeywordResearch(product.productKey, seed)
  const ranks = await api.fetchKeywordRanks(product.productKey)
  return { kind: 'keywords', productKey: product.productKey, ranks, ideas }
}

export async function trackAction(product: ProductStatus, keywords: string[], remove: boolean): Promise<ActionResult> {
  if (remove) await api.removeTrackedKeywords(product.productKey, keywords)
  else await api.addTrackedKeywords(product.productKey, keywords)
  const ranks = await api.fetchKeywordRanks(product.productKey)
  return { kind: 'keywords', productKey: product.productKey, ranks }
}
