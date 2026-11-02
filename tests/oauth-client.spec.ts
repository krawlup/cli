/**
 * The OAuth client contracts: PKCE shape, the loopback redirect capture
 * (we complete the flow ourselves against the listener the way the browser
 * would), and the authorize URL carrying exactly the consent scopes the
 * server now grants (read rescan submit).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { request as httpRequest } from 'node:http'
import {
  buildAuthorizeUrl,
  captureLoopbackRedirect,
  codeChallenge,
  isRefreshDead,
  newCodeVerifier,
  newState,
  OAuthError,
  pickClientId,
} from '../src/api/oauth.js'

describe('client id selection', () => {
  it('the server-advertised first-party client wins over a persisted registration', () => {
    // Migration path: an old dynamic-registration id gives way to the
    // seeded "Krawlup CLI" row as soon as the server advertises it.
    expect(pickClientId({ first_party_client_id: 'krawlup-cli' }, 'dcr-abc123')).toBe('krawlup-cli')
  })

  it('a persisted registration is reused when no first-party client is advertised (older server)', () => {
    expect(pickClientId({}, 'dcr-abc123')).toBe('dcr-abc123')
  })

  it('neither means the caller must register dynamically', () => {
    expect(pickClientId({})).toBeNull()
  })
})

describe('pkce + state', () => {
  it('mints spec-shaped verifiers and S256 challenges', () => {
    const verifier = newCodeVerifier()
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    const challenge = codeChallenge(verifier)
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43,128}$/)
    // Deterministic: same verifier → same challenge.
    expect(codeChallenge(verifier)).toBe(challenge)
    // State is unique per call.
    expect(newState()).not.toBe(newState())
  })
})

describe('authorize url', () => {
  it('carries code + PKCE S256 + the full consent scope, and NO resource indicator', () => {
    const url = new URL(buildAuthorizeUrl({
      authorizationEndpoint: 'https://krawlup.com/oauth/authorize',
      clientId: 'abc',
      redirectUri: 'http://127.0.0.1:9999/callback',
      verifier: newCodeVerifier(),
      state: 'st4te',
    }))
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('abc')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:9999/callback')
    expect(url.searchParams.get('scope')).toBe('read rescan submit')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('st4te')
    // The server accepts several spellings but none covers both possible API
    // bases — an absent resource is the only universally valid choice.
    expect(url.searchParams.get('resource')).toBeNull()
  })
})

describe('loopback redirect capture', () => {
  it('captures code + state from the browser redirect and closes the listener', async () => {
    const loopback = await captureLoopbackRedirect(60_000, 'the_state')
    try {
      const done = loopback.result
      const res = await fetch(`http://127.0.0.1:${loopback.port}/callback?code=the_code&state=the_state`)
      expect(res.status).toBe(200)
      const landed = await done
      expect(landed.code).toBe('the_code')
      expect(landed.state).toBe('the_state')
      expect(landed.error).toBeNull()
    } finally {
      loopback.close()
    }
  })

  it('carries the error parameters when the user denies consent', async () => {
    const loopback = await captureLoopbackRedirect(60_000, 'st4te')
    try {
      const done = loopback.result
      await fetch(`http://127.0.0.1:${loopback.port}/callback?error=access_denied&error_description=nope&state=st4te`)
      const landed = await done
      expect(landed.code).toBeNull()
      expect(landed.error).toBe('access_denied')
      expect(landed.errorDescription).toBe('nope')
    } finally {
      loopback.close()
    }
  })

  it('refuses a forged first hit without consuming the capture', async () => {
    const loopback = await captureLoopbackRedirect(60_000, 'real_state')
    try {
      const done = loopback.result
      // An attacker (local process or remote page navigating the loopback
      // URL) cannot know the state — their hit gets a 400 and the listener
      // keeps waiting for the real redirect.
      const forged = await fetch(`http://127.0.0.1:${loopback.port}/callback?code=evil&state=wrong`)
      expect(forged.status).toBe(400)
      const real = await fetch(`http://127.0.0.1:${loopback.port}/callback?code=good&state=real_state`)
      expect(real.status).toBe(200)
      const landed = await done
      expect(landed.code).toBe('good')
      expect(landed.state).toBe('real_state')
    } finally {
      loopback.close()
    }
  })

  it('only answers GET on the exact callback path and loopback host', async () => {
    const loopback = await captureLoopbackRedirect(60_000, 's')
    const rawGet = (path: string, host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        // http.request (not fetch) — fetch normalizes the Host header away,
        // and the spoofed-Host case is exactly what this test pins.
        const req = httpRequest({ host: '127.0.0.1', port: loopback.port, path, headers: { host } }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.once('error', reject)
        req.end()
      })
    try {
      const post = await fetch(`http://127.0.0.1:${loopback.port}/callback`, { method: 'POST' })
      expect(post.status).toBe(405)
      expect(await rawGet('/nope?state=s', `127.0.0.1:${loopback.port}`)).toBe(404)
      // A spoofed Host header is not the loopback the listener bound.
      expect(await rawGet('/callback?state=s', 'evil.example:1')).toBe(404)
      expect(await rawGet('/callback?state=s', `localhost:${loopback.port}`)).toBe(200)
    } finally {
      loopback.close()
    }
  })
})

describe('refresh-death detection', () => {
  it('marks rotated-away refresh families as dead', () => {
    expect(isRefreshDead(new OAuthError('token reuse', 'invalid_grant'))).toBe(true)
    expect(isRefreshDead(new OAuthError('unknown client', 'invalid_client'))).toBe(true)
    expect(isRefreshDead(new OAuthError('server down'))).toBe(false)
    expect(isRefreshDead(new Error('plain'))).toBe(false)
  })
})

afterEach(() => {
  // no global state to clean — loopback servers close in their tests
})
