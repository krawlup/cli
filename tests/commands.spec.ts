/**
 * The command layer's honesty contract: get_insights answers a never-scanned
 * product with the server's plain-text sentence — that must surface verbatim
 * as a ToolError (never an empty block over a string), and the polling loop
 * must treat it as "still pending".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'

let server: Server
let baseUrl = ''
const realFetch = globalThis.fetch

function jsonRpc(id: any, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

beforeEach(async () => {
  vi.resetModules()
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let msg: any
      try { msg = JSON.parse(body) } catch { res.writeHead(400).end(); return }
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(jsonRpc(msg.id ?? null, result))
      }
      if (msg.method === 'initialize') {
        reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock', version: '1' } })
        return
      }
      if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return }
      if (msg.method === 'tools/call') {
        if (msg.params?.name === 'get_insights') {
          const productKey = String(msg.params?.arguments?.productKey || '')
          if (productKey.includes('refuse')) {
            reply({ content: [{ type: 'text', text: 'Website analytics requires an active subscription with the website_analytics facility.' }], isError: true })
            return
          }
          reply({ content: [{ type: 'text', text: 'No insights yet — call trigger_rescan first.' }], isError: false })
          return
        }
        reply({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }], isError: false })
        return
      }
      res.writeHead(400).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as { port: number }
  baseUrl = `http://localhost:${addr.port}`
  process.env.KRAWLUP_KEY = 'sk_ag_test'
  process.env.KRAWLUP_API = baseUrl
})

afterEach(async () => {
  delete process.env.KRAWLUP_KEY
  delete process.env.KRAWLUP_API
  globalThis.fetch = realFetch
  await new Promise<void>((r) => server.close(() => r()))
})

describe('fetchInsights honesty', () => {
  it('relays the never-scanned sentence verbatim as a ToolError', async () => {
    const { fetchInsights, ToolError } = await import('../src/api/commands.js')
    await expect(fetchInsights('never-scanned.com')).rejects.toThrow('No insights yet — call trigger_rescan first.')
    await expect(fetchInsights('never-scanned.com')).rejects.toBeInstanceOf(ToolError)
  })

  it('other tools keep parsing object payloads (the guard is insights-only)', async () => {
    const { fetchProductStatuses } = await import('../src/api/commands.js')
    const res = await fetchProductStatuses()
    expect(res).toEqual([])
  })
})

describe('waitForScan honesty', () => {
  it('treats ONLY the never-scanned sentence as pending, and rethrows every other refusal immediately', async () => {
    const { waitForScan, fetchInsights, NoInsightsYetError, ToolError } = await import('../src/api/commands.js')

    // The mock's "No insights yet" product: polls as pending until deadline.
    // The window is generous against the 10ms interval — a loaded CI box
    // must not turn this pin into a flake — while still bounding the test.
    const updates: Array<{ pending: boolean }> = []
    await waitForScan('never-scanned.com', (u) => updates.push(u), { intervalMs: 10, deadlineMs: 400 })
    expect(updates.length).toBeGreaterThan(1)
    expect(updates[updates.length - 1]!.pending).toBe(true)

    // The sentinel is a ToolError subclass, so verbatim relay keeps working.
    await expect(fetchInsights('never-scanned.com')).rejects.toBeInstanceOf(NoInsightsYetError)
    await expect(fetchInsights('never-scanned.com')).rejects.toBeInstanceOf(ToolError)

    // A plan-gate refusal is a real answer — it must surface AT ONCE, not
    // wedge the UI polling until the deadline.
    const started = Date.now()
    await expect(waitForScan('refuse-me.com', () => {}, { intervalMs: 10, deadlineMs: 60_000 })).rejects.toThrow(
      'requires an active subscription',
    )
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
