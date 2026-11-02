/**
 * The free-scan allowance, as the SERVER defines it.
 *
 * The per-device monthly pool is an admin setting (Settings ▸ Free Site
 * Scanning ▸ `publicScanCliScansPerMonth`), so the CLI keeps no baked-in
 * number: this store starts at 0/unknown and is replaced by
 * `GET /api/tools/public-insights/scan-config` at startup. Every hint, help
 * line and refusal sentence reads THIS, so an admin raising (or zeroing) the
 * limit changes what the terminal says on the next run — the client can never
 * drift from what the reserve pipeline will actually allow.
 */
import { useSyncExternalStore } from 'react'
import { Store } from './store.js'
import { fetchScanConfig } from '../api/public-scan.js'
import { defaultApi } from '../connect/credentials.js'
import { UNKNOWN_SCAN_CONFIG, type ScanConfig } from '../lib/scan-allowance.js'

export type { ScanConfig } from '../lib/scan-allowance.js'

export const scanConfig = new Store<ScanConfig>({ ...UNKNOWN_SCAN_CONFIG })

/**
 * Ask the server for the allowance and publish it. Best-effort by design:
 * `krawlup report` must still work when this read fails (the scan request
 * itself quotes the same numbers), so a failure leaves the state "unknown"
 * and never throws at the caller.
 */
export async function refreshScanConfig(apiBase?: string): Promise<ScanConfig> {
  try {
    const cfg = await fetchScanConfig(apiBase ?? defaultApi())
    const next: ScanConfig = {
      cliScansPerMonth: Math.max(0, Math.trunc(cfg.cliScansPerMonth ?? 0)),
      webScansPerMonth: Math.max(0, Math.trunc(cfg.webScansPerMonth ?? 0)),
      pageSpeedChecksPerDay: Math.max(0, Math.trunc(cfg.pageSpeedChecksPerDay ?? 0)),
      betaUnlimited: cfg.betaUnlimited === true,
      signedIn: cfg.signedIn === true,
      loaded: true,
    }
    scanConfig.set(next)
    return next
  } catch {
    return scanConfig.get()
  }
}

/** React binding for the app store (the state is a plain Store). */
export function useScanConfig(): ScanConfig {
  return useSyncExternalStore(scanConfig.subscribe, () => scanConfig.get(), () => scanConfig.get())
}
