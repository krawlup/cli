/**
 * `krawlup mail <domain>` — SPF / DKIM / DMARC / MX over plain DNS
 * (node:dns), with the plain-English fix for every finding. All DNS access
 * goes through the injected resolver so the whole battery of verdicts is
 * testable offline.
 */
import type { Check } from './verdict.js'

export interface MailDns {
  resolveTxt(host: string): Promise<string[][]>
  resolveMx(host: string): Promise<Array<{ exchange: string; priority: number }>>
  resolveA(host: string): Promise<string[]>
}

/** Selectors probed for DKIM — the ones the big ESPs actually emit. */
export const COMMON_DKIM_SELECTORS = [
  'google',
  'default',
  'selector1',
  'selector2',
  's1',
  's2',
  'k1',
  'mail',
  'fm1',
  'fm2',
  'protonmail',
  'zoho',
  'mandrill',
  'dkim',
]

export interface MailRecords {
  /** SPF TXT records at the apex (should be 0 or 1). */
  spf: string[]
  /** DMARC TXT records at _dmarc.<domain> (should be 0 or 1). */
  dmarc: string[]
  /** DKIM records found under the common selectors. */
  dkim: Array<{ selector: string; record: string }>
  mx: Array<{ exchange: string; priority: number }>
  /** Implicit-MX fallback (RFC 5321): an A/AAAA exists at the apex. */
  aFallback: boolean | null
  /** Per-lookup DNS errors — "unknown", not "missing". */
  errors: string[]
}

/** Probe every record for a domain. Individual lookup failures degrade to unknown, never throw. */
export async function probeMail(domain: string, dns: MailDns): Promise<MailRecords> {
  const errors: string[] = []
  const soft = async <T>(what: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run()
    } catch (e) {
      errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  const [spfAll, dmarcAll, mx, aRecords] = await Promise.all([
    soft('SPF', () => dns.resolveTxt(domain)),
    soft('DMARC', () => dns.resolveTxt(`_dmarc.${domain}`)),
    soft('MX', () => dns.resolveMx(domain)),
    soft('A', () => dns.resolveA(domain)),
  ])

  const spf = (spfAll ?? [])
    .map((chunks) => chunks.join(''))
    .filter((txt) => txt.trim().toLowerCase().startsWith('v=spf1'))
  const dmarc = (dmarcAll ?? [])
    .map((chunks) => chunks.join(''))
    .filter((txt) => /^v=DMARC1\b/i.test(txt.trim()))

  const dkimProbes = await Promise.all(
    COMMON_DKIM_SELECTORS.map(async (selector) => {
      const got = await soft(`DKIM/${selector}`, () => dns.resolveTxt(`${selector}._domainkey.${domain}`))
      const record = got?.map((chunks) => chunks.join('')).find((txt) => /p=[A-Za-z0-9+/=]/.test(txt))
      return record ? { selector, record } : null
    }),
  )
  const dkim = dkimProbes.filter((d): d is { selector: string; record: string } => d !== null)

  return {
    spf,
    dmarc,
    dkim,
    mx: mx ?? [],
    aFallback: aRecords === null ? null : aRecords.length > 0,
    errors,
  }
}

function spfPolicyText(record: string): { label: string; level: 'pass' | 'warn' | 'fail' } {
  const lower = record.toLowerCase()
  // The qualifier is part of the mechanism token (~all / -all / ?all / +all),
  // and a bare trailing "all" defaults to +all — so \ball$ can never be used
  // to detect +all: it also matches ~all.
  const hardAllow = /\+all\b/.test(lower) || /(^|\s)all$/.test(lower.trim())
  if (hardAllow) return { label: '+all — any server on the internet may send as your domain', level: 'fail' }
  if (/\?all\b/.test(lower)) return { label: '?all — neutral: sending policy is undeclared', level: 'warn' }
  if (/-all\b/.test(lower)) return { label: '-all — hard fail for unauthorized senders', level: 'pass' }
  if (/~all\b/.test(lower)) return { label: '~all — soft fail for unauthorized senders', level: 'pass' }
  return { label: 'no all mechanism — policy is neutral by default', level: 'warn' }
}

export function judgeMail(rec: MailRecords, domain: string): Check[] {
  const checks: Check[] = []

  // ── MX ────────────────────────────────────────────────────────────────
  if (rec.mx.length > 0) {
    const listed = rec.mx
      .slice()
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 3)
      .map((m) => m.exchange)
      .join(', ')
    checks.push({ id: 'mx', label: 'Mail exchange', status: 'pass', detail: `${rec.mx.length} MX record${rec.mx.length === 1 ? '' : 's'} — ${listed}${rec.mx.length > 3 ? '…' : ''}` })
  } else if (rec.aFallback === true) {
    checks.push({ id: 'mx', label: 'Mail exchange', status: 'warn', detail: 'No MX records — mailers fall back to the apex A record (RFC 5321 implicit MX). Works, but brittle.' })
  } else if (rec.aFallback === false) {
    checks.push({ id: 'mx', label: 'Mail exchange', status: 'fail', detail: 'No MX records and no apex A record — this domain cannot receive email.', fix: `Add an MX record: ${domain}. IN 10 mail.<your-provider>.` })
  } else {
    checks.push({ id: 'mx', label: 'Mail exchange', status: 'unknown', detail: 'MX lookup failed (DNS error) — cannot say whether the domain receives mail.' })
  }

  // ── SPF ───────────────────────────────────────────────────────────────
  if (rec.spf.length === 0) {
    checks.push({
      id: 'spf',
      label: 'SPF',
      status: 'fail',
      detail: 'No SPF record — any server on the internet can send email that claims to be from this domain, and most of it lands in spam.',
      fix: `${domain}. IN TXT "v=spf1 include:<your-esp> ~all"`,
    })
  } else if (rec.spf.length > 1) {
    checks.push({ id: 'spf', label: 'SPF', status: 'fail', detail: `${rec.spf.length} SPF records — receivers must treat this as a permanent error and typically reject the mail. Merge into one record.`, fix: 'Keep exactly ONE "v=spf1" TXT record at the apex.' })
  } else {
    const policy = spfPolicyText(rec.spf[0]!)
    checks.push({ id: 'spf', label: 'SPF', status: policy.level, detail: policy.label })
  }

  // ── DMARC ─────────────────────────────────────────────────────────────
  if (rec.dmarc.length === 0) {
    checks.push({
      id: 'dmarc',
      label: 'DMARC',
      status: 'fail',
      detail: 'No DMARC record — receivers have no policy for mail that fails SPF/DKIM, and Google/Yahoo bulk senders require one.',
      fix: `_dmarc.${domain}. IN TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}"`,
    })
  } else if (rec.dmarc.length > 1) {
    checks.push({ id: 'dmarc', label: 'DMARC', status: 'fail', detail: `${rec.dmarc.length} DMARC records at _dmarc — this is invalid; receivers may ignore all of them. Keep one.` })
  } else {
    const record = rec.dmarc[0]!
    const p = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)/i.exec(record)?.[1]?.toLowerCase()
    const rua = /rua=/i.test(record)
    if (!p) {
      checks.push({ id: 'dmarc', label: 'DMARC', status: 'fail', detail: 'DMARC record has no p= policy — invalid; receivers treat it as p=none at best.', fix: `Set p=quarantine (or p=reject) in _dmarc.${domain}.` })
    } else if (p === 'none') {
      checks.push({ id: 'dmarc', label: 'DMARC', status: 'warn', detail: `p=none — monitoring only: nothing is enforced against spoofed mail${rua ? ' (reports are flowing to rua, so you can watch alignment)' : '; add rua= to receive aggregate reports'}. Move to p=quarantine once reports look clean.` })
    } else {
      checks.push({ id: 'dmarc', label: 'DMARC', status: 'pass', detail: `p=${p}${rua ? ' + aggregate reports (rua)' : ''} — spoofed mail is quarantined or rejected.` })
    }
  }

  // ── DKIM ──────────────────────────────────────────────────────────────
  const sendsMail = rec.mx.length > 0 || rec.spf.length > 0 || rec.aFallback === true
  if (rec.dkim.length > 0) {
    const selectors = rec.dkim.map((d) => d.selector).join(', ')
    checks.push({ id: 'dkim', label: 'DKIM', status: 'pass', detail: `${rec.dkim.length} signing key${rec.dkim.length === 1 ? '' : 's'} found under common selectors (${selectors}).` })
  } else if (sendsMail) {
    checks.push({
      id: 'dkim',
      label: 'DKIM',
      status: 'warn',
      detail: `No DKIM key under ${COMMON_DKIM_SELECTORS.length} common selectors — if you sign mail, verify your selector (we can only probe well-known names); DMARC without DKIM still works via SPF, but DKIM survives forwarding.`,
      fix: `If your ESP signs as "s1", check: s1._domainkey.${domain} IN TXT "v=DKIM1; k=rsa; p=<public key>"`,
    })
  } else {
    checks.push({ id: 'dkim', label: 'DKIM', status: 'unknown', detail: 'No DKIM key found under common selectors — fine if this domain does not send email.' })
  }

  return checks
}
