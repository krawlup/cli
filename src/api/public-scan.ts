/**
 * The free site report, straight from the terminal: the exact endpoints the
 * /site-report page uses, identified by the CLI's device id instead of a
 * browser cookie. No login, no OAuth — the identity is the persisted
 * `~/.krawlup/device-id` UUID (see connect/identity.ts) carried as
 * `x-krawlup-device`, which the server keys into its own per-device quota
 * pool (an admin-set monthly allowance for the scriptable CLI channel — 0 by
 * default — against the browser's 2, with the same shared per-IP backstop;
 * every burst/served-with rate limit applies to this surface like any
 * visitor):
 *
 *   POST /api/tools/public-insights/product-insights-refresh  — start (or refuse by quota)
 *   GET  /api/tools/public-insights/insights/scan-status?key= — live stage of the sweep
 *   GET  /api/tools/public-insights/product-insights?key=     — the stored report (read)
 *   GET  /api/tools/public-insights/report.md?key=            — markdown export
 *
 * Every server refusal (quota, listed domain, rate limit) arrives as an
 * HTTP 4xx whose message is the site's own sentence — this client relays
 * it verbatim. Nothing here invents data: if the server doesn't say it,
 * the CLI doesn't show it.
 *
 * A signed-in CLI rides its bearer on the same requests. The server reads
 * the token optionally: anonymous callers stay on the device pool, while a
 * logged-in founder on the beta allowlist scans without a quota at all.
 * A missing/expired/foreign-base session simply falls back to the device
 * pool — the free report must never require a login.
 */
import { assertApiBase, defaultApi } from '../connect/credentials.js'
import { deviceHeaders } from '../connect/identity.js'
import { bearer, getSession } from './session.js'
import { UNKNOWN_SCAN_CONFIG, scansSpentMessage, type ScanConfig } from '../lib/scan-allowance.js'

export class PublicScanError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
  }
}

/** Internal: the wait was stopped locally (esc / ctrl+c). The scan itself keeps running server-side. */
export class ScanAborted extends Error {
  constructor() {
    super('stopped waiting — the scan keeps running on krawlup.com')
  }
}

// ── Stage model (mirrors the web panel's composable, useScanProgress.ts) ──

export interface PublicScanStageDef {
  id: string
  /** Checklist line — what the scan is doing right now. */
  label: string
  /** The realistic note shown under the checklist while this stage runs. */
  note: string
  /** Rough share of a typical run, in seconds — paces the bar only. */
  seconds: number
}

/** First public stage: the sweep waits for one of the two global worker slots. */
export const PUBLIC_SCAN_STAGES: PublicScanStageDef[] = [
  {
    id: 'queued',
    label: 'Waiting for a free scan slot',
    note: 'Free scans share two worker slots across the whole site — busy moments queue up.',
    seconds: 25,
  },
  {
    id: 'capture',
    label: 'Capturing the live page',
    note: 'The report reads what a browser sees after JavaScript — client-rendered sites included.',
    seconds: 8,
  },
  {
    id: 'crux',
    label: 'Pulling real-user field data',
    note: 'Field data comes from real Chrome visitors over the last 28 days; low-traffic sites may not have any yet.',
    seconds: 5,
  },
  {
    id: 'lighthouse',
    label: 'Running Lighthouse page speed analysis',
    note: 'Lighthouse runs on Google’s PageSpeed service — usually the longest step, under a minute.',
    seconds: 45,
  },
  {
    id: 'scoring',
    label: 'Scoring and comparing',
    note: 'Every score renormalizes over the checks that actually ran — a partial report never fakes a number.',
    seconds: 6,
  },
  {
    id: 'history',
    label: 'Saving the report',
    note: 'This run is archived; scan history tracks the before/after.',
    seconds: 4,
  },
]

export function stageIndexFor(stage: string): number {
  return PUBLIC_SCAN_STAGES.findIndex((s) => s.id === stage)
}

/** The bar never admits more than this until the report actually lands. */
export const BAR_CEILING = 95
/** Stages pace slower than their expected span so the bar still moves when a provider runs long. */
const PACE_SLOP = 1.35

export interface StagePacing {
  total: number
  /** Cumulative center-of-gravity fraction where each stage begins. */
  starts: number[]
  /** The stage list the fractions were computed from — stageBarPct reads its
   *  spans from here, so a re-paced list can never drift from its fractions. */
  stages: PublicScanStageDef[]
}

export function stagePacing(stages: PublicScanStageDef[] = PUBLIC_SCAN_STAGES): StagePacing {
  const total = stages.reduce((sum, s) => sum + s.seconds, 0) || 1
  return {
    total,
    starts: stages.map((_, i) => stages.slice(0, i).reduce((sum, s) => sum + s.seconds, 0) / total),
    stages,
  }
}

/** Where the bar sits after `elapsedInStageSec` inside stage `stageIdx` (0–BAR_CEILING). */
export function stageBarPct(stageIdx: number, elapsedInStageSec: number, pacing: StagePacing = stagePacing()): number {
  const stage = pacing.stages[stageIdx]
  if (!stage) return BAR_CEILING
  const frac = Math.min(elapsedInStageSec / (stage.seconds * PACE_SLOP), 1)
  const target = ((pacing.starts[stageIdx] ?? 0) + (stage.seconds / pacing.total) * frac) * BAR_CEILING
  return Math.max(0, Math.min(target, BAR_CEILING))
}

// ── Wire types (leaves loose, the top the UI depends on strict) ──

export interface PublicRefreshResult {
  started: boolean
  alreadyRunning?: boolean
  queued?: boolean
  queuePosition?: number | null
  /** auto-mode-only read answer; the CLI sends mode 'all', so this stays undefined. */
  quotaExhausted?: boolean
  autoStarted?: boolean
  autoStartReason?: string | null
}

/** One CrUX factor set (the web view's CruxFactorView shape). */
export interface CruxFactorWire {
  lcpP75Ms?: number | null
  inpP75Ms?: number | null
  cls100?: number | null
  lcpRating?: string | null
  inpRating?: string | null
  clsRating?: string | null
}

export interface PublicScanStatus {
  running: boolean
  stage: string | null
  at: string | null
  startedAt: string | null
  error: string | null
  queuePosition: number | null
}

export interface PublicReportPayload {
  domain: string
  hasReport: boolean
  scanPending?: boolean
  scanStage?: string | null
  scanStartedAt?: string | null
  overall?: {
    score?: number | null
    band?: string | null
    verdict?: string | null
    parts?: { performance?: number | null; aeo?: number | null; conversion?: number | null }
    bottleneck?: string | null
    archetype?: string | null
  } | null
  /** Scorecards v3: five measured planes (weight shares of the composite in comments). */
  scorecards?: {
    technical?: { score: number | null; measured?: boolean; blockedBy?: string[] } | null // 25%
    search?: { score: number | null; measured?: boolean; blockedBy?: string[] } | null // 25%
    ai?: { score: number | null; measured?: boolean; blockedBy?: string[] } | null // 20%
    conversion?: {
      score: number | null
      measured?: boolean
      blockedBy?: string[]
      components?: { structuralCro?: number | null; mobileUx?: number | null }
    } | null // 20%
    trust?: { score: number | null; measured?: boolean; blockedBy?: string[] } | null // 10%
    overall?: { score?: number | null; basis?: string } | null
  } | null
  issues?: unknown[]
  seoCrawl?: {
    crawled?: number | null
    brokenLinks?: { checked?: number | null; broken?: unknown[] | null } | null
    issues?: unknown[]
    [k: string]: any
  } | null
  /** Lighthouse lab metrics (ms unless noted) — the Core Web Vitals row. */
  psi?: {
    performance?: number | null
    accessibility?: number | null
    bestPractices?: number | null
    seo?: number | null
    metrics?: { fcpMs?: number | null; lcpMs?: number | null; tbtMs?: number | null; cls?: number | null; siMs?: number | null } | null
    lcpElement?: { nodeLabel?: string; selector?: string; snippet?: string; isText?: boolean } | null
    opportunities?: Array<{ id?: string; title?: string; savingsMs?: number | null; displayValue?: string | null }> | null
    [k: string]: any
  } | null
  /** The trust checks the hero's Trust & security card counts. */
  site?: {
    httpsRedirect?: boolean | null
    tlsValidTo?: string | null
    headers?: { hsts?: boolean | null; csp?: boolean | null; xFrameOptions?: boolean | null } | null
    og?: { title?: string | null; description?: string | null; image?: string | null } | null
    safeBrowsing?: 'clean' | 'flagged' | null
  } | null
  /** AI-readiness facts — llms.txt, the per-agent robots matrix, structured data, FAQ. */
  aeo?: {
    score?: number | null
    llmsTxt?: boolean | null
    robots?: { blocked?: string[] | null; total?: number | null; sitemapDeclared?: boolean | null } | null
    schema?: { present?: boolean | null; types?: string[] | null } | null
    faqFound?: boolean | null
    og?: { title?: string | null; description?: string | null; image?: string | null } | null
    ogComplete?: boolean | null
    rendered?: boolean | null
  } | null
  /** Conversion (CRO) checks — tri-state per check, null pass = unverified. */
  cro?: {
    score?: number | null
    checks?: Array<{ id?: string; pass?: boolean | null; detail?: string | null }> | null
    rendered?: boolean | null
    truncated?: boolean | null
  } | null
  /** Real-browser 390px mobile layout test — mirrors CRO's tri-state contract. */
  mobile?: {
    score?: number | null
    assessed?: boolean | null
    checks?: Array<{ id?: string; pass?: boolean | null; detail?: string | null }> | null
    rendered?: boolean | null
    evidence?: {
      offscreen?: Array<{ tag?: string; text?: string; note?: string }> | null
      tapTargets?: Array<{ tag?: string; text?: string; note?: string }> | null
      overlay?: { ctaText?: string; snippet?: string } | null
      smallText?: Array<{ tag?: string; text?: string; note?: string }> | null
    } | null
  } | null
  /** Per-provider tri-state — which checks ran, failed, or were skipped. */
  providerHealth?: Record<string, { status?: string; errorCode?: string; errorMessage?: string } | undefined> | null
  /** The cached AI First Edit card for the current numbers (gate: aiFirstFix). */
  aiFixes?: Array<{
    auditId?: string
    issueTitle?: string
    card?: { what?: string; why?: string; steps?: string[] | string; agentPrompt?: string } | null
  }> | null
  aiFixReady?: boolean
  aiFixPreparing?: boolean
  /** The stored AI bottleneck card ({card: {what/why/steps}}), gate: aiBottleneck. */
  bottleneck?: { card?: { what?: string; why?: string; bottleneck?: string; impact?: string; steps?: string[] | string } | null } | null
  /** The X/Slack unfurl verdict folded into og completeness. */
  linkPreview?: { image?: boolean | null; [k: string]: any } | null
  /** 30-day-ephemeral captures (desktop 1920px, phone 780px). */
  screenshot?: { url?: string; fileId?: string; capturedAt?: string } | null
  mobileScreenshot?: { url?: string; fileId?: string; capturedAt?: string } | null
  /** The directory category stamp the sweep's Jev judgment wrote (once). */
  category?: string | null
  /** Ahrefs Domain Rating — null until a real value exists (never a fabricated zero). */
  dr?: { value: number | null; prevValue: number | null; checkedAt?: string | null } | null
  /** OpenPageRank authority read (score, global rank, referring domains). */
  opr?: { score: number | null; rank: number | null; referringDomains: number | null; checkedAt?: string | null } | null
  /** Cross-provider findings the page lists as "Open findings" (status-chipped). */
  findings?: Array<{
    fingerprint: string
    provider: string
    checkId: string
    url?: string
    severity?: string
    status?: string
    evidence?: Record<string, unknown>
    lastSeenAt?: string
  }>
  crux?: {
    assessed?: boolean | null
    checkedAt?: string | null
    phone?: CruxFactorWire | null
    desktop?: CruxFactorWire | null
    [k: string]: any
  } | null
  verdict?: { line?: string } | null
  publicQuota?: {
    scansUsed?: number
    scansLeft?: number
    pageSpeedChecksLeftToday?: number
    betaUnlimited?: boolean
  } | null
  updatedAt?: string
  checkedAt?: string
  [k: string]: any
}

/**
 * The free-scan allowance the SERVER enforces — the CLI renders these numbers
 * instead of hardcoding them (the per-device pool is an admin setting).
 * `scan-config` is a cheap, auth-optional read: the bearer only widens the
 * answer with `betaUnlimited`, it never grants anything.
 */
export interface PublicScanConfig {
  channel?: 'cli' | 'web'
  scansPerMonth?: number
  cliScansPerMonth?: number
  webScansPerMonth?: number
  pageSpeedChecksPerDay?: number
  betaUnlimited?: boolean
  signedIn?: boolean
}

/**
 * GET /api/tools/public-insights/scan-config. Throws on a transport or HTTP
 * failure — the caller (state/scan-config.ts) degrades to "unknown" rather
 * than printing a number the server never said.
 */
export async function fetchScanConfig(apiBase?: string): Promise<PublicScanConfig> {
  const api = parseApiBase(apiBase)
  const out = await publicJson<PublicScanConfig>('GET', api, '/api/tools/public-insights/scan-config', {
    timeoutMs: 8_000,
  })
  if (!out.ok) throw new PublicScanError(out.message, out.status)
  return out.data
}

// ── Raw fetch helpers ──

async function composeSignal(timeoutMs: number, outer?: AbortSignal): Promise<{ signal: AbortSignal; cleanup: () => void }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuter = () => controller.abort()
  outer?.addEventListener('abort', onOuter)
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuter)
    },
  }
}

function parseApiBase(apiBase?: string): string {
  const base = (apiBase ?? defaultApi()).replace(/\/+$/, '')
  assertApiBase(base)
  return base
}

/**
 * The optional session bearer for THIS api base. Only an OAuth login can
 * earn the account-level beta exemption (agent keys are not user tokens),
 * and a token minted for another base is never sent — a dev/test API must
 * not receive a production session. Dead or expiring sessions refresh
 * through the shared session layer; any failure degrades to anonymous.
 */
async function sessionBearer(apiBase: string): Promise<string | null> {
  const session = getSession()
  if (!session || session.kind !== 'oauth') return null
  if (session.api.replace(/\/+$/, '') !== apiBase) return null
  try {
    return await bearer()
  } catch {
    return null
  }
}

async function hostedHeaders(apiBase: string): Promise<Record<string, string>> {
  const headers = await deviceHeaders()
  const token = await sessionBearer(apiBase)
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

/** One public JSON call: plain fetch, device headers, refusal sentences verbatim. */
async function publicJson<T>(
  method: 'GET' | 'POST',
  apiBase: string,
  path: string,
  opts: { body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ data: T; ok: true } | { data: unknown; ok: false; status: number; message: string }> {
  const { signal, cleanup } = await composeSignal(opts.timeoutMs ?? 30_000, opts.signal)
  try {
    const headers: Record<string, string> = await hostedHeaders(apiBase)
    if (method === 'POST') {
      headers['content-type'] = 'application/json'
      headers.accept = 'application/json'
    }
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(opts.body ?? {}) } : {}),
      signal,
    })
    if (!res.ok) {
      let body: any = null
      try {
        body = await res.json()
      } catch {
        /* not JSON — fall through to the HTTP status */
      }
      const message =
        (typeof body?.message === 'string' && body.message) ||
        (typeof body?.statusMessage === 'string' && body.statusMessage) ||
        `request failed (HTTP ${res.status})`
      return { data: body, ok: false, status: res.status, message }
    }
    return { data: (await res.json()) as T, ok: true }
  } finally {
    cleanup()
  }
}

/** POST refresh — starts a full scan or refuses with the site's exact sentence. */
export async function triggerPublicScan(
  domain: string,
  opts: { apiBase?: string; signal?: AbortSignal } = {},
): Promise<PublicRefreshResult> {
  const api = parseApiBase(opts.apiBase)
  const out = await publicJson<PublicRefreshResult>('POST', api, '/api/tools/public-insights/product-insights-refresh', {
    body: { key: domain, mode: 'all' },
    signal: opts.signal,
  })
  if (!out.ok) throw new PublicScanError(out.message, out.status)
  return out.data
}

export interface StatusOpts {
  apiBase?: string
  signal?: AbortSignal
  timeoutMs?: number
}

/** GET scan-status — the live stage the progress checklist follows. */
export async function fetchPublicScanStatus(domain: string, opts: StatusOpts = {}): Promise<PublicScanStatus> {
  const api = parseApiBase(opts.apiBase)
  const out = await publicJson<PublicScanStatus>('GET', api, `/api/tools/public-insights/insights/scan-status?key=${encodeURIComponent(domain)}`, opts)
  if (!out.ok) throw new PublicScanError(out.message, out.status)
  return out.data
}

/** GET product-insights — the stored report, exactly what the /site-report page renders. */
export async function fetchPublicReport(domain: string, opts: StatusOpts = {}): Promise<PublicReportPayload> {
  const api = parseApiBase(opts.apiBase)
  const out = await publicJson<PublicReportPayload>('GET', api, `/api/tools/public-insights/product-insights?key=${encodeURIComponent(domain)}`, opts)
  if (!out.ok) throw new PublicScanError(out.message, out.status)
  return out.data
}

/** GET report.md — the markdown export (rate limit 10/h per IP). */
export async function fetchPublicReportMd(domain: string, opts: StatusOpts = {}): Promise<string> {
  const api = parseApiBase(opts.apiBase)
  const { signal, cleanup } = await composeSignal(opts.timeoutMs ?? 30_000, opts.signal)
  try {
    const res = await fetch(`${api}/api/tools/public-insights/report.md?key=${encodeURIComponent(domain)}`, {
      headers: await hostedHeaders(api),
      signal,
    })
    if (!res.ok) {
      let body: any = null
      try {
        body = await res.json()
      } catch {
        /* may be plain text */
      }
      throw new PublicScanError(
        (typeof body?.message === 'string' && body.message) ||
        (typeof body?.statusMessage === 'string' && body.statusMessage) ||
        `could not download the markdown report (HTTP ${res.status})`,
        res.status,
      )
    }
    return await res.text()
  } finally {
    cleanup()
  }
}

// ── The wait orchestration ──

export interface PublicScanState {
  phase: 'requesting' | 'queued' | 'running' | 'done'
  /** Index into PUBLIC_SCAN_STAGES the checklist is showing. */
  stageIdx: number
  stageLabel: string
  stageNote: string
  /** LOCAL epoch-ms anchor of the current stage's checklist entry — the UI paces the bar from it. */
  stageStartMs: number
  /** Total seconds since the run's claim (server `startedAt` anchor when given). */
  elapsedSec: number
  /** Bar position at the last update (0–95); the UI recomputes between polls from stageStartMs. */
  barPct: number
  queuePosition: number | null
}

export interface RunPublicScanOptions {
  apiBase?: string
  signal?: AbortSignal
  pollMs?: number
  /** Hard wait ceiling — the CLI reports honest "still running" instead of pretending. */
  deadlineMs?: number
  statusTimeoutMs?: number
  /**
   * The allowance the caller already fetched (state/scan-config.ts). Used only
   * to word a quota refusal, so it defaults to "unknown" and the API module
   * keeps no dependency on the store.
   */
  config?: ScanConfig
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ScanAborted())
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      cleanup()
      resolve()
    }
    function cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    function onAbort() {
      cleanup()
      reject(new ScanAborted())
    }
    signal?.addEventListener('abort', onAbort)
  })
}

/**
 * Run the whole free-report flow for one domain: refresh (or refuse), follow
 * the sweep's stages the same way the web panel does, return the stored
 * report payload. Every update carries a complete snapshot — the UI renders
 * whatever it receives and nothing else exists between polls.
 *
 * Honesty rules taken from the server's own contract:
 *  - a status `error` ends the wait with that exact sentence;
 *  - the checklist never advances backwards on its own clock — only a server
 *    stage move jumps it forward, so local pacing can't skip a real stage;
 *  - the bar holds under BAR_CEILING until the report read succeeds;
 *  - an abort stops ONLY the wait — the server-side scan keeps running.
 */
export async function runPublicScan(
  domain: string,
  onUpdate: (state: PublicScanState) => void,
  opts: RunPublicScanOptions = {},
): Promise<PublicReportPayload> {
  const apiBase = parseApiBase(opts.apiBase)
  const pacing = stagePacing()
  const pollMs = opts.pollMs ?? 2_000
  const deadline = Date.now() + (opts.deadlineMs ?? 15 * 60_000)

  // An abort usually lands while a fetch is in flight, which surfaces as a
  // raw AbortError — every cancellation of the WAIT is ScanAborted, with
  // only the wait's own sentence.
  const ifAborted = (e: unknown): unknown => {
    if (opts.signal?.aborted) return new ScanAborted()
    return e
  }

  const emit = (state: PublicScanState): void => onUpdate(state)
  const snapshot = (o: Omit<PublicScanState, 'barPct'>, barPct: number): void =>
    emit({ ...o, barPct })

  onUpdate({
    phase: 'requesting',
    stageIdx: 0,
    stageLabel: PUBLIC_SCAN_STAGES[0]!.label,
    stageNote: 'Asking krawlup.com whether this device still has free scans.',
    stageStartMs: Date.now(),
    elapsedSec: 0,
    barPct: 0,
    queuePosition: null,
  })

  const started = await triggerPublicScan(domain, { apiBase, signal: opts.signal }).catch((e) => {
    throw ifAborted(e)
  })

  // Some quota dead ends answer with started:false + a reason instead of an
  // HTTP error (auto-mode only). The CLI sends mode 'all', so this is a
  // belt-and-braces relay, but it must never be silently swallowed.
  if (started.started === false && started.quotaExhausted) {
    // The cap is an admin setting, so the sentence is built from the fetched
    // allowance (state/scan-config.ts) — never from a hardcoded "one".
    throw new PublicScanError(scansSpentMessage(opts.config ?? UNKNOWN_SCAN_CONFIG), 429)
  }

  let stageIdx = 0
  let stageStartMs = Date.now()
  let elapsedSec = 0
  let queuePosition: number | null = started.queuePosition ?? null
  let pendingRounds = 0

  for (;;) {
    if (opts.signal?.aborted) throw new ScanAborted()
    const status = await fetchPublicScanStatus(domain, { apiBase, signal: opts.signal, timeoutMs: opts.statusTimeoutMs }).catch((e) => {
      throw ifAborted(e)
    })

    if (status.error) throw new PublicScanError(status.error)

    if (status.running) {
      if (status.queuePosition != null) queuePosition = status.queuePosition
      else if (status.stage === null && stageIdx > 0) queuePosition = null
      if (status.startedAt) {
        const t = new Date(status.startedAt).getTime()
        if (Number.isFinite(t) && t <= Date.now()) elapsedSec = Math.max(elapsedSec, Math.floor((Date.now() - t) / 1000))
      }
      // Only a server stage move jumps the checklist forward — never the
      // local clock, so pacing cannot skip a stage the sweep hasn't reached.
      const sIdx = status.stage ? stageIndexFor(status.stage) : -1
      if (sIdx !== -1 && sIdx > stageIdx) {
        stageIdx = sIdx
        stageStartMs = Date.now()
      }
      const stage = PUBLIC_SCAN_STAGES[stageIdx]!
      const barPct = stageBarPct(stageIdx, (Date.now() - stageStartMs) / 1000, pacing)
      snapshot(
        {
          phase: stageIdx === stageIndexFor('queued') ? 'queued' : 'running',
          stageIdx,
          stageLabel: stage.label,
          stageNote: stage.note,
          stageStartMs,
          elapsedSec,
          queuePosition,
        },
        barPct,
      )
      if (Date.now() + pollMs > deadline) {
        throw new PublicScanError(
          'The scan is still running after the CLI stopped waiting — give it a minute and run `krawlup report ' +
            domain +
            '` again to read the stored report (a read costs nothing).',
        )
      }
      await sleep(pollMs, opts.signal)
      continue
    }

    // Not running: the run is over. The sweep writes its report before the
    // queue release, but a just-finished sweep can still read pending for one
    // marker-freshness beat — allow a bounded grace of re-reads, then give up
    // honestly. Rendering a pending payload as finished would show a stale
    // report as fresh.
    const report = await fetchPublicReport(domain, { apiBase, signal: opts.signal, timeoutMs: opts.statusTimeoutMs }).catch((e) => {
      throw ifAborted(e)
    })
    if (report.scanPending) {
      pendingRounds += 1
      if (pendingRounds <= 3 && Date.now() + pollMs <= deadline) {
        await sleep(pollMs, opts.signal)
        continue
      }
      throw new PublicScanError(
        'The scan is still writing its report — give it a minute, then run `krawlup report ' + domain + '` again (the read is free).',
        202,
      )
    }
    if (!report.hasReport) {
      throw new PublicScanError(
        'The scan ended without producing a report — try again in a minute (a failed scan does not spend your quota).',
      )
    }
    const stage = PUBLIC_SCAN_STAGES[Math.min(stageIdx, PUBLIC_SCAN_STAGES.length - 1)]!
    snapshot(
      {
        phase: 'done',
        stageIdx: PUBLIC_SCAN_STAGES.length - 1,
        stageLabel: 'Report ready',
        stageNote: stage.note,
        stageStartMs,
        elapsedSec,
        queuePosition: null,
      },
      100,
    )
    return report
  }
}
