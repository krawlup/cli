/**
 * The login/logout orchestration shared by the TUI and argv mode.
 * Login is OAuth in the browser — the CLI runs under the server's seeded
 * first-party client when it advertises one (so the consent screen knows
 * this is our own app), else it registers (or reuses) its client, opens
 * the consent screen, captures the loopback redirect, and stores the
 * rotating token pair. A persisted client_id that the server no longer
 * knows falls back to one fresh registration.
 */
import { clearCache } from '../state/store.js'
import { setSession, getSession, normalizedApiBase } from './session.js'
import { browserLogin, discoverMetadata, openBrowser, revokeSession } from './oauth.js'
import type { OAuthSession } from '../connect/credentials.js'
import { forgetDeviceId } from '../connect/identity.js'
import { resetRpc } from './commands.js'

export interface LoginOutcome {
  api: string
}

export async function runLogin(opts: {
  apiBase?: string
  /** Called once the authorize URL is ready; `opened` says the browser launch succeeded. */
  onUrl: (url: string, opened: boolean) => void
}): Promise<LoginOutcome> {
  const api = normalizedApiBase(opts.apiBase)
  const metadata = await discoverMetadata(api)
  const prior = getSession()?.kind === 'oauth' ? (getSession() as OAuthSession).clientId : ''

  const attempt = async (priorClientId?: string) =>
    browserLogin({
      metadata,
      priorClientId: priorClientId || undefined,
      onAuthorizeUrl: (url) => {
        void openBrowser(url).then((opened) => opts.onUrl(url, opened))
      },
    })

  let out
  try {
    out = await attempt(prior || undefined)
  } catch (e) {
    // A stale persisted client (server-side cleanup) fails the whole flow —
    // the browser shows a plain 400 and the loopback waits out its timeout.
    // With a prior client, ANY failure gets exactly one retry on a
    // brand-new registration; without one, the failure is real.
    if (prior) {
      out = await attempt(undefined)
    } else {
      throw e
    }
  }

  await setSession({
    kind: 'oauth',
    api,
    accessToken: out.tokens.accessToken,
    refreshToken: out.tokens.refreshToken,
    expiresAt: Date.now() + out.tokens.expiresIn * 1000,
    clientId: out.clientId,
  })
  await resetRpc()
  clearCache()
  return { api }
}

export async function runLogout(): Promise<void> {
  const s = getSession()
  if (s?.kind === 'oauth') {
    try {
      const m = await discoverMetadata(s.api)
      // RFC 7009: revoking the refresh token kills the whole token family
      // (the server cascades to the access token); the access token goes
      // too, best-effort, for providers that do not cascade.
      await revokeSession(m.revocation_endpoint, s.clientId, s.refreshToken)
      await revokeSession(m.revocation_endpoint, s.clientId, s.accessToken)
    } catch {
      /* best effort — the local session is deleted regardless */
    }
  }
  await setSession(null)
  // The device id is a per-install correlation handle — logout deletes it
  // so the next login starts as a fresh device.
  await forgetDeviceId().catch(() => {})
  await resetRpc()
  clearCache()
}
