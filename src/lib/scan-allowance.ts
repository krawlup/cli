/**
 * The free-scan allowance as a value, plus the two sentences that quote it.
 *
 * Pure on purpose (no fetch, no store): both the API client's refusals and the
 * UI hints build their copy here, so the terminal can never say "1/month" while
 * the server enforces something else. The number is admin-owned —
 * Settings ▸ Free Site Scanning ▸ `publicScanCliScansPerMonth` — and reaches
 * the CLI as `GET /api/tools/public-insights/scan-config`.
 */
export interface ScanConfig {
  /** Free full scans per CLI device per month, straight from the server. */
  cliScansPerMonth: number
  /** The browser page's own pool — quoted for context, never spent. */
  webScansPerMonth: number
  /** Page-speed re-checks per day, same source. */
  pageSpeedChecksPerDay: number
  /** Signed in AND on the beta allowlist: unlimited, no countdown. */
  betaUnlimited: boolean
  signedIn: boolean
  /**
   * False until the server answered. The zeros above are "unknown" until
   * then, which is why the copy below says "checking…" instead of "0 left".
   */
  loaded: boolean
}

/** The state every process starts in: 0, and honest about not knowing yet. */
export const UNKNOWN_SCAN_CONFIG: ScanConfig = {
  cliScansPerMonth: 0,
  webScansPerMonth: 0,
  pageSpeedChecksPerDay: 0,
  betaUnlimited: false,
  signedIn: false,
  loaded: false,
}

/**
 * The allowance in prose, for a hint or a help line. "Checking" until the
 * server answers, "switched off" for a real 0 — never a bare zero that reads
 * like the user already spent something.
 */
export function scanAllowance(cfg: ScanConfig): string {
  if (cfg.betaUnlimited) return 'unlimited scans — beta tester'
  if (!cfg.loaded) return 'free-scan allowance: checking…'
  if (cfg.cliScansPerMonth === 0) return 'no free CLI scans right now'
  if (cfg.cliScansPerMonth === 1) return '1 free scan/month per device'
  return `${cfg.cliScansPerMonth} free scans/month per device`
}

/** The same facts for a command description that has room for more words. */
export function scanAllowanceDetail(cfg: ScanConfig): string {
  if (cfg.betaUnlimited) return 'unlimited for signed-in beta testers'
  if (!cfg.loaded) return 'free-scan allowance: checking…'
  if (cfg.cliScansPerMonth === 0) {
    return 'no free CLI scans right now — beta testers scan unlimited when signed in'
  }
  return scanAllowance(cfg)
}

/**
 * The report command's lead phrase, shared by the help screen and the TUI
 * command list. "free … scan" only while the device actually has an
 * allowance — with the pool switched off the report still reads free, but a
 * new scan is not, so the lead drops the word instead of contradicting its
 * own parenthetical.
 */
export function reportLeadPhrase(cfg: ScanConfig): string {
  return cfg.betaUnlimited || !cfg.loaded || cfg.cliScansPerMonth > 0
    ? 'FREE full site scan + report'
    : 'full site report'
}

/** The refusal once the monthly pool is spent (or was never granted). */
export function scansSpentMessage(cfg: ScanConfig): string {
  if (!cfg.loaded || cfg.cliScansPerMonth === 0) {
    return 'Free CLI scans are switched off right now — sign in with a beta-tester account to scan unlimited sites, or run the report in the browser at https://krawlup.com/site-report.'
  }
  const n = cfg.cliScansPerMonth
  return n === 1
    ? "You've used your one free CLI scan this month — it renews next month, or sign up to scan unlimited sites."
    : `You've used your ${n} free CLI scans this month — they renew next month, or sign up to scan unlimited sites.`
}
