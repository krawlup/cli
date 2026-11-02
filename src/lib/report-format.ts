/**
 * Shared report formatting — pure, testable, terminal-stable. The free
 * public report and the founder insights render the SAME stored blocks
 * through these helpers, so the two surfaces cannot drift and every row
 * keeps the house tri-state contract: a check the sweep never ran is
 * "unknown", never scored false.
 */

export type TriValue = 'pass' | 'fail' | 'unknown'

export function tri(v: boolean | null | undefined): TriValue {
  if (v === true) return 'pass'
  if (v === false) return 'fail'
  return 'unknown'
}

/** Milliseconds the way a terminal reads them: 450ms, 1.8s. */
export function fmtMs(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`
}

export function fmtClsValue(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return Number(v).toFixed(3)
}

/** Seconds → `1m 36s` / `48s` / `—`. */
export function fmtDurationSec(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const s = Math.max(0, Math.round(v))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

const ACRONYMS = new Set(['cta', 'ssl', 'seo', 'css', 'url', 'hsts', 'csp'])

/** `tap_targets` → `Tap targets`, `cta` → `CTA`. */
export function humanizeId(id: string | null | undefined): string {
  const raw = String(id || '').trim()
  if (!raw) return 'check'
  if (ACRONYMS.has(raw.toLowerCase())) return raw.toUpperCase()
  return raw.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase())
}

export interface VitalsWire {
  fcpMs?: number | null
  lcpMs?: number | null
  tbtMs?: number | null
  cls?: number | null
  siMs?: number | null
}

/** Ordered Core Web Vitals entries — the two core vitals lead, and only
 *  measured values render. Empty when nothing was measured. */
export function vitalsEntries(metrics: VitalsWire | null | undefined): Array<[string, string]> {
  if (!metrics) return []
  const rows: Array<[string, string]> = []
  if (metrics.lcpMs != null) rows.push(['LCP', fmtMs(metrics.lcpMs)])
  if (metrics.cls != null) rows.push(['CLS', fmtClsValue(metrics.cls)])
  if (metrics.fcpMs != null) rows.push(['FCP', fmtMs(metrics.fcpMs)])
  if (metrics.siMs != null) rows.push(['SI', fmtMs(metrics.siMs)])
  if (metrics.tbtMs != null) rows.push(['TBT', fmtMs(metrics.tbtMs)])
  return rows
}

export interface RobotsWire {
  blocked?: string[] | null
  total?: number | null
}

/** The blocked AI-crawler list, sanitized — a hostile robots body cannot
 *  inject a non-string into a terminal row. */
export function blockedAgents(robots: RobotsWire | null | undefined): { blocked: string[]; total: number } {
  const list = Array.isArray(robots?.blocked) ? robots.blocked.filter(Boolean).map(String) : []
  return { blocked: list, total: typeof robots?.total === 'number' ? robots.total : 0 }
}

export interface MobileEvidenceWire {
  offscreen?: Array<{ tag?: string; text?: string; note?: string }> | null
  tapTargets?: Array<{ tag?: string; text?: string; note?: string }> | null
  overlay?: { ctaText?: string; snippet?: string } | null
  smallText?: Array<{ tag?: string; text?: string; note?: string }> | null
}

/** Flattened, capped evidence lines for failing mobile checks. */
export function mobileEvidenceLines(evidence: MobileEvidenceWire | null | undefined, cap = 6): string[] {
  if (!evidence) return []
  const lines: string[] = []
  const push = (label: string, list?: Array<{ tag?: string; text?: string; note?: string }> | null) => {
    for (const ev of list ?? []) {
      if (lines.length >= cap) return
      const bit = [ev.tag, (ev.text || '').trim()].filter(Boolean).join(' · ')
      if (!bit) continue
      lines.push(`${label}: ${bit}`)
    }
  }
  push('offscreen', evidence.offscreen)
  push('tap target', evidence.tapTargets)
  push('small text', evidence.smallText)
  const overlayText = (evidence.overlay?.snippet || '').trim()
  if (evidence.overlay?.ctaText && overlayText && lines.length < cap) {
    lines.push(`overlay: "${evidence.overlay.ctaText}" covers the CTA — ${overlayText}`)
  }
  return lines
}

/** Capture URLs are 30-day-ephemeral paths on the web app — a relative path
 *  gets the krawlup.com origin so the printed link opens from any terminal. */
export function absShotUrl(url: string | null | undefined): string | null {
  const raw = String(url || '').trim()
  if (!raw) return null
  return raw.startsWith('http') ? raw : `https://krawlup.com${raw.startsWith('/') ? '' : '/'}${raw}`
}

/** The First Edit pick — parity with the server's pickFirstEditAuditId:
 *  biggest measured saving, else the first failing SEO audit, else the first
 *  failing audit. The public payload doesn't NAME the pick, so the terminal
 *  re-derives it from the same rule instead of labeling an arbitrary card. */
export function pickFirstEditAuditId(
  issues: Array<{ id?: string; category?: string; savingsMs?: number | null }> | null | undefined,
): string | null {
  const list = Array.isArray(issues) ? issues : []
  const bySavings = list.filter((i) => i?.savingsMs != null).sort((a, b) => (b.savingsMs || 0) - (a.savingsMs || 0))
  const pick = bySavings[0] || list.find((i) => i?.category === 'seo') || list[0] || null
  const id = pick?.id
  return id != null && String(id).trim() ? String(id) : null
}
