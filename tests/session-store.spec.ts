/**
 * The local session store: 0600 file, OAuth round-trip, the KRAWLUP_KEY
 * escape hatch winning over the stored session, and the https-only rule
 * for the API base (the bearer token travels on every request).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'krawlup-session-'))
  process.env.HOME = home
  delete process.env.KRAWLUP_KEY
  delete process.env.KRAWLUP_API
})

describe('session store', () => {
  it('round-trips an OAuth session at 0600', async () => {
    const { saveSession, loadSession, sessionPath, forgetSession } = await import('../src/connect/credentials.js')
    await saveSession({
      kind: 'oauth',
      api: 'https://krawlup.com',
      accessToken: 'sk_mc_aaa',
      refreshToken: 'sk_mr_bbb',
      expiresAt: 123456,
      clientId: 'client-1',
    })
    const path = sessionPath()
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const loaded = loadSession()
    expect(loaded).toMatchObject({ kind: 'oauth', accessToken: 'sk_mc_aaa', refreshToken: 'sk_mr_bbb', clientId: 'client-1' })
    await forgetSession()
    expect(existsSync(path)).toBe(false)
    expect(loadSession()).toBeNull()
  })

  it('KRAWLUP_KEY wins over the stored session and never touches the disk', async () => {
    const { saveSession, loadSession } = await import('../src/connect/credentials.js')
    await saveSession({ kind: 'oauth', api: 'https://krawlup.com', accessToken: 'sk_mc_stale', refreshToken: 'r', expiresAt: 0, clientId: 'c' })
    process.env.KRAWLUP_KEY = 'sk_ag_env'
    const loaded = loadSession()
    expect(loaded).toEqual({ kind: 'key', api: 'https://krawlup.com', key: 'sk_ag_env' })
    expect(JSON.parse(readFileSync(join(home, '.krawlup', 'session.json'), 'utf8')).accessToken).toBe('sk_mc_stale')
  })

  it('refuses plain-http API bases (localhost exempt)', async () => {
    const { assertApiBase } = await import('../src/connect/credentials.js')
    expect(() => assertApiBase('https://krawlup.com')).not.toThrow()
    expect(() => assertApiBase('http://localhost:3000')).not.toThrow()
    expect(() => assertApiBase('http://evil.example.com')).toThrow(/https/)
  })
})
