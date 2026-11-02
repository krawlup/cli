/**
 * The RPC client contract, against a scripted fetch (no real network):
 *   - tool results parse from structuredContent or the JSON text block
 *   - a tool refusal (isError) surfaces the server's own sentence verbatim
 *   - a 401 mid-session triggers exactly one silent refresh, rebuilds the
 *     transport with the NEW token, and retries — the refresh spy is called
 *     once and the retry carries the refreshed Authorization header
 *   - a dead refresh (forceRefresh throws) becomes ReLoginRequired
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRpc, mcpUrl, parseToolResult, ReLoginRequired, ToolError } from '../src/api/rpc.js'

type JsonRpcBody = { id?: number | string | null; method?: string; params?: any }

function jsonRpc(id: number | string | null, result: unknown, status = 200): Response {
  return new Response(status === 200 ? JSON.stringify({ jsonrpc: '2.0', id, result }) : '', {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function toolResult(value: unknown): any {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
}

beforeEach(() => {
  process.env.KRAWLUP_SKIP_DEVICE_FILE = '1'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseToolResult', () => {
  it('prefers structuredContent, falls back to the JSON text block, passes raw text through', () => {
    expect(parseToolResult({ structuredContent: { a: 1 } })).toEqual({ a: 1 })
    expect(parseToolResult({ content: [{ type: 'text', text: '{"b":2}' }] })).toEqual({ b: 2 })
    expect(parseToolResult({ content: [{ type: 'text', text: 'plain refusal' }] })).toBe('plain refusal')
    expect(parseToolResult(null)).toBeNull()
  })
})

describe('createRpc over a scripted server', () => {
  it('calls a tool and returns the parsed payload', async () => {
    const seen: Array<{ auth?: string; method?: string }> = []
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as JsonRpcBody
      seen.push({ auth: new Headers(init?.headers).get('authorization') ?? undefined, method: body.method })
      if (body.method === 'initialize') return jsonRpc(body.id ?? null, { protocolVersion: body.params?.protocolVersion ?? '2025-06-18', capabilities: {}, serverInfo: { name: 'k', version: '1' } })
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 })
      if (body.method === 'tools/call') return jsonRpc(body.id ?? null, toolResult({ ok: true, visitors: 7 }))
      return new Response('', { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rpc = await createRpc({ apiBase: 'https://krawlup.com', getAccessToken: async () => 't1', forceRefresh: async () => {} })
    const out = await rpc.call<{ ok: boolean; visitors: number }>('get_website_analytics', { productKey: 'example.com' })
    expect(out.ok).toBe(true)
    expect(out.visitors).toBe(7)
    expect(seen.some((s) => s.method === 'tools/call' && s.auth === 'Bearer t1')).toBe(true)
    await rpc.close()
  })

  it('relays a tool refusal verbatim as a ToolError', async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as JsonRpcBody
      if (body.method === 'initialize') return jsonRpc(body.id ?? null, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'k', version: '1' } })
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 })
      if (body.method === 'tools/call') {
        return jsonRpc(body.id ?? null, { content: [{ type: 'text', text: 'This key does not have the "rescan" permission' }], isError: true })
      }
      return new Response('', { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rpc = await createRpc({ apiBase: 'https://krawlup.com', getAccessToken: async () => 't1', forceRefresh: async () => {} })
    await expect(rpc.call('trigger_rescan')).rejects.toThrow('This key does not have the "rescan" permission')
    await rpc.close()
  })

  it('on 401: refreshes once, rebuilds with the new token, retries — then keeps working', async () => {
    const seen: Array<{ auth?: string; method?: string }> = []
    let toolCalls = 0
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as JsonRpcBody
      seen.push({ auth: new Headers(init?.headers).get('authorization') ?? undefined, method: body.method })
      if (body.method === 'initialize') return jsonRpc(body.id ?? null, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'k', version: '1' } })
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 })
      if (body.method === 'tools/call') {
        toolCalls += 1
        if (toolCalls === 1) {
          // The access token died between initialize and the first call.
          return new Response('unauthorized', { status: 401 })
        }
        return jsonRpc(body.id ?? null, toolResult({ ok: true, after: 'refresh' }))
      }
      return new Response('', { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)

    let token = 't1'
    let refreshes = 0
    const rpc = await createRpc({
      apiBase: 'https://krawlup.com',
      getAccessToken: async () => token,
      forceRefresh: async () => {
        refreshes += 1
        token = 't2'
      },
    })
    const out = await rpc.call<{ after: string }>('get_insights', { productKey: 'example.com' })
    expect(out.after).toBe('refresh')
    expect(refreshes).toBe(1)
    expect(toolCalls).toBe(2)
    // The retry's fresh transport must carry the NEW token on initialize.
    const postRefreshInit = seen.filter((s) => s.method === 'initialize').at(-1)
    expect(postRefreshInit?.auth).toBe('Bearer t2')
    await rpc.close()
  })

  it('a dead refresh family becomes ReLoginRequired, never a silent retry loop', async () => {
    let toolCalls = 0
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as JsonRpcBody
      if (body.method === 'initialize') return jsonRpc(body.id ?? null, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'k', version: '1' } })
      if (body.method === 'notifications/initialized') return new Response('', { status: 202 })
      if (body.method === 'tools/call') {
        toolCalls += 1
        return new Response('unauthorized', { status: 401 })
      }
      return new Response('', { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const rpc = await createRpc({
      apiBase: 'https://krawlup.com',
      getAccessToken: async () => 't1',
      forceRefresh: async () => {
        throw new ReLoginRequired()
      },
    })
    await expect(rpc.call('list_products')).rejects.toBeInstanceOf(ReLoginRequired)
    expect(toolCalls).toBe(1) // no infinite retry
    await rpc.close()
  })

  it('builds the MCP url from the api base', () => {
    expect(mcpUrl('https://krawlup.com')).toBe('https://krawlup.com/api/mcp')
    expect(mcpUrl('https://krawlup.com/')).toBe('https://krawlup.com/api/mcp')
  })
})
