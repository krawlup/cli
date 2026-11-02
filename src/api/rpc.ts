/**
 * The TUI's single data path: MCP tools/call over Streamable HTTP to the
 * krawlup API. Bearer auth comes from the caller's token provider (the
 * session layer, which refreshes proactively and reactively; or the
 * KRAWLUP_KEY escape hatch, which is static). The MCP SDK client owns the
 * initialize handshake; the server is stateless (fresh transport per
 * request) so one long-lived client is fine.
 *
 * Error discipline: every tool refusal arrives as an isError result whose
 * text is the server's own sentence ("This key does not have the "rescan"
 * permission", "This network has used its free scans…") — the UI relays
 * those verbatim. A 401 at the transport level means the access token died:
 * refresh once via the provider, rebuild the transport, retry once; if the
 * refresh is dead (rotated family), surface a re-login.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CLI_VERSION, deviceHeaders } from '../connect/identity.js'

export class ReLoginRequired extends Error {
  constructor() {
    super('Session expired — run `krawlup login` to sign in again')
  }
}

export class ToolError extends Error {}

export interface RpcOptions {
  apiBase: string
  /** Returns a CURRENT bearer token. May refresh internally; throws ReLoginRequired when the session is dead. */
  getAccessToken: () => Promise<string>
  /** Ask the provider to force a refresh NOW (reactive 401 path). Throws ReLoginRequired when unrefreshable. */
  forceRefresh: () => Promise<void>
}

export interface Rpc {
  call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T>
  close(): Promise<void>
}

export function mcpUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}/api/mcp`
}

function isUnauthorized(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /(^|\D)401(\D|$)|Unauthorized/i.test(msg)
}

/** Parse a tool result into plain data: structuredContent first, then the JSON text block. */
export function parseToolResult(result: any): any {
  if (!result) return null
  if (result.structuredContent !== undefined) return result.structuredContent
  const blocks: any[] = Array.isArray(result.content) ? result.content : []
  const text = blocks.find((b) => b?.type === 'text')?.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function createRpc(opts: RpcOptions): Promise<Rpc> {
  let client: Client | null = null
  let connecting: Promise<Client> | null = null

  const buildClient = async (): Promise<Client> => {
    const token = await opts.getAccessToken()
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl(opts.apiBase)), {
      requestInit: { headers: { authorization: `Bearer ${token}`, ...(await deviceHeaders()) } },
    })
    const c = new Client({ name: 'krawlup-tui', version: CLI_VERSION })
    await c.connect(transport)
    return c
  }

  const getClient = (): Promise<Client> => {
    if (client) return Promise.resolve(client)
    connecting ??= buildClient()
      .then((c) => {
        client = c
        return c
      })
      .catch((e) => {
        connecting = null
        throw e
      })
    return connecting
  }

  const resetClient = async (): Promise<void> => {
    if (client) {
      await client.close().catch(() => {})
      client = null
    }
    connecting = null
  }

  const attempt = async <T>(tool: string, args?: Record<string, unknown>): Promise<T> => {
    const c = await getClient()
    const result = await c.callTool({ name: tool, arguments: args ?? {} })
    if (result?.isError) {
      const blocks: any[] = Array.isArray(result.content) ? result.content : []
      const text = blocks.find((b) => b?.type === 'text')?.text
      throw new ToolError(typeof text === 'string' && text ? text : 'the request failed')
    }
    return parseToolResult(result) as T
  }

  return {
    async call<T = any>(tool: string, args?: Record<string, unknown>): Promise<T> {
      try {
        return await attempt<T>(tool, args)
      } catch (e) {
        if (e instanceof ToolError) throw e
        if (isUnauthorized(e)) {
          // One silent refresh + rebuild + retry; a dead refresh family
          // surfaces as ReLoginRequired from the provider. A TRANSIENT
          // failure during the refresh itself (network blip) must not log
          // the user out — retry the refresh once before giving up.
          await opts.forceRefresh().catch(async (err) => {
            if (err instanceof ReLoginRequired) throw err
            try {
              await opts.forceRefresh()
            } catch (err2) {
              if (err2 instanceof ReLoginRequired) throw err2
              throw new ToolError(err2 instanceof Error ? err2.message : String(err2))
            }
          })
          await resetClient()
          try {
            return await attempt<T>(tool, args)
          } catch (e2) {
            if (e2 instanceof ToolError) throw e2
            if (isUnauthorized(e2)) throw new ReLoginRequired()
            throw new ToolError(e2 instanceof Error ? e2.message : String(e2))
          }
        }
        throw new ToolError(e instanceof Error ? e.message : String(e))
      }
    },
    close: resetClient,
  }
}
