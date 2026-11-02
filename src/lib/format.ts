/** Number/date formatting — pure, testable, locale-stable. */

export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return Math.round(n).toLocaleString('en-US')
}

export function fmtCents(cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null || Number.isNaN(cents)) return '—'
  const major = cents / 100
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `
  if (Math.abs(major) >= 10_000) return `${symbol}${(major / 1000).toFixed(1)}k`
  return `${symbol}${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `${n.toFixed(digits)}%`
}

/** A signed delta line: `+12.4%` / `−3.1%` / `—`. Returns the sign+number only. */
export function fmtDelta(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return `${sign}${Math.abs(n).toFixed(digits)}%`
}

export function deltaTone(n: number | null | undefined): 'good' | 'bad' | 'flat' {
  if (n == null || Number.isNaN(n) || n === 0) return 'flat'
  return n > 0 ? 'good' : 'bad'
}

export function timeAgo(input: string | number | Date | null | undefined): string {
  if (!input) return 'never'
  const t = new Date(input).getTime()
  if (Number.isNaN(t)) return 'never'
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

export function shortDate(input: string | number | Date | null | undefined): string {
  if (!input) return '—'
  const d = new Date(input)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(0, 10)
}

/** `4 of 10 left` style budget text; null means unlimited. */
export function budgetText(left: number | null | undefined, noun: string): string {
  if (left == null) return `${noun}: unlimited`
  return `${noun}: ${left} left`
}
