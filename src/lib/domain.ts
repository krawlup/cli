/**
 * Normalize a user-typed website argument to a bare host. Both doors — the
 * argv `report` command and the TUI DomainInput — run through THIS, so the
 * two can never disagree about what the server will accept (the server
 * re-normalizes anyway; this keeps `http://example.com/` from reaching it
 * as a key).
 */
export function normalizeDomainArg(raw: string): string | null {
  const stripped = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!stripped || /[\s/]/.test(stripped)) return null
  return stripped
}
