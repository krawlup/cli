/**
 * The mail battery over a fake resolver: SPF qualifier verdicts (including
 * the ~all-looks-like-+all regex trap), DMARC policy levels, the multi-record
 * PermError, implicit MX, DKIM probing, and DNS errors degrading to unknown.
 */
import { describe, expect, it } from 'vitest'
import { judgeMail, probeMail, COMMON_DKIM_SELECTORS, type MailDns, type MailRecords } from '../src/checks/mail.js'

const dns = (over: Partial<MailDns> = {}): MailDns => ({
  resolveTxt: async () => [],
  resolveMx: async () => [],
  resolveA: async () => [],
  ...over,
})

const statusOf = (checks: ReturnType<typeof judgeMail>, id: string) => checks.find((c) => c.id === id)

describe('probeMail', () => {
  it('joins multi-chunk TXT strings and filters SPF/DMARC by prefix', async () => {
    const rec = await probeMail('example.com', dns({
      resolveTxt: async (host) => {
        if (host === 'example.com') return [['v=spf1', ' include:_spf.google.com ', '~all']]
        if (host === '_dmarc.example.com') return [['v=DMARC1; p=quarantine;', ' rua=mailto:d@e.com']]
        return []
      },
    }))
    expect(rec.spf).toEqual(['v=spf1 include:_spf.google.com ~all'])
    expect(rec.dmarc).toEqual(['v=DMARC1; p=quarantine; rua=mailto:d@e.com'])
  })

  it('probes every common DKIM selector and keeps records with a key', async () => {
    const seen: string[] = []
    const rec = await probeMail('example.com', dns({
      resolveTxt: async (host) => {
        seen.push(host)
        if (host === 'google._domainkey.example.com') return [['v=DKIM1; k=rsa; p=MIIB']]
        return []
      },
    }))
    expect(seen.filter((h) => h.endsWith('._domainkey.example.com'))).toHaveLength(COMMON_DKIM_SELECTORS.length)
    expect(rec.dkim).toEqual([{ selector: 'google', record: 'v=DKIM1; k=rsa; p=MIIB' }])
  })

  it('a DNS failure on one family degrades to unknown, never throws', async () => {
    const rec = await probeMail('example.com', dns({
      resolveMx: async () => {
        throw Object.assign(new Error('query timed out'), { code: 'ETIMEDOUT' })
      },
      resolveA: async () => {
        throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' })
      },
    }))
    expect(rec.mx).toEqual([])
    expect(rec.aFallback).toBeNull()
    expect(rec.errors.some((e) => e.startsWith('MX:'))).toBe(true)
  })
})

describe('judgeMail verdicts', () => {
  it('no SPF and no DMARC are the two headline failures, with the record to add', () => {
    const checks = judgeMail({ spf: [], dmarc: [], dkim: [], mx: [{ exchange: 'mail.example.com', priority: 10 }], aFallback: false, errors: [] }, 'example.com')
    expect(statusOf(checks, 'spf')?.status).toBe('fail')
    expect(statusOf(checks, 'spf')?.fix).toContain('v=spf1')
    expect(statusOf(checks, 'dmarc')?.status).toBe('fail')
    expect(statusOf(checks, 'dmarc')?.fix).toContain('_dmarc.example.com')
    expect(statusOf(checks, 'dkim')?.status).toBe('warn') // MX present → they send mail
  })

  it('~all and -all pass; +all and bare all FAIL — the qualifier is not \b-ambiguous', () => {
    for (const [record, expected] of [
      ['v=spf1 ip4:1.2.3.4 ~all', 'pass'],
      ['v=spf1 include:_spf.google.com -all', 'pass'],
      ['v=spf1 ip4:1.2.3.4 +all', 'fail'],
      ['v=spf1 ip4:1.2.3.4 all', 'fail'], // bare trailing all defaults to +
    ] as const) {
      const checks = judgeMail({ spf: [record], dmarc: ['v=DMARC1; p=reject'], dkim: [], mx: [], aFallback: true, errors: [] }, 'example.com')
      expect(statusOf(checks, 'spf')?.status, record).toBe(expected)
    }
  })

  it('two SPF records are a PermError, not a merge request', () => {
    const checks = judgeMail({ spf: ['v=spf1 ~all', 'v=spf1 -all'], dmarc: [], dkim: [], mx: [], aFallback: true, errors: [] }, 'example.com')
    expect(statusOf(checks, 'spf')?.status).toBe('fail')
    expect(statusOf(checks, 'spf')?.detail).toContain('permanent error')
  })

  it('p=none is a warn (monitoring only); quarantine/reject pass', () => {
    const base: MailRecords = { spf: ['v=spf1 -all'], dmarc: [], dkim: [], mx: [], aFallback: true, errors: [] }
    expect(statusOf(judgeMail({ ...base, dmarc: ['v=DMARC1; p=none'] }, 'example.com'), 'dmarc')?.status).toBe('warn')
    expect(statusOf(judgeMail({ ...base, dmarc: ['v=DMARC1; p=quarantine; rua=mailto:x@y.z'] }, 'example.com'), 'dmarc')?.status).toBe('pass')
    expect(statusOf(judgeMail({ ...base, dmarc: ['v=DMARC1; p=reject'] }, 'example.com'), 'dmarc')?.status).toBe('pass')
    expect(statusOf(judgeMail({ ...base, dmarc: ['v=DMARC1; rua=mailto:x@y.z'] }, 'example.com'), 'dmarc')?.status).toBe('fail') // no p=
  })

  it('no MX + no A = the domain cannot receive mail at all', () => {
    const checks = judgeMail({ spf: [], dmarc: [], dkim: [], mx: [], aFallback: false, errors: [] }, 'example.com')
    expect(statusOf(checks, 'mx')?.status).toBe('fail')
  })

  it('no MX + A present = implicit-MX warn; DKIM verdicts follow whether mail exists at all', async () => {
    const checks = judgeMail({ spf: [], dmarc: [], dkim: [], mx: [], aFallback: true, errors: [] }, 'example.com')
    expect(statusOf(checks, 'mx')?.status).toBe('warn')
    // A record at the apex = they receive mail → an unfound DKIM is a warn.
    expect(statusOf(checks, 'dkim')?.status).toBe('warn')
    // No MX, no A, no SPF = nothing speaks mail here → silence, not a scold.
    const quiet = judgeMail({ spf: [], dmarc: [], dkim: [], mx: [], aFallback: null, errors: [] }, 'example.com')
    expect(statusOf(quiet, 'dkim')?.status).toBe('unknown')
  })
})
