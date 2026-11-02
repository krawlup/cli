/**
 * The dispatch layer: exit codes (0 clean / 1 findings / 2 usage), strict
 * flag parsing, the tri-state robots verdicts (absent vs unreadable vs
 * parsed), the composed `check` with fully injected IO, and the diff
 * orchestration against a real tmpdir. No network anywhere.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  localUsage,
  renderLocalJson,
  renderLocalMarkdown,
  renderLocalText,
  runLocalCommand,
  UsageError,
  type LocalIo,
} from '../src/commands/local.js'
import type { FetchPageResult } from '../src/checks/net.js'

const page = (over: Partial<FetchPageResult> = {}): FetchPageResult => ({
  url: 'https://example.com/',
  status: 200,
  headers: {
    'strict-transport-security': 'max-age=31536000',
    'content-security-policy': "default-src 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'SAMEORIGIN',
  },
  body: `<html><head><title>Example</title><meta property="og:image" content="/card.png"><meta name="twitter:card" content="summary_large_image"><meta property="og:title" content="Example"><meta property="og:description" content="Short."></head><body><h1>Example</h1><p>${'word '.repeat(200)}</p><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"E","url":"https://example.com"}</script></body></html>`,
  truncated: false,
  redirectChain: [],
  ...over,
})

const io = (over: Partial<LocalIo> = {}): LocalIo => ({
  fetchPage: async (url) => {
    if (url.endsWith('/robots.txt')) return { ...page({ url }), body: 'User-agent: *\nDisallow: /private' }
    return page({ url })
  },
  probeTls: async () => ({
    authorized: true,
    authorizationError: null,
    protocol: 'TLSv1.3',
    subjectCN: 'example.com',
    issuer: "Let's Encrypt",
    validFrom: new Date(Date.now() - 30 * 86_400_000),
    validTo: new Date(Date.now() + 300 * 86_400_000),
    sanCount: 3,
  }),
  dns: {
    resolveTxt: async () => [],
    resolveMx: async () => [{ exchange: 'mail.example.com', priority: 10 }],
    resolveA: async () => ['1.2.3.4'],
  },
  ...over,
})

describe('exit codes + usage', () => {
  it('a clean domain exits 0; a finding-bearing one exits 1', async () => {
    const clean = await runLocalCommand('ssl', ['example.com'], io())
    expect(clean.exit).toBe(0)

    const broken = await runLocalCommand('headers', ['example.com'], io({
      fetchPage: async (url) => ({ ...page({ url }), headers: {} }),
    }))
    expect(broken.exit).toBe(1)
    expect(broken.summary.fail).toBeGreaterThan(0)
  })

  it('usage errors are a distinct class for a distinct exit code', async () => {
    await expect(runLocalCommand('ssl', [], io())).rejects.toBeInstanceOf(UsageError)
    await expect(runLocalCommand('ssl', ['https://x.com/path'], io())).rejects.toBeInstanceOf(UsageError) // path on a domain command
    await expect(runLocalCommand('robots', ['example.com', '--agnt', 'GPTBot'], io())).rejects.toBeInstanceOf(UsageError) // typo'd flag
    await expect(runLocalCommand('robots', ['example.com', '--agent'], io())).rejects.toBeInstanceOf(UsageError) // missing value
    await expect(runLocalCommand('og', [], io())).rejects.toBeInstanceOf(UsageError)
  })

  it('domain shorthand and full URLs land on the same page URL', async () => {
    const a = await runLocalCommand('og', ['example.com'], io())
    const b = await runLocalCommand('og', ['https://example.com/blog'], io({
      fetchPage: async (url) => page({ url: 'https://example.com/blog' }),
    }))
    expect(a.meta.url).toBe('https://example.com/')
    expect(b.meta.url).toBe('https://example.com/blog')
  })

  it('every command has a manual for --help', () => {
    for (const cmd of ['check', 'robots', 'mail', 'ssl', 'headers', 'text', 'schema', 'links', 'og', 'diff']) {
      expect(localUsage(cmd), cmd).toContain(`krawlup ${cmd}`)
    }
  })
})

describe('the robots tri-state', () => {
  it('absent robots.txt (404) is a pass, a network error is unknown — never the same verdict', async () => {
    const absent = await runLocalCommand('robots', ['example.com'], io({
      fetchPage: async () => ({ ...page(), status: 404 }),
    }))
    expect(absent.sections[0]!.checks[0]!.status).toBe('pass')

    const down = await runLocalCommand('robots', ['example.com'], io({
      fetchPage: async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
    }))
    expect(down.sections[0]!.checks[0]!.status).toBe('unknown')
    expect(down.sections[0]!.checks[0]!.detail).toContain('ENOTFOUND')
  })

  it('a challenge page at robots.txt warns; a parsed block fails with the agent list', async () => {
    const challenge = await runLocalCommand('robots', ['example.com'], io({
      fetchPage: async () => ({ ...page(), body: '<!doctype html><html>Just a moment…</html>' }),
    }))
    expect(challenge.sections[0]!.checks[0]!.status).toBe('warn')

    const blocking = await runLocalCommand('robots', ['example.com'], io({
      fetchPage: async (url) => ({ ...page({ url }), body: 'User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /' }),
    }))
    const blocked = blocking.sections[0]!.checks.find((c) => c.id === 'ai-blocked')!
    expect(blocked.status).toBe('fail')
    expect(blocked.detail).toContain('GPTBot')
    expect(blocking.exit).toBe(1)
  })

  it('--agent --path answers the ONE question an agent has before crawling', async () => {
    const allowed = await runLocalCommand('robots', ['example.com', '--agent', 'GPTBot', '--path', '/blog/x'], io())
    expect(allowed.sections[0]!.checks.find((c) => c.id === 'agent')!.detail).toContain('MAY fetch /blog/x')

    const denied = await runLocalCommand('robots', ['example.com', '--agent', 'GPTBot', '--path', '/private/x'], io())
    expect(denied.sections[0]!.checks.find((c) => c.id === 'agent')!.status).toBe('fail')
  })
})

describe('the composed check', () => {
  it('runs every section in order with injected IO and marks the mail fails', async () => {
    const r = await runLocalCommand('check', ['example.com'], io())
    expect(r.sections.map((s) => s.id)).toEqual(['tls', 'headers', 'ai-access', 'mail', 'schema', 'og', 'text', 'links'])
    expect(r.exit).toBe(1) // mail has no SPF/DMARC by default
    expect(r.meta.durationMs).toBeTypeOf('number')
  })

  it('a fully healthy site can exit 0', async () => {
    const good = io({
      dns: {
        resolveTxt: async (host) =>
          host === 'example.com'
            ? [['v=spf1 include:_spf.example.net -all']]
            : host === '_dmarc.example.com'
              ? [['v=DMARC1; p=reject; rua=mailto:d@example.com']]
              : host === 'google._domainkey.example.com'
                ? [['v=DKIM1; k=rsa; p=MIIB']]
                : [],
        resolveMx: async () => [{ exchange: 'mail.example.com', priority: 10 }],
        resolveA: async () => ['1.2.3.4'],
      },
      fetchPage: async (url) => {
        if (url.endsWith('/robots.txt')) return { ...page({ url }), body: 'Sitemap: https://example.com/s.xml' }
        return page({ url })
      },
    })
    const r = await runLocalCommand('check', ['example.com'], good)
    expect(r.exit).toBe(0)
    expect(r.summary.fail).toBe(0)
  })

  it('a dead site fails loudly in every section that needs the wire', async () => {
    const r = await runLocalCommand('check', ['example.com'], io({
      fetchPage: async () => {
        throw new Error('connection refused')
      },
      probeTls: async () => null,
    }))
    expect(r.exit).toBe(1)
    const titles = r.sections.map((s) => s.title)
    expect(titles).toContain('TLS certificate')
    expect(titles).toContain('Page')
  })
})

describe('renderers', () => {
  it('text output carries marks, fixes and the section note', async () => {
    const r = await runLocalCommand('check', ['example.com'], io())
    const text = renderLocalText(r)
    expect(text).toContain('✓')
    expect(text).toContain('✗')
    expect(text).toContain('fix: _dmarc.example.com')
    expect(text.split('\n')[0]).toBe('check — example.com')
  })

  it('markdown output is a shareable document with exit code up front', async () => {
    const r = await runLocalCommand('mail', ['example.com'], io())
    const md = renderLocalMarkdown(r)
    expect(md).toContain('# krawlup mail — example.com')
    expect(md).toContain('- ✗ **SPF**')
    expect(md).toMatch(/exit [01]/)
  })

  it('json output is the whole result, machine-parseable', async () => {
    const r = await runLocalCommand('ssl', ['example.com'], io())
    const parsed = JSON.parse(renderLocalJson(r))
    expect(parsed.cmd).toBe('ssl')
    expect(parsed.summary.pass).toBeGreaterThan(0)
    expect(parsed.sections[0].checks[0].status).toBe('pass')
  })
})

describe('diff orchestration (real tmpdir)', () => {
  const dir = path.join(tmpdir(), `krawlup-diff-dispatch-${Date.now()}`)
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('first run stores a baseline (exit 0); a change flips to exit 1 with hunks; --reset re-baselines', async () => {
    let body = '<h1>Version one</h1><p>stable</p>'
    const ctx = io({ fetchPage: async (url) => page({ url, body }), snapshotDir: dir })

    const first = await runLocalCommand('diff', ['example.com'], ctx)
    expect(first.exit).toBe(0)
    expect(first.meta.baseline).toBe(true)

    body = '<h1>Version two</h1><p>stable</p>'
    const second = await runLocalCommand('diff', ['example.com'], ctx)
    expect(second.exit).toBe(1)
    expect(second.meta.changed).toBe(true)
    expect(second.meta.removed).toContain('Version one')
    expect(second.meta.added).toContain('Version two')

    const reset = await runLocalCommand('diff', ['example.com', '--reset'], ctx)
    expect(reset.exit).toBe(0)
    const after = await runLocalCommand('diff', ['example.com'], ctx)
    expect(after.exit).toBe(0)
    expect(after.meta.changed).toBe(false)
  })

  it('a failed fetch never overwrites the stored baseline', async () => {
    const ctx = io({ fetchPage: async (url) => page({ url, body: '<p>precious</p>' }), snapshotDir: dir })
    await runLocalCommand('diff', ['example.com/pricing'], ctx)
    const dead = io({
      fetchPage: async () => {
        throw new Error('connection reset')
      },
      snapshotDir: dir,
    })
    const r = await runLocalCommand('diff', ['example.com/pricing'], dead)
    expect(r.exit).toBe(1)
    expect(r.sections[0]!.checks[0]!.detail).toContain('connection reset')
    // the baseline survives
    const again = await runLocalCommand('diff', ['example.com/pricing'], ctx)
    expect(again.exit).toBe(0)
  })
})

describe('text --as-bot', () => {
  it('the user-agent choice reaches the fetcher', async () => {
    let seenUa: string | undefined
    const r = await runLocalCommand('text', ['example.com', '--as-bot'], io({
      fetchPage: async (url, opts) => {
        seenUa = opts?.ua
        return page({ url })
      },
    }))
    expect(seenUa).toContain('GPTBot')
    expect(r.meta.asBot).toBe(true)
  })
})
