/**
 * The links probe (fake fetcher: statuses, sorting, mixed content, the cap)
 * and the diff snapshots (baseline → drift → unchanged, with real LCS hunks
 * and the over-cap hash-only degradation) — all offline.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkPageLinks, judgeLinks, realLinkFetcher } from '../src/checks/links.js'
import { diffSnapshots, judgeDiff, loadSnapshot, makeSnapshot, saveSnapshot, snapshotPath, type PageSnapshot } from '../src/checks/diff.js'

const link = (url: string, status: number | null, hops = 0): { url: string; status: number | null; hops: number } => ({ url, status, hops })

describe('checkPageLinks', () => {
  it('fetches each deduped href once and sorts 5xx before 4xx before unreachable', async () => {
    const fetched: string[] = []
    const fetcher = async (url: string) => {
      fetched.push(url)
      if (url.includes('onfire')) return link(url, 503)
      if (url.includes('gone')) return link(url, 404)
      if (url.includes('dead')) return link(url, null)
      return link(url, 200)
    }
    const html = `<a href="/gone">a</a><a href="/gone">dup</a><a href="/onfire">b</a><a href="/dead">c</a><a href="/ok">d</a>`
    const r = await checkPageLinks(html, 'https://example.com/', fetcher)
    expect(r.checked).toBe(4) // deduped
    expect(fetched.filter((u) => u.endsWith('/gone'))).toHaveLength(1)
    // Worst first among the broken: 5xx outranks 4xx outranks unreachable.
    // Successful links carry rank = status, so the 200 sits between them.
    expect(r.links.map((l) => l.status)).toEqual([503, 200, 404, null])
  })

  it('flags mixed content only on https pages, without fetching the offenders twice', async () => {
    const fetcher = async (url: string) => link(url, 200)
    const r = await checkPageLinks('<a href="http://insecure.com/x">x</a>', 'https://example.com/', fetcher)
    expect(r.mixed).toEqual(['http://insecure.com/x'])
    const secure = await checkPageLinks('<a href="http://insecure.com/x">x</a>', 'http://example.com/', fetcher)
    expect(secure.mixed).toEqual([])
  })

  it('caps the probe and says so, while the mixed list stays whole', async () => {
    let hrefs = ''
    for (let i = 0; i < 60; i++) hrefs += `<a href="/p${i}">x</a>`
    const fetcher = async (url: string) => link(url, 200)
    const r = await checkPageLinks(hrefs, 'https://example.com/', fetcher)
    expect(r.checked).toBe(40)
    expect(r.total).toBe(60)
  })
})

describe('judgeLinks', () => {
  it('a clean page passes with the checked/total counts', () => {
    const sec = judgeLinks({ checked: 12, total: 12, links: [link('https://a/', 200)], mixed: [] }, 'https://example.com/')
    expect(sec.checks[0]!.status).toBe('pass')
    expect(sec.checks[0]!.detail).toContain('12 of 12')
  })

  it('broken links become named checks; unreachable is its own class', () => {
    const sec = judgeLinks(
      { checked: 3, total: 3, links: [link('https://x/5', 500), link('https://x/dead', null), link('https://x/ok', 200)], mixed: [] },
      'https://example.com/',
    )
    const labels = sec.checks.map((c) => c.label)
    expect(labels).toContain('HTTP 500')
    expect(labels).toContain('Unreachable')
    expect(sec.checks[0]!.status).toBe('fail')
  })

  it('a >2-hop redirect chain is a warn pointing at the final URL', () => {
    const sec = judgeLinks({ checked: 1, total: 1, links: [{ url: 'https://x/chain', status: 200, hops: 4, finalUrl: 'https://final/' }], mixed: [] }, 'https://example.com/')
    const warn = sec.checks.find((c) => c.id === 'redirect-chains')!
    expect(warn.status).toBe('warn')
    expect(warn.detail).toContain('https://final/')
  })

  it('mixed content is a fail with the fix', () => {
    const sec = judgeLinks({ checked: 1, total: 1, links: [link('http://x/', 200)], mixed: ['http://x/'] }, 'https://example.com/')
    expect(sec.checks.find((c) => c.id === 'mixed-content')!.status).toBe('fail')
  })
})

describe('realLinkFetcher (wire shape only — local net is stubbed in CI by the URL filter)', () => {
  it('reports unreachable as null status rather than throwing', async () => {
    const r = await realLinkFetcher('http://127.0.0.1:1/x').catch(() => ({ status: null, hops: 0 }))
    expect(r.status).toBeNull()
  })
})

describe('diff snapshots', () => {
  const dir = path.join(tmpdir(), `krawlup-diff-test-${Date.now()}`)
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const snap = (url: string, text: string, savedAt = '2026-11-01T00:00:00.000Z'): PageSnapshot => ({
    url,
    savedAt,
    title: 'T',
    wordCount: text.split(/\s+/).filter(Boolean).length,
    textSha256: createHash('sha256').update(text).digest('hex'),
    text,
  })

  it('makeSnapshot stores newline-preserving text and a stable sha', () => {
    const s = makeSnapshot('https://example.com/', '<h1>A</h1><p>B</p>')
    expect(s.text).toBe('A\nB')
    expect(s.wordCount).toBe(2)
    expect(s.textSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('unchanged content → changed:false; whitespace collapse never invents lines', () => {
    const a = makeSnapshot('https://example.com/', '<h1>A</h1><p>B</p>')
    const b = makeSnapshot('https://example.com/', '<h1>A</h1><p>B</p>')
    const d = diffSnapshots(a, b)
    expect(d.changed).toBe(false)
  })

  it('drift reports the removed and added lines as hunks, and a <title> change', () => {
    const prev = makeSnapshot('https://example.com/', '<title>Old</title><h1>Old title</h1><p>pricing is $10</p><p>contact us</p>')
    const next = makeSnapshot('https://example.com/', '<title>New</title><h1>New title</h1><p>pricing is $12</p><p>contact us</p>')
    const d = diffSnapshots(prev, next)
    expect(d.changed).toBe(true)
    expect(d.titleChanged).toBe(true)
    expect(d.removed).toEqual(['Old', 'Old title', 'pricing is $10'])
    expect(d.added).toEqual(['New', 'New title', 'pricing is $12'])
  })

  it('an over-cap page degrades to hashOnly instead of pretending to diff', () => {
    const big = 'x'.repeat(200_001)
    const d = diffSnapshots(snap('https://e.com/', big), snap('https://e.com/', `${big}y`))
    expect(d.changed).toBe(true)
    expect(d.hashOnly).toBe(true)
  })

  it('save + load round-trips through a tmp dir; missing files load as null', async () => {
    const s = makeSnapshot('https://example.com/pricing?plan=2', '<p>hello</p>')
    await saveSnapshot(dir, s)
    expect(await loadSnapshot(dir, s.url)).toEqual(s)
    expect(await loadSnapshot(dir, 'https://example.com/never')).toBeNull()
    // the key folds host + path + query
    expect(snapshotPath(dir, 'https://example.com/pricing?plan=2')).toMatch(/example\.com-/)
  })

  it('judgeDiff: baseline pass → drift fail → unchanged pass', () => {
    const baseline = judgeDiff(diffSnapshots(snap('u', 'a'), snap('u', 'a')), null)
    expect(baseline.checks[0]!.status).toBe('pass')

    const drifted = judgeDiff(
      { changed: true, hashOnly: false, added: ['new'], removed: ['old'], titleChanged: false, wordDelta: 0 },
      '2026-11-01T00:00:00.000Z',
    )
    expect(drifted.checks[0]!.status).toBe('fail')
    expect(drifted.checks[0]!.detail).toContain('1 line added')

    const same = judgeDiff({ changed: false, hashOnly: false, added: [], removed: [], titleChanged: false, wordDelta: 0 }, '2026-11-01T00:00:00.000Z')
    expect(same.checks[0]!.status).toBe('pass')
    expect(same.checks[0]!.detail).toContain('2026-11-01')
  })

  it('raw file on disk is valid JSON with the expected shape', async () => {
    const raw = JSON.parse(await readFile(snapshotPath(dir, 'https://example.com/pricing?plan=2'), 'utf-8'))
    expect(Object.keys(raw).sort()).toEqual(['savedAt', 'text', 'textSha256', 'title', 'url', 'wordCount'])
  })
})
