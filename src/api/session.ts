/**
 * The session layer: owns the stored session, token freshness, and the
 * silent refresh. The RPC client asks it for a current bearer token and
 * calls forceRefresh() on a 401; a dead refresh family (the server rotates
 * refresh tokens and kills the family on reuse) becomes ReLoginRequired.
 *
 * The oauth token endpoint is contacted directly here (not via the MCP
 * transport) with the persisted clientId and the canonical resource.
 */
import {
  assertApiBase,
  defaultApi,
  forgetSession,
  loadSession,
  saveSession,
  type OAuthSession,
  type Session,
} from '../connect/credentials.js'
import { discoverMetadata, isRefreshDead, refreshTokens } from './oauth.js'
import { ReLoginRequired } from './rpc.js'

let current: Session | null = loadSession()
let inflightRefresh: Promise<void> | null = null

export function getSession(): Session | null {
  return current
}

export async function setSession(session: Session | null): Promise<void> {
  current = session
  if (session) await saveSession(session)
  else await forgetSession()
}

export function isAuthed(): boolean {
  return current != null
}

/** Endpoint discovery is cached per api base — login and refresh share it. */
const metadataCache = new Map<string, Awaited<ReturnType<typeof discoverMetadata>>>()
async function metadata(apiBase: string) {
  let m = metadataCache.get(apiBase)
  if (!m) {
    m = await discoverMetadata(apiBase)
    metadataCache.set(apiBase, m)
  }
  return m
}


/**
 * A current bearer token. OAuth sessions refresh when inside the 60s
 * expiry margin; the KRAWLUP_KEY session is static.
 */
export async function bearer(): Promise<string> {
  const s = current
  if (!s) throw new ReLoginRequired()
  if (s.kind === 'key') return s.key
  if (s.expiresAt - 60_000 > Date.now()) return s.accessToken
  await refreshSession()
  return (current as OAuthSession).accessToken
}

/**
 * Force a refresh regardless of the expiry margin (the reactive 401 path).
 * A reused/rotated-away refresh token means the whole connection is dead:
 * ReLoginRequired, and the stale session is dropped.
 */
export async function forceRefresh(): Promise<void> {
  const s = current
  if (!s) throw new ReLoginRequired()
  if (s.kind === 'key') throw new ReLoginRequired() // a static key that 401s is simply dead
  inflightRefresh ??= doRefresh(s).finally(() => {
    inflightRefresh = null
  })
  return inflightRefresh
}

async function doRefresh(s: OAuthSession): Promise<void> {
  try {
    const m = await metadata(s.api)
    const tokens = await refreshTokens({
      tokenEndpoint: m.token_endpoint,
      clientId: s.clientId,
      refreshToken: s.refreshToken,
    })
    const next: OAuthSession = { ...s, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: Date.now() + tokens.expiresIn * 1000 }
    await setSession(next)
  } catch (e) {
    if (isRefreshDead(e)) {
      await setSession(null)
      throw new ReLoginRequired()
    }
    throw e
  }
}

async function refreshSession(): Promise<void> {
  const s = current
  if (!s || s.kind !== 'oauth') return
  inflightRefresh ??= doRefresh(s).finally(() => {
    inflightRefresh = null
  })
  return inflightRefresh
}

/** Validate an api base early (login and env overrides flow through here). */
export function normalizedApiBase(explicit?: string): string {
  const api = explicit || defaultApi()
  assertApiBase(api)
  return api.replace(/\/+$/, '')
}

export { discoverMetadata }
