/**
 * The browser login: MCP-grade OAuth 2.1 against the krawlup API.
 *
 * Flow (RFC 8252 native-app shape over the server's OAuth 2.1 provider):
 *   1. discover the authorization-server metadata (/.well-known/…)
 *   2. use the server's well-known first-party client when it advertises
 *      one (first_party_client_id — the seeded "Krawlup CLI" row, so the
 *      consent screen knows this is our own app); otherwise reuse the
 *      persisted registration, or dynamically register "Krawlup CLI" with
 *      an http://127.0.0.1/callback redirect (the server relaxes loopback
 *      ports per RFC 8252 §7.3)
 *   3. start a loopback HTTP listener on an ephemeral port
 *   4. open the browser at /oauth/authorize with PKCE (S256) and
 *      scope="read rescan submit" — the consent screen shows exactly that
 *   5. catch the ?code= redirect, exchange it (with the verifier) for
 *      access + refresh tokens
 * Refresh tokens rotate on every use server-side; refreshSession() stores
 * each new pair immediately, and a reused-refresh response (invalid_grant)
 * means the session is dead — the caller sends the user back to login.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { deviceHeaders } from '../connect/identity.js'
import { assertApiBase } from '../connect/credentials.js'

const DISCOVERY_PATH = '/.well-known/oauth-authorization-server'
const SCOPES = 'read rescan submit'
const CLIENT_NAME = 'Krawlup CLI'

export interface ServerMetadata {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint: string
  revocation_endpoint: string
  /** The server's seeded krawlup-owned public client, when it has one. */
  first_party_client_id?: string
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope?: string
}

export class OAuthError extends Error {
  constructor(message: string, public code?: string) {
    super(message)
  }
}

// ── PKCE (S256 only — the server forbids plain) ────────────────────

export function newCodeVerifier(): string {
  // 43-128 chars of [A-Za-z0-9\-._~]; 32 random bytes base64url = 43 chars.
  return randomBytes(48).toString('base64url')
}

export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function newState(): string {
  return randomBytes(24).toString('base64url')
}

// ── Discovery + registration ───────────────────────────────────────

export async function discoverMetadata(apiBase: string): Promise<ServerMetadata> {
  const res = await fetch(`${apiBase}${DISCOVERY_PATH}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new OAuthError(`could not read the krawlup OAuth metadata (HTTP ${res.status})`)
  const json = (await res.json()) as Partial<ServerMetadata>
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'] as const) {
    if (!json[key]) throw new OAuthError(`krawlup OAuth metadata is missing ${key}`)
  }
  // The endpoints receive the authorization code and the PKCE verifier — a
  // hostile or misconfigured metadata doc must not be allowed to point them
  // at plain-http or third-party hosts. Same policy as the API base itself.
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'revocation_endpoint'] as const) {
    if (json[key]) assertApiBase(json[key]!)
  }
  return json as ServerMetadata
}

export interface ClientRegistration {
  client_id: string
  client_name?: string
}

export async function registerClient(registrationEndpoint: string, redirectUri: string): Promise<string> {
  const res = await fetch(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(await deviceHeaders()) },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [redirectUri],
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new OAuthError(`client registration failed (HTTP ${res.status}) ${text.slice(0, 200)}`.trim())
  }
  const json = (await res.json()) as ClientRegistration
  if (!json.client_id) throw new OAuthError('client registration returned no client_id')
  return json.client_id
}

// ── Loopback redirect capture ──────────────────────────────────────

export interface LoopbackResult {
  code: string | null
  state: string | null
  error: string | null
  errorDescription: string | null
}

const RECEIVED_PAGE = '<!doctype html><title>krawlup</title><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><p style="text-align:center">krawlup login received — you can close this tab and return to the terminal.</p></body>'

const REJECTED_PAGE = '<!doctype html><title>krawlup</title><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><p style="text-align:center">This login link is no longer valid — return to the terminal and try again.</p></body>'

/**
 * Listen on 127.0.0.1:<ephemeral>/callback until the browser redirect
 * arrives. Only a GET whose `state` matches `expectedState` resolves the
 * capture — a forged first hit (a local process, or a remote page
 * navigating to the loopback URL) gets a 400 and the listener keeps
 * waiting for the real redirect, whose state the forger cannot know.
 * Rejects after `timeoutMs`.
 */
export function captureLoopbackRedirect(timeoutMs: number, expectedState: string): Promise<{ port: number; close: () => void; result: Promise<LoopbackResult> }> {
  let listenPort = 0
  const server = createServer((req, res) => {
    const host = String(req.headers.host || '')
    const okHost = listenPort > 0 && (host === `127.0.0.1:${listenPort}` || host === `localhost:${listenPort}`)
    if (req.method !== 'GET') {
      res.writeHead(405).end()
      return
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback' || !okHost) {
      res.writeHead(404).end()
      return
    }
    if (url.searchParams.get('state') !== expectedState) {
      // Not the redirect we sent (CSRF / scan / stale tab) — refuse without
      // consuming the one-shot capture.
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(REJECTED_PAGE)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(RECEIVED_PAGE)
    resolveCapture({
      code: url.searchParams.get('code'),
      state: url.searchParams.get('state'),
      error: url.searchParams.get('error'),
      errorDescription: url.searchParams.get('error_description'),
    })
  })
  let resolveCapture!: (r: LoopbackResult) => void
  const result = new Promise<LoopbackResult>((resolve) => {
    resolveCapture = resolve
  })
  const timeout = setTimeout(() => {
    resolveCapture({ code: null, state: null, error: 'timeout', errorDescription: 'timed out waiting for the browser login — try again' })
    server.close()
  }, timeoutMs)
  return new Promise((resolve, reject) => {
    server.once('close', () => clearTimeout(timeout))
    server.once('error', (e) => {
      clearTimeout(timeout)
      reject(e)
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close()
        reject(new OAuthError('could not bind the loopback listener'))
        return
      }
      listenPort = addr.port
      resolve({ port: addr.port, close: () => server.close(), result })
    })
  })
}

export function buildAuthorizeUrl(input: {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  verifier: string
  state: string
}): string {
  // No RFC 8707 `resource` parameter: the API accepts several spellings of
  // its own URL but none covers both possible API bases (site origin vs API
  // origin), and an absent resource is explicitly supported — stored null,
  // accepted at use time.
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: SCOPES,
    state: input.state,
    code_challenge: codeChallenge(input.verifier),
    code_challenge_method: 'S256',
  })
  return `${input.authorizationEndpoint}?${q.toString()}`
}

// ── Token exchange + refresh ───────────────────────────────────────

async function tokenRequest(tokenEndpoint: string, params: URLSearchParams): Promise<TokenPair> {
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(await deviceHeaders()) },
    body: params.toString(),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json().catch(() => ({}))) as any
  if (!res.ok || json.error) {
    throw new OAuthError(
      json.error_description || json.error || `token request failed (HTTP ${res.status})`,
      json.error,
    )
  }
  if (!json.access_token || !json.refresh_token) {
    throw new OAuthError('the token response was missing tokens')
  }
  return {
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token),
    expiresIn: Number(json.expires_in) || 3600,
    scope: json.scope,
  }
}

export async function exchangeCode(input: {
  tokenEndpoint: string
  clientId: string
  redirectUri: string
  code: string
  verifier: string
}): Promise<TokenPair> {
  return tokenRequest(input.tokenEndpoint, new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  }))
}

export async function refreshTokens(input: {
  tokenEndpoint: string
  clientId: string
  refreshToken: string
}): Promise<TokenPair> {
  return tokenRequest(input.tokenEndpoint, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  }))
}

export async function revokeSession(revocationEndpoint: string, clientId: string, token: string): Promise<void> {
  // Best-effort: the local session is deleted regardless.
  await fetch(revocationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(await deviceHeaders()) },
    body: new URLSearchParams({ client_id: clientId, token }).toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {})
}

/**
 * Best-effort browser open across platforms; false when nothing worked.
 * Missing binaries surface as an async 'error' event (not a throw), so
 * each candidate gets a short grace window before we fall back to the
 * next one — and finally to printing the URL.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const candidates: Array<{ cmd: string; args: string[] }> =
    process.platform === 'darwin'
      ? [{ cmd: 'open', args: [url] }]
      : process.platform === 'win32'
        ? [{ cmd: 'cmd', args: ['/c', 'start', '', url] }]
        : [{ cmd: 'xdg-open', args: [url] }]
  for (const c of candidates) {
    try {
      const child = spawn(c.cmd, c.args, { stdio: 'ignore', detached: true })
      const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), 750)
        child.once('error', () => {
          clearTimeout(timer)
          resolve(false)
        })
      })
      child.unref()
      if (opened) return true
    } catch {
      /* try the next candidate */
    }
  }
  return false
}

/**
 * Which client id this login runs under: the server's advertised
 * first-party client wins (it migrates old dynamic registrations to the
 * seeded "Krawlup CLI" row), then the persisted registration, and null
 * means the caller must register dynamically.
 */
export function pickClientId(
  metadata: Pick<ServerMetadata, 'first_party_client_id'>,
  priorClientId?: string,
): string | null {
  return metadata.first_party_client_id || priorClientId || null
}

/**
 * The whole interactive login. Resolves with the tokens + the loopback
 * redirect URI that was registered (persist it alongside the tokens —
 * the server matches the registered path, relaxing only the port).
 */
export async function browserLogin(input: {
  metadata: ServerMetadata
  /** A previously persisted client_id — reused when the server still knows it. */
  priorClientId?: string
  onAuthorizeUrl: (url: string) => void
}): Promise<{ tokens: TokenPair; clientId: string; redirectUri: string }> {
  // The state is minted BEFORE the listener so the capture can reject
  // anything that was not minted by this very flow.
  const verifier = newCodeVerifier()
  const state = newState()
  // A reused client_id the server no longer knows fails at the authorize
  // page and never redirects; a shorter first-attempt window keeps that
  // failure bounded — the caller retries once on a fresh registration
  // (which gets the full window for the real consent).
  const loopback = await captureLoopbackRedirect(input.priorClientId ? 120_000 : 5 * 60_000, state)
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`
  try {
    // The server's first-party client (when advertised) needs no
    // registration; a persisted one is reused because the server matches
    // the registered redirect path and relaxes only the loopback port. An
    // unknown client fails at authorize with a plain 400 and the caller
    // falls back to a fresh registration.
    const picked = pickClientId(input.metadata, input.priorClientId)
    const clientId = picked ?? (await registerClient(input.metadata.registration_endpoint, redirectUri))
    const authorizeUrl = buildAuthorizeUrl({
      authorizationEndpoint: input.metadata.authorization_endpoint,
      clientId,
      redirectUri,
      verifier,
      state,
    })
    input.onAuthorizeUrl(authorizeUrl)

    const landed = await loopback.result
    if (landed.error || !landed.code) {
      throw new OAuthError(landed.errorDescription || landed.error || 'the browser login was cancelled')
    }
    // Defense in depth — the capture already refuses mismatched states;
    // this also covers a resolved-but-missing state param.
    if (!landed.state || landed.state !== state) {
      throw new OAuthError('the login response did not match the request (state mismatch) — nothing was exchanged')
    }
    const tokens = await exchangeCode({
      tokenEndpoint: input.metadata.token_endpoint,
      clientId,
      redirectUri,
      code: landed.code,
      verifier,
    })
    return { tokens, clientId, redirectUri }
  } finally {
    loopback.close()
  }
}

/** True when an error looks like a dead refresh family (re-login required). */
export function isRefreshDead(e: unknown): boolean {
  return e instanceof OAuthError && (e.code === 'invalid_grant' || e.code === 'invalid_client')
}
