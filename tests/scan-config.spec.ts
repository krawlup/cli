/**
 * The free-scan allowance is SERVER-owned (admin setting
 * `publicScanCliScansPerMonth`), so the CLI may not advertise a number of its
 * own. Pinned here: the 0/unknown start state, the config read (with the
 * optional bearer so a beta tester is told "unlimited"), the total failure
 * mode that leaves the state unknown instead of guessing, and the copy the
 * helpers produce for 0 / 1 / n / beta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/krawlup-cli-scan-config-home` }
})

process.env.KRAWLUP_SKIP_DEVICE_FILE = '1'

const REAL_FETCH = globalThis.fetch

let server: Server | null = null
let baseUrl = ''
const hits: Array<{ path: string; headers: Record<string, string> }> = []
let reply: (path: string, headers: Record<string, string>) => { status: number; body: unknown } = () => ({
  status: 404,
  body: { message: 'not found' },
})

beforeEach(async () => {
  hits.length = 0
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += String(c)))
    req.on('end', () => {
      const url = new URL(String(req.url), 'http://x')
      hits.push({ path: url.pathname, headers: req.headers as Record<string, string> })
      const out = reply(url.pathname, req.headers as Record<string, string>)
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out.body))
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
  delete process.env.KRAWLUP_KEY
})

import { UNKNOWN_SCAN_CONFIG, reportLeadPhrase, scanAllowance, scanAllowanceDetail, scansSpentMessage } from '../src/lib/scan-allowance.js'
import { fetchScanConfig } from '../src/api/public-scan.js'
import { refreshScanConfig, scanConfig } from '../src/state/scan-config.js'
import { setSession } from '../src/api/session.js'

describe('allowance state', () => {
  it('starts at 0 and unknown — a zero before the fetch is not a claim', () => {
    expect(UNKNOWN_SCAN_CONFIG).toMatchObject({
      cliScansPerMonth: 0,
      webScansPerMonth: 0,
      pageSpeedChecksPerDay: 0,
      betaUnlimited: false,
      loaded: false,
    })
    expect(scanAllowance(UNKNOWN_SCAN_CONFIG)).toContain('checking')
  })

  it('reads the config from the public endpoint', async () => {
    reply = () => ({
      status: 200,
      body: { channel: 'cli', scansPerMonth: 2, cliScansPerMonth: 2, webScansPerMonth: 2, pageSpeedChecksPerDay: 1, betaUnlimited: false, signedIn: false },
    })
    const cfg = await fetchScanConfig(baseUrl)
    expect(cfg.cliScansPerMonth).toBe(2)
    expect(hits[0]?.path).toBe('/api/tools/public-insights/scan-config')
    // No session: the request stays anonymous (the endpoint grants nothing).
    expect(hits[0]?.headers.authorization).toBeUndefined()
  })

  it('publishes the fetched numbers and keeps them best-effort', async () => {
    reply = () => ({
      status: 200,
      body: { cliScansPerMonth: 3, webScansPerMonth: 2, pageSpeedChecksPerDay: 1, betaUnlimited: false, signedIn: false },
    })
    const next = await refreshScanConfig(baseUrl)
    expect(next).toMatchObject({ cliScansPerMonth: 3, loaded: true })
    expect(scanConfig.get().cliScansPerMonth).toBe(3)

    // The endpoint disappearing must NOT throw at a command, and the store
    // keeps its last-known numbers (loaded stays true) rather than inventing
    // a new one — the sentence the user is actually held to is the server's
    // own 429 at scan time.
    reply = () => ({ status: 500, body: { message: 'boom' } })
    const after = await refreshScanConfig(baseUrl)
    expect(after.cliScansPerMonth).toBe(3)
    expect(after.loaded).toBe(true)
  })

  it('reports beta testers as unlimited when a session is present', async () => {
    setSession({ kind: 'oauth', api: baseUrl, accessToken: 'tok', refreshToken: 'ref', expiresAt: Date.now() + 3_600_000, clientId: 'krawlup-cli' })
    reply = () => ({
      status: 200,
      body: { cliScansPerMonth: 0, webScansPerMonth: 2, pageSpeedChecksPerDay: 1, betaUnlimited: true, signedIn: true },
    })
    const cfg = await refreshScanConfig(baseUrl)
    expect(hits[0]?.headers.authorization).toBe('Bearer tok')
    expect(cfg.betaUnlimited).toBe(true)
    expect(scanAllowance(cfg)).toContain('unlimited')
  })
})

describe('allowance copy', () => {
  const base = { ...UNKNOWN_SCAN_CONFIG, loaded: true, webScansPerMonth: 2, pageSpeedChecksPerDay: 1 }

  it('never promises free scans when the pool is switched off', () => {
    const off = { ...base, cliScansPerMonth: 0 }
    expect(scanAllowance(off)).toBe('no free CLI scans right now')
    expect(scanAllowanceDetail(off)).toContain('beta testers scan unlimited')
    const msg = scansSpentMessage(off)
    expect(msg).toContain('switched off')
    expect(msg).not.toContain('one free CLI scan')
  })

  it('quotes 1 and n exactly', () => {
    expect(scanAllowance({ ...base, cliScansPerMonth: 1 })).toBe('1 free scan/month per device')
    expect(scansSpentMessage({ ...base, cliScansPerMonth: 1 })).toContain('your one free CLI scan')
    expect(scanAllowance({ ...base, cliScansPerMonth: 4 })).toBe('4 free scans/month per device')
    expect(scansSpentMessage({ ...base, cliScansPerMonth: 4 })).toContain('your 4 free CLI scans')
  })

  it('says unlimited for a beta tester instead of a countdown', () => {
    const beta = { ...base, cliScansPerMonth: 0, betaUnlimited: true }
    expect(scanAllowance(beta)).toContain('beta tester')
    expect(scanAllowanceDetail(beta)).toContain('unlimited')
  })

  it('the report lead drops "scan" while the pool is off — help screen and command list agree', () => {
    const off = { ...base, cliScansPerMonth: 0 }
    expect(reportLeadPhrase({ ...base, cliScansPerMonth: 1 })).toBe('FREE full site scan + report')
    expect(reportLeadPhrase(off)).toBe('full site report')
    expect(reportLeadPhrase({ ...UNKNOWN_SCAN_CONFIG })).toBe('FREE full site scan + report')
    expect(reportLeadPhrase({ ...base, cliScansPerMonth: 0, betaUnlimited: true })).toBe('FREE full site scan + report')
  })
})
