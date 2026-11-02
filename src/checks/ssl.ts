/**
 * `krawlup ssl <domain>` — certificate facts over node:tls. The probe is
 * injectable so verdict logic is testable offline; the real probe connects
 * with rejectUnauthorized:false so an INVALID certificate is still read and
 * reported (a self-signed or expired cert is exactly what the user came to
 * see — refusing to look at it would report the symptom as "no data").
 */
import tls from 'node:tls'
import type { Check, Section } from './verdict.js'

export interface CertProbe {
  authorized: boolean
  authorizationError: string | null
  protocol: string | null
  subjectCN: string | null
  issuer: string | null
  validFrom: Date | null
  validTo: Date | null
  sanCount: number
}

export type TlsProber = (host: string, port: number) => Promise<CertProbe | null>

const TLS_PROBE_TIMEOUT_MS = 10_000

/** The real probe: one TLS handshake, cert read, socket closed. Null = no TLS. */
export function probeTls(host: string, port = 443): Promise<CertProbe | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (probe: CertProbe | null) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
      resolve(probe)
    }

    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: false,
      timeout: TLS_PROBE_TIMEOUT_MS,
    })

    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate()
        if (!cert || Object.keys(cert).length === 0) {
          done(null)
          return
        }
        // Node types say string[], but in practice issuer/subject values are
        // strings (arrays only for repeated names) — normalize both.
        const one = (v: string | string[] | undefined): string | null =>
          Array.isArray(v) ? v[0] ?? null : typeof v === 'string' && v.length ? v : null
        const issuerRec = cert.issuer as Record<string, string | string[]> | undefined
        const subjectRec = cert.subject as Record<string, string | string[]> | undefined
        const issuer = issuerRec ? one(issuerRec.O) ?? one(issuerRec.CN) : null
        const subject = subjectRec ? one(subjectRec.CN) : null
        done({
          authorized: socket.authorized,
          authorizationError: socket.authorized ? null : String(socket.authorizationError ?? 'certificate not trusted'),
          protocol: socket.getProtocol(),
          subjectCN: subject,
          issuer,
          validFrom: cert.valid_from ? new Date(cert.valid_from) : null,
          validTo: cert.valid_to ? new Date(cert.valid_to) : null,
          sanCount: cert.subjectaltname ? cert.subjectaltname.split(',').filter((s) => s.trim()).length : 0,
        })
      } catch {
        done(null)
      }
    })
    socket.once('timeout', () => done(null))
    socket.once('error', () => done(null))
  })
}

const WARN_DAYS = 21

export function judgeTls(probe: CertProbe | null, host: string): Section {
  if (!probe) {
    return {
      id: 'tls',
      title: 'TLS certificate',
      checks: [{ id: 'handshake', label: 'Handshake', status: 'fail', detail: `No TLS handshake on ${host}:443 — the site is unreachable over HTTPS (down, or no certificate at all).` }],
    }
  }

  const checks: Check[] = []

  if (probe.authorized) {
    const days = probe.validTo ? Math.floor((probe.validTo.getTime() - Date.now()) / 86_400_000) : null
    if (days == null || Number.isNaN(days)) {
      checks.push({ id: 'validity', label: 'Certificate', status: 'unknown', detail: 'Trusted, but the expiry date could not be parsed.' })
    } else if (days < 0) {
      checks.push({ id: 'validity', label: 'Certificate', status: 'fail', detail: `EXPIRED ${-days} day${days === -1 ? '' : 's'} ago (${probe.validTo?.toISOString().slice(0, 10)}) — browsers and API clients refuse the connection.` })
    } else if (days < WARN_DAYS) {
      checks.push({ id: 'validity', label: 'Certificate', status: 'warn', detail: `Only ${days} day${days === 1 ? '' : 's'} left (expires ${probe.validTo?.toISOString().slice(0, 10)}) — renew now before an outage.` })
    } else {
      checks.push({ id: 'validity', label: 'Certificate', status: 'pass', detail: `Valid, ${days} days left (expires ${probe.validTo?.toISOString().slice(0, 10)}).` })
    }
    checks.push({ id: 'identity', label: 'Issuer', status: 'pass', detail: `${probe.issuer ?? 'unknown issuer'}${probe.subjectCN ? ` — issued for ${probe.subjectCN}` : ''}, ${probe.sanCount} SAN entr${probe.sanCount === 1 ? 'y' : 'ies'}.` })
  } else {
    checks.push({
      id: 'validity',
      label: 'Certificate',
      status: 'fail',
      detail: `Not trusted: ${probe.authorizationError}. Browsers show an interstitial and API clients (agents included) refuse to connect.`,
    })
    checks.push({ id: 'identity', label: 'Issuer', status: 'unknown', detail: `Certificate presented (${probe.issuer ?? 'unknown issuer'}) but validation failed — self-signed, wrong host, or an incomplete chain.` })
  }

  if (probe.protocol && /^TLSv1(\.[01])?$/.test(probe.protocol)) {
    checks.push({
      id: 'version',
      label: 'Protocol',
      status: 'fail',
      detail: `${probe.protocol} negotiated — deprecated and disabled by modern clients; disable it server-side.`,
    })
  } else if (probe.protocol) {
    checks.push({ id: 'version', label: 'Protocol', status: 'pass', detail: `${probe.protocol} negotiated.` })
  }

  return { id: 'tls', title: 'TLS certificate', checks }
}
