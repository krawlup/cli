/**
 * The CLI version, read from package.json — the single source of truth,
 * so the version (and the User-Agent string built from it) never drifts
 * from the published metadata. The createRequire lookup walks up because
 * the file runs at two depths: bundled (dist/entry.js → one level up) and
 * from source (src/lib/version.ts → two levels up).
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function readVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = require(rel) as { version?: string }
      if (typeof pkg?.version === 'string' && pkg.version) return pkg.version
    } catch {
      // not this level — try the next one up
    }
  }
  return '0.0.0'
}

export const CLI_VERSION: string = readVersion()
