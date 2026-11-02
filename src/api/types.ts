/**
 * The MCP tool payloads the TUI renders. Shapes mirror the server's tool
 * outputs (server/src/routes/mcp.post.ts) — deliberately loose at the
 * leaves (server fields evolve), strict at the top level the UI depends on.
 */

export interface SubscriptionSummary {
  plan?: { planId?: string; name?: string; price?: number; currency?: string; duration?: string } | null
  status?: string
  planActive?: boolean
  abilities?: string[]
  limits?: Record<string, number>
  usage?: Record<string, any>
}

export interface RevenueBlock {
  grossCents?: number | null
  refundsCents?: number | null
  netCents?: number | null
  conversions?: number | null
  avgCents?: number | null
  rpvCents?: number | null
  currencies?: string[] | null
  mixed?: boolean
  lastAt?: string | null
}

export interface PortfolioProduct {
  key: string
  title?: string
  url?: string
  public?: boolean
  createdAt?: string
  score?: number | null
  performance?: number | null
  aeoScore?: number | null
  visitors?: number | null
  views?: number | null
  revenue?: RevenueBlock | null
}

export interface PortfolioOverview {
  range?: string
  products: PortfolioProduct[]
  count?: number
  gated?: { websiteAnalytics?: boolean; conversion?: boolean }
  note?: string | null
  generatedAt?: string
}

export interface InsightIssue {
  id?: string
  title?: string
  category?: string
  severity?: string
  status?: string
  displayValue?: string
  savingsMs?: number | null
  [k: string]: any
}

export interface FixCard {
  auditId: string
  issueTitle?: string
  strategy?: string
  stillCurrent?: boolean
  model?: string
  createdAt?: string
  card: { what?: string; why?: string; steps?: string[] | string; agentPrompt?: string; [k: string]: any }
}

export interface InsightsPayload {
  productKey: string
  performance?: number | null
  aeoScore?: number | null
  safeBrowsing?: any
  metrics?: any
  lcpElement?: any
  opportunities?: any[]
  issues?: InsightIssue[]
  firstEdit?: any
  unresolvedCards?: FixCard[] | null
  fixCardsNote?: string
  bottleneck?: any
  insightsVersion?: string
  providerHealth?: any
  scorecards?: any
  seoCrawl?: any
  funnel?: any
  findings?: any[]
  /** The full stored surface (same blocks the dashboard renders). */
  cro?: any
  mobile?: any
  aeo?: any
  site?: any
  crux?: any
  dr?: any
  opr?: any
  linkPreview?: any
  screenshot?: any
  mobileScreenshot?: any
  updatedAt?: string
  scanPending?: boolean
}

export interface AnalyticsTotals {
  views?: number | null
  visitors?: number | null
  sessions?: number | null
  /** 0-100 percentage, exactly as the server's aggregateWebsite computes it. */
  bouncePct?: number | null
  /** Average real-session duration in seconds; null = no real session in the window. */
  avgDurationSec?: number | null
  /** Pageviews per session for the window; null only with zero sessions. */
  pagesPerSession?: number | null
  conversions?: number | null
  revenueCents?: number | null
  conversionRate?: number | null
  rpvCents?: number | null
  deltas?: Record<string, number | null>
}

export interface AnalyticsDailyPoint {
  day: string
  views?: number | null
  visitors?: number | null
  revenueCents?: number | null
  sessions?: number | null
  bouncePct?: number | null
}

export interface WebsiteAnalyticsPayload {
  range?: string
  totals?: AnalyticsTotals
  daily?: AnalyticsDailyPoint[]
  topPages?: Array<{ path?: string; page?: string; count?: number; [k: string]: any }>
  topReferrers?: Array<{ referrer?: string; count?: number; [k: string]: any }>
  countries?: Array<{ country?: string; count?: number; [k: string]: any }>
  devices?: Array<{ device?: string; count?: number; [k: string]: any }>
  entryPages?: Array<{ path?: string; n?: number; pct?: number }>
  exitPages?: Array<{ path?: string; n?: number; pct?: number }>
  /** Acquisition channels — n counts pageview hits (visitors only when the server says the range is raw-covered). */
  channels?: Array<{ channel?: string; n?: number; pct?: number; visitors?: number; revenueCents?: number }>
  utm?: Array<{ source?: string; medium?: string | null; campaign?: string | null; n?: number }>
  goals?: Array<{ name?: string; n?: number; uniqueVisitors?: number; conversionRate?: number; revenueCents?: number }>
  crawls?: { aiAnswers?: any[]; indexing?: any[]; training?: any[]; partial?: boolean; partialNote?: string }
  realtime?: { visitorsNow?: number; windowMinutes?: number }
  events?: any[]
  aiInsight?: string | null
  aiInsightNote?: string
}

export interface ScanHistoryEntry {
  at?: string
  source?: string
  snapshot?: {
    psi?: { performance?: number | null; desktop?: { performance?: number | null } | null }
    aeo?: { score?: number | null }
    cro?: { score?: number | null }
    seoCrawl?: { score?: number | null }
    scorecards?: any
    opr?: { score?: number | null }
    [k: string]: any
  }
}

export interface KeywordRanksPayload {
  productKey: string
  searchConfigured?: boolean
  tracked?: Array<{ keyword: string; latest?: number | null; best?: number | null; series?: Array<number | null> }>
}

export interface KeywordIdeaCluster {
  name?: string
  intent?: string
  keywords?: Array<{ keyword?: string; volume?: number | null; difficulty?: number | null; verdict?: string; [k: string]: any }>
  [k: string]: any
}

export interface KeywordIdeasPayload {
  seed?: string
  provider?: string
  generatedAt?: string
  clusters?: KeywordIdeaCluster[]
  actions?: string[]
  model?: string | null
}

export interface FixCardEntry {
  auditId: string
  issueTitle?: string
  stillCurrent?: boolean
  card?: { what?: string; why?: string; steps?: string[] | string; agentPrompt?: string; [k: string]: any }
}

export interface RescanResult {
  ok?: boolean
  started?: boolean
  productKey?: string
  pageSpeedChecksLeft?: number | null
  fullAnalysesLeft?: number | null
  howToCheck?: string
}

export interface ProductStatus {
  productKey: string
  slug?: string
  title?: string
  public?: boolean
  addedAt?: string
}

export interface AnalyticsSnippetPayload {
  snippet?: string
  excludedPaths?: string[]
  instructions?: string
  verify?: string
  tip?: string
}

export interface ReadinessPayload {
  ready?: boolean
  issues?: Array<{ level?: string; message?: string; [k: string]: any }>
  categories?: Array<{ id?: string; name?: string; [k: string]: any }>
  note?: string
}
