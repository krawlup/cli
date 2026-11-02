/**
 * The verdict model for the local battery (`krawlup check/robots/mail/…`).
 *
 * Every check is TRI-STATE by house rule: `unknown` means "could not be
 * measured" (the fetch was blocked, DNS failed, the handshake refused) and
 * never renders as a failure. A section's exit code is driven only by
 * `fail` — `warn` is an advisory a CI run can ignore, `unknown` is silence,
 * and exit 1 must always mean "a concrete, fixable problem was measured".
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown'

export interface Check {
  id: string
  label: string
  status: CheckStatus
  detail: string
  /** The exact header/record/line that fixes the finding, when one exists. */
  fix?: string
}

export interface Section {
  id: string
  title: string
  checks: Check[]
  /** Context that changes how the checks read (e.g. "response was a 403 challenge page"). */
  note?: string
}

export interface Summary {
  pass: number
  warn: number
  fail: number
  unknown: number
}

export const MARKS: Record<CheckStatus, string> = {
  pass: '✓',
  warn: '!',
  fail: '✗',
  unknown: '–',
}

const SEVERITY: Record<CheckStatus, number> = {
  fail: 0,
  warn: 1,
  unknown: 2,
  pass: 3,
}

/** The worst status in a set (fail beats warn beats unknown beats pass). */
export function worstStatus(statuses: Iterable<CheckStatus>): CheckStatus {
  let worst: CheckStatus = 'pass'
  for (const s of statuses) {
    if (SEVERITY[s] < SEVERITY[worst]) worst = s
  }
  return worst
}

export function summarize(sections: Section[]): Summary {
  const s: Summary = { pass: 0, warn: 0, fail: 0, unknown: 0 }
  for (const sec of sections) {
    for (const c of sec.checks) s[c.status]++
  }
  return s
}

/** Exit code for a run: 1 only when something concrete failed. */
export function exitFor(summary: Summary): 0 | 1 {
  return summary.fail > 0 ? 1 : 0
}
