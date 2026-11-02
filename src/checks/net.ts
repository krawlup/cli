/**
 * The local fetcher for the battery: plain native fetch straight at the
 * target the user named. This runs on the USER's machine at their explicit
 * request — the same trust model as curl — so it deliberately carries no
 * SSRF guard (that is a server-side concern for URLs strangers submit).
 *
 * What it DOES carry: bounded redirects with the chain preserved, a hard
 * byte cap on the body, a per-request timeout, and a stable User-Agent.
 */

import { CLI_VERSION } from '../lib/version.js'

export const KRAWLUP_CLI_UA = `Mozilla/5.0 (compatible; krawlup-cli/${CLI_VERSION}; +https://krawlup.com/cli)`
/** The GPTBot identity, for `krawlup text --as-bot` ("what GPTBot sees"). */
export const GPTBOT_UA = 'GPTBot/1.0 (+https://openai.com/gptbot)'

export const DEFAULT_TIMEOUT_MS = 12_000
export const DEFAULT_CAP_BYTES = 2_000_000
export const MAX_REDIRECTS = 5

export interface FetchPageResult {
  /** Final URL after redirects — where the content actually came from. */
  url: string
  status: number
  /** Lowercased header names; repeated headers joined with ', '. */
  headers: Record<string, string>
  body: string
  truncated: boolean
  redirectChain: string[]
}

export interface LocalFetchOptions {
  ua?: string
  timeoutMs?: number
  capBytes?: number
  maxRedirects?: number
  method?: 'GET' | 'HEAD'
}

function headersRecord(res: Response): Record<string, string> {
  const out: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    out[k] = out[k] ? `${out[k]}, ${value}` : value
  })
  return out
}

async function readBody(res: Response, capBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: '', truncated: false }
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let received = 0
  let body = ''
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received >= capBytes) {
        const capped = value.subarray(0, Math.max(0, value.byteLength - (received - capBytes)))
        body += decoder.decode(capped, { stream: false })
        truncated = true
        void reader.cancel().catch(() => {})
        break
      }
      body += decoder.decode(value, { stream: true })
    }
  } finally {
    if (!truncated) void reader.cancel().catch(() => {})
  }
  return { body: body + decoder.decode(), truncated }
}

/**
 * GET/HEAD a page with manual redirect following. Network failures and
 * non-2xx statuses are RESULTS, not exceptions — the caller verdicts them —
 * but a URL that cannot even be parsed throws (usage error territory).
 */
export async function localFetch(rawUrl: string, opts: LocalFetchOptions = {}): Promise<FetchPageResult> {
  const {
    ua = KRAWLUP_CLI_UA,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    capBytes = DEFAULT_CAP_BYTES,
    maxRedirects = MAX_REDIRECTS,
    method = 'GET',
  } = opts

  let current = new URL(rawUrl).toString()
  if (!/^https?:$/.test(new URL(current).protocol)) throw new Error(`only http(s) URLs are fetched: ${rawUrl}`)
  const chain: string[] = []

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(current, {
      method,
      headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) {
        return { url: current, status: res.status, headers: headersRecord(res), body: '', truncated: false, redirectChain: chain }
      }
      const next = new URL(location, current)
      if (!/^https?:$/.test(next.protocol)) {
        throw new Error(`redirect to a non-http(s) scheme at ${current}: ${next.protocol}`)
      }
      chain.push(next.toString())
      current = next.toString()
      continue
    }

    const headers = headersRecord(res)
    if (method === 'HEAD') {
      void res.body?.cancel().catch(() => {})
      return { url: current, status: res.status, headers, body: '', truncated: false, redirectChain: chain }
    }
    const { body, truncated } = await readBody(res, capBytes)
    return { url: current, status: res.status, headers, body, truncated, redirectChain: chain }
  }

  // Redirect cap exhausted: report the last hop's status as a too-deep chain.
  throw new Error(`more than ${maxRedirects} redirects: ${current}`)
}
