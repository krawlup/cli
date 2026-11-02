/**
 * The report-format helpers both terminal surfaces share — pinned: tri-state
 * honesty (an unchecked value is never scored false), the ms/s display
 * rule, the vitals ordering, the sanitized robots list, the capped evidence
 * flattener, and the capture-URL absolutizer.
 */
import { describe, expect, it } from 'vitest'
import {
  absShotUrl,
  blockedAgents,
  fmtClsValue,
  fmtDurationSec,
  fmtMs,
  humanizeId,
  mobileEvidenceLines,
  pickFirstEditAuditId,
  tri,
  vitalsEntries,
} from '../src/lib/report-format.js'

describe('tri', () => {
  it('never turns an unchecked value into a fail', () => {
    expect(tri(true)).toBe('pass')
    expect(tri(false)).toBe('fail')
    expect(tri(null)).toBe('unknown')
    expect(tri(undefined)).toBe('unknown')
  })
})

describe('fmtMs / fmtClsValue / fmtDurationSec', () => {
  it('keeps sub-second values in ms and switches at 1s', () => {
    expect(fmtMs(450)).toBe('450ms')
    expect(fmtMs(1800)).toBe('1.8s')
    expect(fmtMs(null)).toBe('—')
    expect(fmtMs(Number.NaN)).toBe('—')
  })
  it('CLS keeps three decimals; duration reads like a clock', () => {
    expect(fmtClsValue(0.31234)).toBe('0.312')
    expect(fmtClsValue(null)).toBe('—')
    expect(fmtDurationSec(48)).toBe('48s')
    expect(fmtDurationSec(96)).toBe('1m 36s')
    expect(fmtDurationSec(null)).toBe('—')
  })
})

describe('humanizeId', () => {
  it('splits check ids and titles the first word', () => {
    expect(humanizeId('tap_targets')).toBe('Tap targets')
    expect(humanizeId('viewport_meta')).toBe('Viewport meta')
    expect(humanizeId(null)).toBe('check')
  })
  it('uppercases known acronyms', () => {
    expect(humanizeId('cta')).toBe('CTA')
    expect(humanizeId('ssl')).toBe('SSL')
  })
})

describe('vitalsEntries', () => {
  it('leads with the two core vitals and skips unmeasured ones', () => {
    expect(vitalsEntries({ lcpMs: 4200, cls: 0.31, fcpMs: 1800 })).toEqual([
      ['LCP', '4.2s'],
      ['CLS', '0.310'],
      ['FCP', '1.8s'],
    ])
    expect(vitalsEntries(null)).toEqual([])
    expect(vitalsEntries({})).toEqual([])
  })
})

describe('blockedAgents', () => {
  it('sanitizes the robots list and tolerates junk', () => {
    expect(blockedAgents({ blocked: ['GPTBot', 'CCBot'], total: 33 })).toEqual({ blocked: ['GPTBot', 'CCBot'], total: 33 })
    expect(blockedAgents({ blocked: null, total: undefined })).toEqual({ blocked: [], total: 0 })
    expect(blockedAgents(null)).toEqual({ blocked: [], total: 0 })
  })
})

describe('mobileEvidenceLines', () => {
  it('flattens the evidence lists under labels and caps the total', () => {
    const lines = mobileEvidenceLines({
      offscreen: [{ tag: 'div', text: 'pricing', note: 'below 390px fold' }],
      tapTargets: [{ tag: 'a', text: 'Sign up' }],
      overlay: { ctaText: 'Start free', snippet: 'cookie banner' },
      smallText: null,
    })
    expect(lines).toEqual([
      'offscreen: div · pricing',
      'tap target: a · Sign up',
      'overlay: "Start free" covers the CTA — cookie banner',
    ])
    const many = mobileEvidenceLines({
      offscreen: Array.from({ length: 9 }, (_, i) => ({ tag: `d${i}`, text: 'x' })),
    })
    expect(many).toHaveLength(6)
    expect(mobileEvidenceLines(null)).toEqual([])
  })
})

describe('absShotUrl', () => {
  it('prefixes the krawlup.com origin on relative public-shot paths', () => {
    expect(absShotUrl('/public-shots/a.png')).toBe('https://krawlup.com/public-shots/a.png')
    expect(absShotUrl('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png')
    expect(absShotUrl(null)).toBeNull()
    expect(absShotUrl('')).toBeNull()
  })
})

describe('pickFirstEditAuditId', () => {
  const issues = [
    { id: 'meta-description', category: 'seo', title: 'Missing meta description' },
    { id: 'uses-responsive-images', category: 'performance', savingsMs: 900 },
    { id: 'unused-css', category: 'performance', savingsMs: 2400 },
  ]
  it('prefers the biggest measured saving — the server rule, re-derived', () => {
    expect(pickFirstEditAuditId(issues)).toBe('unused-css')
  })
  it('falls back to the first failing SEO audit, then the first audit', () => {
    expect(pickFirstEditAuditId([issues[0], { id: 'a', category: 'performance' }])).toBe('meta-description')
    expect(pickFirstEditAuditId([{ id: 'a', category: 'performance' }])).toBe('a')
    expect(pickFirstEditAuditId([])).toBeNull()
    expect(pickFirstEditAuditId(null)).toBeNull()
  })
})
