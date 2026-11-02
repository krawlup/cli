/**
 * The CLI's device identity: a random UUID generated once per install and
 * sent with every hosted (krawlup.com) request as `x-krawlup-device`, so
 * the server can give the CLI its own stable quota pool and attribute
 * scans to a surface. It is a random token — no PII, no hardware
 * fingerprint, nothing cross-site; delete ~/.krawlup/device-id (or run in
 * CI without it) and you are a new device as far as anyone can tell.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
// The bundler inlines this at build time (the bundled single file has no
// package.json sibling to require).
import pkg from '../../package.json' with { type: 'json' }

const cliVersion = pkg.version

/** The CLI's own version (bundled at build time) — MCP handshake + headers. */
export const CLI_VERSION = cliVersion

const deviceIdFile = () => join(homedir(), '.krawlup', 'device-id')
let cached: string | null = null

export async function getDeviceId(): Promise<string> {
  if (cached) return cached
  // Test/CI escape: keep the id in memory, never touch the real HOME.
  if (process.env.KRAWLUP_SKIP_DEVICE_FILE) {
    cached ??= randomUUID()
    return cached
  }
  try {
    const existing = (await readFile(deviceIdFile(), 'utf8')).trim()
    if (/^[0-9a-f-]{16,64}$/i.test(existing)) {
      cached = existing
      return cached
    }
  } catch {
    /* first run */
  }
  const fresh = randomUUID()
  try {
    await mkdir(join(deviceIdFile(), '..'), { recursive: true })
    await writeFile(deviceIdFile(), `${fresh}\n`, { mode: 0o600 })
  } catch {
    /* read-only HOME (CI) — the id is still stable for this process */
  }
  cached = fresh
  return cached
}

export async function forgetDeviceId(): Promise<void> {
  cached = null
  await rm(deviceIdFile(), { force: true })
}

/** Headers every hosted request carries. */
export async function deviceHeaders(): Promise<Record<string, string>> {
  return {
    'x-krawlup-client': `krawlup-cli/${cliVersion}`,
    'x-krawlup-device': await getDeviceId(),
  }
}
