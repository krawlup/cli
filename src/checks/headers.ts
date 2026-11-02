/**
 * `krawlup headers <url>` — the security + cache header audit. Pure over the
 * fetched header record: identical verdicts for the standalone command and
 * the `check` battery, fully testable offline. Tri-state: a header that was
 * stripped by a proxy is still "missing" (that IS what receivers see), but a
 * page that could not be fetched at all is "unknown" — never "missing".
 */
import type { Check, Section } from './verdict.js'

/** Recommended minimum HSTS max-age (18 weeks, the Chrome preload floor). */
const HSTS_MIN_AGE = 15_552_000

function firstValue(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim()
}

export function auditHeaders(h: Record<string, string>, ctx: { status: number }): Section {
  const checks: Check[] = []
  const has = (name: string) => h[name] != null && h[name].length > 0

  // ── HSTS ──────────────────────────────────────────────────────────────
  if (!has('strict-transport-security')) {
    checks.push({
      id: 'hsts',
      label: 'HSTS',
      status: 'fail',
      detail: 'Missing — the first plaintext http:// request to any URL can be downgraded or intercepted.',
      fix: 'Strict-Transport-Security: max-age=31536000; includeSubDomains',
    })
  } else {
    const maxAge = Number(/max-age\s*=\s*(\d+)/i.exec(h['strict-transport-security']!)?.[1])
    if (!Number.isFinite(maxAge)) {
      checks.push({ id: 'hsts', label: 'HSTS', status: 'warn', detail: `Present but has no parseable max-age: "${h['strict-transport-security']}".` })
    } else if (maxAge < HSTS_MIN_AGE) {
      checks.push({ id: 'hsts', label: 'HSTS', status: 'warn', detail: `max-age=${maxAge} is under the 180-day preload floor; raise it once the policy is stable.` })
    } else {
      checks.push({ id: 'hsts', label: 'HSTS', status: 'pass', detail: h['strict-transport-security']! })
    }
  }

  // ── CSP ───────────────────────────────────────────────────────────────
  if (!has('content-security-policy')) {
    checks.push({
      id: 'csp',
      label: 'CSP',
      status: 'fail',
      detail: 'Missing — no defense-in-depth against XSS: injected scripts run with full page origin.',
      fix: "Content-Security-Policy: default-src 'self' (start here, then widen per resource)",
    })
  } else {
    const csp = h['content-security-policy']!
    const directives = csp.split(';').filter((d) => d.trim()).length
    checks.push({ id: 'csp', label: 'CSP', status: 'pass', detail: `${directives} directive${directives === 1 ? '' : 's'}: ${csp.slice(0, 100)}${csp.length > 100 ? '…' : ''}` })
  }

  // ── X-Content-Type-Options ────────────────────────────────────────────
  const xcto = firstValue(h['x-content-type-options'])
  if (!xcto) {
    checks.push({
      id: 'xcto',
      label: 'MIME sniffing',
      status: 'fail',
      detail: 'X-Content-Type-Options missing — browsers may re-interpret a served file into script.',
      fix: 'X-Content-Type-Options: nosniff',
    })
  } else if (xcto.toLowerCase() !== 'nosniff') {
    checks.push({ id: 'xcto', label: 'MIME sniffing', status: 'warn', detail: `X-Content-Type-Options: "${xcto}" — the only value that does anything is nosniff.` })
  } else {
    checks.push({ id: 'xcto', label: 'MIME sniffing', status: 'pass', detail: 'nosniff.' })
  }

  // ── Frame embedding (clickjacking) ────────────────────────────────────
  const xfo = firstValue(h['x-frame-options'])
  const frameAncestors = /frame-ancestors/i.test(h['content-security-policy'] ?? '')
  if (!xfo && !frameAncestors) {
    checks.push({
      id: 'framing',
      label: 'Clickjacking',
      status: 'fail',
      detail: 'Neither X-Frame-Options nor a CSP frame-ancestors directive — the page can be embedded and clickjacked anywhere.',
      fix: "X-Frame-Options: SAMEORIGIN (or CSP: frame-ancestors 'self')",
    })
  } else {
    checks.push({ id: 'framing', label: 'Clickjacking', status: 'pass', detail: xfo ? `X-Frame-Options: ${xfo}` : 'CSP frame-ancestors present.' })
  }

  // ── Referrer-Policy ───────────────────────────────────────────────────
  const rp = firstValue(h['referrer-policy'])
  if (!rp) {
    checks.push({
      id: 'referrer',
      label: 'Referrer',
      status: 'fail',
      detail: 'Missing — outbound links leak full URLs (paths, query strings) to every destination.',
      fix: 'Referrer-Policy: strict-origin-when-cross-origin',
    })
  } else {
    checks.push({ id: 'referrer', label: 'Referrer', status: 'pass', detail: rp })
  }

  // ── Advisory headers ──────────────────────────────────────────────────
  if (!has('permissions-policy')) {
    checks.push({ id: 'permissions', label: 'Permissions', status: 'warn', detail: 'Permissions-Policy missing (advisory) — embedded iframes and scripts can request camera/geolocation/mic.', fix: 'Permissions-Policy: camera=(), microphone=(), geolocation=()' })
  } else {
    checks.push({ id: 'permissions', label: 'Permissions', status: 'pass', detail: h['permissions-policy']! })
  }
  if (!has('cross-origin-opener-policy')) {
    checks.push({ id: 'coop', label: 'COOP', status: 'warn', detail: 'Cross-Origin-Opener-Policy missing (advisory) — popped windows keep a reference back to your page.', fix: 'Cross-Origin-Opener-Policy: same-origin' })
  } else {
    checks.push({ id: 'coop', label: 'COOP', status: 'pass', detail: h['cross-origin-opener-policy']! })
  }

  // ── Cache ─────────────────────────────────────────────────────────────
  const cacheControl = h['cache-control']
  if (!cacheControl && !has('etag') && !has('last-modified')) {
    checks.push({ id: 'cache', label: 'Caching', status: 'warn', detail: 'No Cache-Control, ETag or Last-Modified — every fetch is a full re-download and no proxy/CDN can cache it.', fix: 'Cache-Control: max-age=0, must-revalidate (for HTML) — or real TTLs for static assets' })
  } else {
    checks.push({ id: 'cache', label: 'Caching', status: 'pass', detail: [cacheControl ? `Cache-Control: ${cacheControl}` : null, h['etag'] ? 'ETag present' : null, h['last-modified'] ? 'Last-Modified present' : null].filter(Boolean).join(' — ') })
  }

  const note =
    ctx.status === 403 || ctx.status === 401
      ? `The server answered ${ctx.status} — some CDNs serve a challenge page; the verdicts reflect THAT response.`
      : ctx.status >= 400
        ? `The server answered ${ctx.status} — verdicts reflect the error response's headers.`
        : undefined

  return { id: 'headers', title: 'Security & cache headers', checks, note }
}
