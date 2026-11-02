/**
 * The robots battery: the parser is a PORT of the server's, so the tests pin
 * the exact behaviors the server's own spec pins — user-agent-boundary
 * records, own-group precedence, whole-site vs path exclusion, and the
 * never-a-clean-bill-of-health rule for unreadable files — plus the CLI-only
 * per-path RFC 9309 matching.
 */
import { describe, expect, it } from 'vitest'
import {
  agentBlockedByRobots,
  blocksEverything,
  parseRobotsForAi,
  parseRobotsRecords,
  pathAllowedFor,
  ruleMatchesPath,
} from '../src/checks/robots.js'

const FULL_BLOCK = `
User-agent: *
Disallow: /
`

const GPTBOT_ONLY = `
User-agent: GPTBot
Disallow: /

User-agent: *
Disallow: /private
`

describe('parseRobotsRecords', () => {
  it('splits records on user-agent boundaries, NOT blank lines', () => {
    // No blank lines at all — several CMS plugins emit exactly this.
    const noBlanks = 'User-agent: GPTBot\nDisallow: /\nUser-agent: *\nDisallow: /private'
    const parsed = parseRobotsRecords(noBlanks)!
    expect(parsed.records).toHaveLength(2)
    expect(parsed.records[0]).toEqual({ agents: ['gptbot'], rules: [{ allow: false, pattern: '/' }] })
    expect(parsed.records[1]).toEqual({ agents: ['*'], rules: [{ allow: false, pattern: '/private' }] })
  })

  it('groups consecutive user-agent lines into ONE record', () => {
    const parsed = parseRobotsRecords('User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /')!
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0]!.agents).toEqual(['gptbot', 'ccbot'])
  })

  it('an HTML challenge or empty body parses to null — never "no rules"', () => {
    expect(parseRobotsRecords('<!doctype html><html><body>Just checking…</body></html>')).toBeNull()
    expect(parseRobotsRecords('')).toBeNull()
    expect(parseRobotsRecords('   \n  ')).toBeNull()
  })

  it('comments are stripped and sitemap is detected', () => {
    const parsed = parseRobotsRecords('# comment\nSitemap: https://x.com/s.xml\nUser-agent: *\nDisallow: /admin # staff only')!
    expect(parsed.sitemapDeclared).toBe(true)
    expect(parsed.records[0]!.rules).toEqual([{ allow: false, pattern: '/admin' }])
  })
})

describe('whole-site verdicts (the AI matrix)', () => {
  it('a full-block wildcard group blocks every known AI crawler', () => {
    const parsed = parseRobotsForAi(FULL_BLOCK)!
    expect(parsed.total).toBeGreaterThan(30)
    expect(parsed.blocked.length).toBe(parsed.total)
  })

  it('a path-specific Disallow is NOT a block', () => {
    const parsed = parseRobotsForAi('User-agent: *\nDisallow: /private\n')!
    expect(parsed.blocked).toEqual([])
  })

  it('an Allow that covers everything overrides the Disallow', () => {
    const parsed = parseRobotsForAi('User-agent: *\nDisallow: /\nAllow: /\n')!
    expect(parsed.blocked).toEqual([])
  })

  it('an unreadable file reports nothing blocked and unblocks nothing', () => {
    expect(parseRobotsForAi('<html>challenge</html>')).toBeNull()
  })

  it('own-group precedence: GPTBot blocked while * stays scoped', () => {
    const parsed = parseRobotsForAi(GPTBOT_ONLY)!
    expect(parsed.blocked).toEqual(['GPTBot'])
    expect(agentBlockedByRobots(parseRobotsRecords(GPTBOT_ONLY)!.records, ['ccbot'])).toBe(false)
  })
})

describe('blocksEverything shapes', () => {
  it('covers the wild variants that still block the site', () => {
    expect(blocksEverything('/')).toBe(true)
    expect(blocksEverything('/*')).toBe(true)
    expect(blocksEverything('/*$')).toBe(true)
    expect(blocksEverything('')).toBe(true)
    expect(blocksEverything('/private')).toBe(false)
    expect(blocksEverything('/blog/*')).toBe(false)
  })
})

describe('per-path matching (RFC 9309)', () => {
  it('matches prefixes, * wildcards and $ anchors', () => {
    expect(ruleMatchesPath('/admin', '/admin/settings')).toBe(true)
    expect(ruleMatchesPath('/*.pdf$', '/files/doc.pdf')).toBe(true)
    expect(ruleMatchesPath('/*.pdf$', '/files/doc.pdfx')).toBe(false)
    expect(ruleMatchesPath('/blog/*', '/blog/2024/post')).toBe(true)
    expect(ruleMatchesPath('/blog/*', '/prices')).toBe(false)
  })

  it('caps site-controlled patterns before they become regexes (hostile robots.txt)', () => {
    // 17 wildcards / 300 chars are far beyond any real rule; both must never
    // match — a remote file must not be able to spend local CPU backtracking.
    const manyWildcards = '/' + 'a*'.repeat(20)
    expect(manyWildcards.split('*').length - 1).toBeGreaterThan(16)
    expect(ruleMatchesPath(manyWildcards, '/aaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false)
    expect(ruleMatchesPath(`${'x'.repeat(300)}*`, '/xxxxxxxxxxxxxxxx')).toBe(false)
    // Ordinary rules right at the sane edge still work.
    expect(ruleMatchesPath(`/${'x'.repeat(200)}*`, `/${'x'.repeat(200)}y`)).toBe(true)
  })

  it('the LONGEST matching rule wins within the applicable group', () => {
    const records = parseRobotsRecords('User-agent: *\nDisallow: /\nAllow: /blog')!.records
    expect(pathAllowedFor(records, 'gptbot', '/prices').allowed).toBe(false)
    expect(pathAllowedFor(records, 'gptbot', '/blog/post').allowed).toBe(true)
    expect(pathAllowedFor(records, 'gptbot', '/blog/post').matched?.allow).toBe(true)
  })

  it('no group for the agent and no wildcard = unrestricted', () => {
    const records = parseRobotsRecords('User-agent: GPTBot\nDisallow: /x')!.records
    const v = pathAllowedFor(records, 'perplexitybot', '/')
    expect(v.groupFound).toBe(false)
    expect(v.allowed).toBeNull()
  })

  it('an empty Disallow value matches nothing (it means "allow all")', () => {
    const records = parseRobotsRecords('User-agent: *\nDisallow:')!.records
    expect(pathAllowedFor(records, 'gptbot', '/').allowed).toBe(true)
  })

  it('the path is matched with its query string', () => {
    const records = parseRobotsRecords('User-agent: *\nDisallow: /*?s=')!.records
    expect(pathAllowedFor(records, 'gptbot', '/search?s=robot').allowed).toBe(false)
    expect(pathAllowedFor(records, 'gptbot', '/search').allowed).toBe(true)
  })
})
