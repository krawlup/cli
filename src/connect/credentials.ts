/**
 * The CLI's local session: OAuth tokens from the browser login (or a
 * KRAWLUP_KEY escape hatch for headless/CI use). Tokens sit in
 * ~/.krawlup/session.json, 0600. The refresh token never leaves this file
 * except to the API's token endpoint. KRAWLUP_API env moves the API base —
 * that is how a dev API is targeted without touching the stored session.
 */
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OAuthSession {
  kind: 'oauth'
  api: string
  accessToken: string
  refreshToken: string
  /** epoch ms — refreshed access tokens move this forward */
  expiresAt: number
  clientId: string
}

export interface KeySession {
  kind: 'key'
  api: string
  key: string
}

export type Session = OAuthSession | KeySession

const sessionFile = () => join(homedir(), '.krawlup', 'session.json')

export function defaultApi(): string {
  return process.env.KRAWLUP_API || 'https://krawlup.com'
}

/**
 * The API base carries the bearer token on every request — an http:// base
 * would send it in cleartext and an arbitrary host would exfiltrate it.
 * Only https, or localhost for dev, is accepted.
 */
export function assertApiBase(api: string): void {
  let u: URL
  try {
    u = new URL(api)
  } catch {
    throw new Error(`"${api}" is not a URL`)
  }
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1'
  if (u.protocol !== 'https:' && !isLocal) {
    throw new Error(`refusing "${api}" — the API base must be https (the session token travels on every request); localhost is allowed for dev`)
  }
}

/** KRAWLUP_KEY wins over the stored session — that is how CI passes a key. */
export function loadSession(): Session | null {
  const envKey = process.env.KRAWLUP_KEY?.trim()
  if (envKey) {
    const api = defaultApi()
    assertApiBase(api)
    return { kind: 'key', api, key: envKey }
  }
  try {
    const raw = JSON.parse(readFileSync(sessionFile(), 'utf8')) as Partial<OAuthSession>
    if (raw.kind === 'oauth' && typeof raw.accessToken === 'string' && typeof raw.refreshToken === 'string' && raw.api) {
      assertApiBase(raw.api)
      return {
        kind: 'oauth',
        api: raw.api,
        accessToken: raw.accessToken,
        refreshToken: raw.refreshToken,
        expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : 0,
        clientId: typeof raw.clientId === 'string' ? raw.clientId : '',
      }
    }
  } catch {
    /* not logged in */
  }
  return null
}

export async function saveSession(session: Session): Promise<void> {
  const file = sessionFile()
  await mkdir(join(file, '..'), { recursive: true })
  // Atomic write: a crash mid-write must not truncate the only copy of the
  // rotating refresh token — rename() replaces the file in one step.
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, file)
}

export function sessionPath(): string {
  return sessionFile()
}

export async function forgetSession(): Promise<void> {
  await unlink(sessionFile()).catch(() => {})
}
