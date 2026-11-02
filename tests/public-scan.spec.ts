/**
 * The free site-report surface: the device-keyed client against the server's
 * own public endpoints. Pinned here: the wire contract the /site-report page
 * shares (refresh → scan-status → product-insights), the verbatim relay of
 * every refusal sentence, the stage checklist/pacing model, and the honest
 * wait semantics (errors end the wait, aborts stop only the waiting, reads
 * that come back pending keep waiting instead of rendering an empty report).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// The session store persists to ~/.krawlup/session.json. Tests must never
// read or write the developer's real session, so HOME is redirected before
// the session module initializes.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/krawlup-cli-public-scan-home` }
})

process.env.KRAWLUP_SKIP_DEVICE_FILE = '1'

const REAL_FETCH = globalThis.fetch

interface Hit { method: string; path: string; headers: Record<string, string>; body?: string }

let server: Server | null = null
let baseUrl = ''
const hits: Hit[] = []

/** Scriptable route handlers run in order; non-matches fall through to 404. */
type Route = { match: (m: string, p: string) => boolean; reply: (h: Hit, res: import('node:http').ServerResponse) => void }
let routes: Route[] = []

function jsonReply(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  if (status >= 400) {
    // Nitro/H3 shape: statusCode + statusMessage at top level.
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ statusCode: status, statusMessage: null, ...(body as any), message: (body as any)?.message }))
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

beforeEach(async () => {
  hits.length = 0
  routes = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += String(c)))
    req.on('end', () => {
      const url = new URL(String(req.url), 'http://x')
      const hit: Hit = {
        method: String(req.method),
        path: `${url.pathname}${url.search}`,
        headers: req.headers as Record<string, string>,
        body: raw || undefined,
      }
      hits.push(hit)
      const route = routes.find((r) => r.match(hit.method, url.pathname))
      if (route) route.reply(hit, res)
      else jsonReply(res, 404, { message: 'not found' })
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const addr = server!.address() as AddressInfo
  baseUrl = `http://localhost:${addr.port}`
  process.env.KRAWLUP_API = baseUrl
})

afterEach(async () => {
  await new Promise<void>((r) => server!.close(() => r()))
  server = null
  delete process.env.KRAWLUP_API
  globalThis.fetch = REAL_FETCH
})

import {
  BAR_CEILING,
  PUBLIC_SCAN_STAGES,
  PublicScanError,
  ScanAborted,
  fetchPublicReportMd,
  runPublicScan,
  stageBarPct,
  stageIndexFor,
  stagePacing,
  triggerPublicScan,
} from '../src/api/public-scan.js'
import { setSession } from '../src/api/session.js'

const REPORT = {
  domain: 'acme.dev',
  hasReport: true,
  scanPending: false,
  scanStage: null,
  scanStartedAt: null,
  overall: {
    score: 72,
    band: 'Fixable gaps',
    verdict: 'Fixable gaps. Start with the First Edit.',
    parts: { performance: 80, aeo: 62, conversion: 55 },
    bottleneck: null,
    archetype: 'Balanced',
  },
  scorecards: { overall: { score: 72 }, cards: [{ label: 'Technical', score: 74 }] },
  issues: [{ id: 'img_alt', title: 'Images missing alt text', severity: 'medium' }],
  seoCrawl: { crawled: 12, brokenLinks: { checked: 12, broken: [] } },
  publicQuota: { scansUsed: 1, scansLeft: 1, pageSpeedChecksLeftToday: 1 },
  updatedAt: new Date().toISOString(),
}

describe('refresh client', () => {
  it('sends key + mode over POST with the device identity headers', async () => {
    routes.push({
      match: (m, p) => m === 'POST' && p.endsWith('/product-insights-refresh'),
      reply: (h, res) => {
        const body = JSON.parse(h.body || '{}')
        const out = { started: true, queued: true, queuePosition: 0 }
        if (!/^[0-9a-f-]{36}$/i.test(String(h.headers['x-krawlup-device'] ?? ''))) {
          jsonReply(res!, 403, { message: 'device id missing' })
          return
        }
        if (!String(h.headers['x-krawlup-client'] ?? '').startsWith('krawlup-cli/')) {
          jsonReply(res!, 403, { message: 'client header missing' })
          return
        }
        if (body.key !== 'acme.dev') {
          jsonReply(res!, 400, { message: `bad key ${JSON.stringify(body)}` })
          return
        }
        jsonReply(res!, 200, out)
      },
    })
    await expect(triggerPublicScan('acme.dev')).resolves.toEqual({ started: true, queued: true, queuePosition: 0 })
  })

  it('relays the quota refusal sentence verbatim with the HTTP status', async () => {
    routes.push({
      match: (m, p) => m === 'POST' && p.endsWith('/product-insights-refresh'),
      reply: (_h, res) =>
        res!.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({
          statusCode: 429,
          statusMessage: 'Rate limit exceeded',
          message: "You've used your one free CLI scan this month — it renews next month, or sign up to scan unlimited sites.",
        })),
    })
    const err = await triggerPublicScan('acme.dev').catch((e) => e)
    expect(err).toBeInstanceOf(PublicScanError)
    expect((err as PublicScanError).message).toBe(
      "You've used your one free CLI scan this month — it renews next month, or sign up to scan unlimited sites.",
    )
    expect((err as PublicScanError).status).toBe(429)
  })

  it('relays the listed-domain 409 sentence verbatim', async () => {
    routes.push({
      match: (m, p) => m === 'POST' && p.endsWith('/product-insights-refresh'),
      reply: (_h, res) =>
        res!.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({
          statusCode: 409,
          message: 'This product is already listed on krawlup — sign up and claim it to scan this website and get the full report.',
        })),
    })
    await expect(triggerPublicScan('acme.dev')).rejects.toThrow('already listed on krawlup')
  })

  it('refuses to send the identity anywhere except https/localhost', async () => {
    await expect(triggerPublicScan('acme.dev', { apiBase: 'http://evil.example' })).rejects.toThrow(/https/)
  })
})

describe('signed-in session on the public endpoints', () => {
  afterEach(async () => {
    await setSession(null)
  })

  it('rides the OAuth bearer on the refresh request so beta testers skip the device quota', async () => {
    await setSession({
      kind: 'oauth',
      api: baseUrl,
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      clientId: 'test-client',
    })
    routes.push({
      match: (m, p) => m === 'POST' && p.endsWith('/product-insights-refresh'),
      reply: (_h, res) => jsonReply(res!, 200, { started: true }),
    })
    await triggerPublicScan('acme.dev')
    const refresh = hits.find((h) => h.path.endsWith('/product-insights-refresh'))!
    expect(refresh.headers.authorization).toBe('Bearer test-access-token')
  })

  it('never sends a token minted for another API base', async () => {
    await setSession({
      kind: 'oauth',
      api: 'https://krawlup.com',
      accessToken: 'production-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      clientId: 'test-client',
    })
    routes.push({
      match: (m, p) => m === 'POST' && p.endsWith('/product-insights-refresh'),
      reply: (_h, res) => jsonReply(res!, 200, { started: true }),
    })
    await triggerPublicScan('acme.dev')
    const refresh = hits.find((h) => h.path.endsWith('/product-insights-refresh'))!
    expect(refresh.headers.authorization).toBeUndefined()
  })

  it('stays anonymous for an agent-key session (not a user token)', async () => {
    await setSession({ kind: 'key', api: baseUrl, key: 'krawlup_agent_key' })
    routes.push({
      match: (m, p) => m === 'POST' && p.endsWith('/product-insights-refresh'),
      reply: (_h, res) => jsonReply(res!, 200, { started: true }),
    })
    await triggerPublicScan('acme.dev')
    const refresh = hits.find((h) => h.path.endsWith('/product-insights-refresh'))!
    expect(refresh.headers.authorization).toBeUndefined()
  })
})

describe('runPublicScan wait semantics', () => {
  /** status may be a fixed payload or a per-poll function (n = 1, 2, …). */
  function defaultRoutes(over: Partial<{ status: unknown | ((n: number) => unknown); report: unknown }> = {}): void {
    let n = 0
    routes.push({
      match: (m, p) => m === 'POST' && p.endsWith('/product-insights-refresh'),
      reply: (_h, res) => jsonReply(res!, 200, { started: true, queued: true, queuePosition: 0 }),
    })
    routes.push({
      match: (m, p) => m === 'GET' && p.startsWith('/api/tools/public-insights/insights/scan-status'),
      reply: (_h, res) => {
        n += 1
        const scripted = typeof over.status === 'function' ? over.status(n) : over.status
        const st =
          scripted ??
          (n === 1
            ? { running: true, stage: 'queued', at: new Date().toISOString(), startedAt: new Date().toISOString(), error: null, queuePosition: 2 }
            : n === 2
              ? { running: true, stage: 'lighthouse', at: new Date().toISOString(), startedAt: new Date().toISOString(), error: null, queuePosition: null }
              : { running: false, stage: null, at: null, startedAt: null, error: null, queuePosition: null })
        jsonReply(res!, 200, st)
      },
    })
    routes.push({
      match: (m, p) => m === 'GET' && p.startsWith('/api/tools/public-insights/product-insights'),
      reply: (_h, res) => jsonReply(res!, 200, over.report ?? REPORT),
    })
  }

  it('walks the stage checklist forward and returns the stored report', async () => {
    defaultRoutes()
    const updates: Array<{ phase: string; stageIdx: number; stageLabel: string; barPct: number; queuePosition: number | null }> = []
    const report = await runPublicScan('acme.dev', (s) => updates.push({ phase: s.phase, stageIdx: s.stageIdx, stageLabel: s.stageLabel, barPct: s.barPct, queuePosition: s.queuePosition }), {
      pollMs: 1,
    })
    expect(report.domain).toBe('acme.dev')
    expect(report.hasReport).toBe(true)
    // A queued-checkpoint update then a lighthouse-checkpoint update, then done.
    // (Stage 0 also appears as the initial 'requesting' snapshot — take the
    // LAST stage-0 update, the queued checkpoint itself.)
    const queued = updates.filter((u) => u.stageIdx === stageIndexFor('queued')).pop()
    const lighthouse = updates.find((u) => u.stageIdx === stageIndexFor('lighthouse'))
    const done = updates.find((u) => u.phase === 'done')
    expect(queued?.queuePosition).toBe(2)
    expect(lighthouse).toBeTruthy()
    expect(lighthouse!.barPct).toBeGreaterThanOrEqual(stageBarPct(stageIndexFor('lighthouse'), 0))
    expect(done?.barPct).toBe(100)
    // The checklist never moves backwards between ok updates.
    for (let i = 1; i < updates.length; i += 1) expect(updates[i]!.stageIdx).toBeGreaterThanOrEqual(updates[i - 1]!.stageIdx)
  })

  it('TREATS the server error as the truth and ends the wait with that exact sentence', async () => {
    // First poll running, then the sweep reports its own error.
    defaultRoutes({
      status: (n: number) =>
        n === 1
          ? { running: true, stage: 'queued', at: new Date().toISOString(), startedAt: new Date().toISOString(), error: null, queuePosition: 0 }
          : { running: false, stage: null, at: null, startedAt: null, error: 'The scanner lost this scan midway through. Reload the page to try again.', queuePosition: null },
    })
    const err = await runPublicScan('acme.dev', () => {}, { pollMs: 1 }).catch((e) => e)
    expect(err).toBeInstanceOf(PublicScanError)
    expect((err as PublicScanError).message).toBe('The scanner lost this scan midway through. Reload the page to try again.')
  })

  it('a pending report after a finished sweep gives up honestly after the bounded grace, and never renders a stale report', async () => {
    defaultRoutes({ report: { ...REPORT, hasReport: true, scanPending: true } })
    // The report stays pending forever → the run must give up honestly, not hang.
    const err = await runPublicScan('acme.dev', () => {}, { pollMs: 1, deadlineMs: 50 }).catch((e) => e)
    expect(err).toBeTruthy()
    expect(String(err?.message ?? err)).toMatch(/writing its report|still running|ended without producing/i)
  })

  it('a scan that ends with nothing on file refuses instead of rendering an empty block', async () => {
    defaultRoutes({ report: { domain: 'acme.dev', hasReport: false, scanPending: false } })
    await expect(runPublicScan('acme.dev', () => {}, { pollMs: 1 })).rejects.toThrow('ended without producing a report')
  })

  it('alreadyRunning still waits — someone else’s sweep answers with its own stages', async () => {
    let n = 0
    routes.push({
      match: (m, p) => m === 'POST' && p.endsWith('/product-insights-refresh'),
      reply: (_h, res) => jsonReply(res!, 200, { started: true, alreadyRunning: true, queuePosition: null }),
    })
    routes.push({
      match: (m, p) => m === 'GET' && p.startsWith('/api/tools/public-insights/insights/scan-status'),
      reply: (_h, res) => {
        n += 1
        jsonReply(res!, 200, n === 1
          ? { running: true, stage: 'scoring', at: new Date().toISOString(), startedAt: new Date().toISOString(), error: null, queuePosition: null }
          : { running: false, stage: null, at: null, startedAt: null, error: null, queuePosition: null })
      },
    })
    routes.push({
      match: (m, p) => m === 'GET' && p.startsWith('/api/tools/public-insights/product-insights'),
      reply: (_h, res) => jsonReply(res!, 200, REPORT),
    })
    const report = await runPublicScan('acme.dev', () => {}, { pollMs: 1 })
    expect(report.hasReport).toBe(true)
    const refresh = hits.find((h) => h.path.endsWith('/product-insights-refresh'))!
    expect(JSON.parse(refresh.body || '{}').key).toBe('acme.dev')
  })

  it('abort stops only the WAIT and leaves the refresh already sent', async () => {
    defaultRoutes({ status: { running: true, stage: 'queued', at: new Date().toISOString(), startedAt: new Date().toISOString(), error: null, queuePosition: 0 } })
    const abort = new AbortController()
    const run = runPublicScan('acme.dev', () => {}, { pollMs: 10_000, signal: abort.signal })
    // Abort once the refresh POST has actually been RECORDED — the point of
    // the test is that aborting the wait can never un-send the refresh, so
    // the abort must happen after it lands, not after a guessed 10 ms (which
    // loses under parallel-suite CPU contention). Bounded, so a server that
    // never sees the POST fails the test the honest way.
    for (let i = 0; i < 200 && !hits.some((h) => h.path.endsWith('/product-insights-refresh')); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    abort.abort()
    await expect(run).rejects.toBeInstanceOf(ScanAborted)
    expect(hits.some((h) => h.path.endsWith('/product-insights-refresh'))).toBe(true)
  })
})

describe('markdown export client', () => {
  it('fetches report.md with the device headers and returns the body text', async () => {
    routes.push({
      match: (m, p) => m === 'GET' && p.startsWith('/api/tools/public-insights/report.md'),
      reply: (h, res) => {
        expect(h.headers['x-krawlup-device']).toBeTruthy()
        expect(h.path).toContain('key=acme.dev')
        res!.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
        res!.end('# Site report — acme.dev')
      },
    })
    await expect(fetchPublicReportMd('acme.dev')).resolves.toBe('# Site report — acme.dev')
  })

  it('relays the 404 sentence when no scan has produced a report yet', async () => {
    routes.push({
      match: (m, p) => m === 'GET' && p.startsWith('/api/tools/public-insights/report.md'),
      reply: (_h, res) =>
        res!.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({
          statusCode: 404,
          message: 'No report data for this domain yet — run the free scan first.',
        })),
    })
    await expect(fetchPublicReportMd('acme.dev')).rejects.toThrow('No report data for this domain yet — run the free scan first.')
  })
})

describe('stage pacing model (the web panel’s numbers, mirrored)', () => {
  const pacing = stagePacing()

  it('keeps the documented proportions: queued 25s, lighthouse 45s are the big slices', () => {
    const total = PUBLIC_SCAN_STAGES.reduce((s, x) => s + x.seconds, 0)
    expect(total).toBeGreaterThan(80)
    expect(pacing.starts[stageIndexFor('lighthouse')]).toBeGreaterThan(0.4)
    expect(pacing.starts[stageIndexFor('lighthouse')]).toBeLessThan(0.75)
  })

  it('never crosses BAR_CEILING before the report read answers, and starts at 0', () => {
    expect(stageBarPct(stageIndexFor('queued'), 0)).toBe(0)
    for (let idx = 0; idx < PUBLIC_SCAN_STAGES.length; idx += 1) {
      expect(stageBarPct(idx, 0.001, pacing)).toBeLessThanOrEqual(BAR_CEILING)
      expect(stageBarPct(idx, 10_000, pacing)).toBeLessThanOrEqual(BAR_CEILING)
    }
  })

  it('moves monotonically forward as stages advance, even when the clock stalls', () => {
    let prev = 0
    for (let idx = 0; idx < PUBLIC_SCAN_STAGES.length; idx += 1) {
      const pct = stageBarPct(idx, 0, pacing)
      expect(pct).toBeGreaterThanOrEqual(prev)
      prev = pct
    }
  })

  it('the checklist covers every stage the server writes (queued…history, no fake stages)', () => {
    const ids = PUBLIC_SCAN_STAGES.map((s) => s.id)
    expect(ids).toEqual(['queued', 'capture', 'crux', 'lighthouse', 'scoring', 'history'])
    expect(stageIndexFor('queued')).toBe(0)
    expect(stageIndexFor('history')).toBe(PUBLIC_SCAN_STAGES.length - 1)
    expect(stageIndexFor('made-up-stage')).toBe(-1)
  })
})
