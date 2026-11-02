/**
 * The page-content battery: header audit, extraction ports, JSON-LD lint,
 * the social-card verdict, and the extractable-text lens — all pure, all
 * offline.
 */
import { describe, expect, it } from 'vitest'
import { auditHeaders } from '../src/checks/headers.js'
import {
  extractHeadings,
  extractHrefs,
  extractJsonLdNodes,
  extractJsonLdTypes,
  extractMetaDescription,
  extractMetaTags,
  extractTitle,
  stripHtmlToLines,
  stripHtmlToText,
} from '../src/checks/html.js'
import { lintSchema } from '../src/checks/schema.js'
import { collectOgFacts, judgeOg } from '../src/checks/og.js'
import { judgeText, textFacts } from '../src/checks/text.js'

const status = (sec: { checks: Array<{ id: string; status: string }> }, id: string) =>
  sec.checks.find((c) => c.id === id)?.status

describe('auditHeaders', () => {
  const clean: Record<string, string> = {
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'content-security-policy': "default-src 'self'; script-src 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'x-frame-options': 'SAMEORIGIN',
  }

  it('a page with all the required headers passes every hard check', () => {
    const sec = auditHeaders(clean, { status: 200 })
    expect(status(sec, 'hsts')).toBe('pass')
    expect(status(sec, 'csp')).toBe('pass')
    expect(status(sec, 'xcto')).toBe('pass')
    expect(status(sec, 'framing')).toBe('pass')
    expect(status(sec, 'referrer')).toBe('pass')
    // advisories stay warns when absent
    expect(status(sec, 'permissions')).toBe('warn')
    expect(status(sec, 'coop')).toBe('warn')
  })

  it('every missing required header is a fail WITH the exact header to add', () => {
    const sec = auditHeaders({}, { status: 200 })
    for (const id of ['hsts', 'csp', 'xcto', 'framing', 'referrer']) {
      const check = sec.checks.find((c) => c.id === id)
      expect(check?.status, id).toBe('fail')
      expect(check?.fix, id).toMatch(/:/)
    }
  })

  it('a CSP frame-ancestors satisfies the framing check without X-Frame-Options', () => {
    const sec = auditHeaders({ 'content-security-policy': "frame-ancestors 'self'" }, { status: 200 })
    expect(status(sec, 'framing')).toBe('pass')
  })

  it('a short HSTS max-age and a wrong nosniff value are warns, not passes', () => {
    expect(status(auditHeaders({ 'strict-transport-security': 'max-age=86400' }, { status: 200 }), 'hsts')).toBe('warn')
    expect(status(auditHeaders({ 'x-content-type-options': 'none' }, { status: 200 }), 'xcto')).toBe('warn')
  })

  it('an error page annotates the section instead of pretending it did not happen', () => {
    const sec = auditHeaders({}, { status: 403 })
    expect(sec.note).toContain('403')
  })
})

describe('html extraction ports', () => {
  const page = `<html><head>
    <title>Example — Home</title>
    <meta content="First description" name="description">
    <meta property="og:title" content="Shared!">
    <meta name="twitter:card" content="summary_large_image">
  </head><body>
    <h1>Hello</h1><p>One</p><h2>Sub</h2><a href="/pricing">Pricing</a>
    <a href="https://other.com/x">Out</a><a href="mailto:a@b.c">Mail</a>
    <a href="#top">Top</a><a href="javascript:void(0)">JS</a>
  </body></html>`

  it('stripHtmlToText drops scripts/styles/comments and collapses whitespace', () => {
    expect(stripHtmlToText('<p>a</p><script>evil()</script><style>.x{}</style><p>b &amp; c</p>')).toBe('a b & c')
  })

  it('stripHtmlToLines keeps block boundaries as lines (the diff needs them)', () => {
    expect(stripHtmlToLines('<h1>A</h1><p>B</p>')).toBe('A\nB')
  })

  it('meta tags parse in ANY attribute order', () => {
    const tags = extractMetaTags(page)
    expect(tags.find((t) => t.name === 'description')?.content).toBe('First description')
    expect(tags.find((t) => t.property === 'og:title')?.content).toBe('Shared!')
    expect(extractTitle(page)).toBe('Example — Home')
    expect(extractMetaDescription(page)).toBe('First description')
  })

  it('hrefs: resolves relative, drops mailto/fragment/javascript, strips hashes', () => {
    const hrefs = extractHrefs(page, 'https://example.com/')
    expect(hrefs).toEqual(['https://example.com/pricing', 'https://other.com/x'])
  })

  it('hrefs: decodes the entities a browser decodes before requesting', () => {
    const html = '<a href="https://x.com/a?utm=1&amp;utm=2">badges</a><a href="/q?a=1&amp;b=2">rel</a>'
    expect(extractHrefs(html, 'https://example.com/')).toEqual([
      'https://x.com/a?utm=1&utm=2',
      'https://example.com/q?a=1&b=2',
    ])
  })

  it('hrefs: decodes ONCE — the literal text &amp;lt; never becomes <', () => {
    // A browser renders the attribute value `&amp;lt;` as the text "&lt;";
    // double-decoding it into "<" would fetch a URL no browser ever asks for.
    const html = '<a href="https://x.com/?q=&amp;lt;script&amp;gt;">tricky</a>'
    expect(extractHrefs(html, 'https://example.com/')).toEqual(['https://x.com/?q=&lt;script&gt;'])
  })

  it('headings keep document order and level', () => {
    expect(extractHeadings(page)).toEqual([
      { level: 1, text: 'Hello' },
      { level: 2, text: 'Sub' },
    ])
  })
})

describe('JSON-LD extraction (the server rules)', () => {
  it('a bare @type without a schema.org @context contributes nothing', () => {
    const html = '<script type="application/ld+json">{"@type":"Product","name":"x"}</script>'
    expect(extractJsonLdTypes(html)).toEqual([])
  })

  it('@graph members inherit the root context; @type arrays fan out', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': ['Organization', 'WebSite'], name: 'x' }],
    })}</script>`
    expect(extractJsonLdTypes(html).sort()).toEqual(['Organization', 'WebSite'])
    expect(extractJsonLdNodes(html)[0]!.node.name).toBe('x')
  })

  it('malformed JSON-LD reads as absent (what a crawler sees too)', () => {
    expect(extractJsonLdTypes('<script type="application/ld+json">{oops</script>')).toEqual([])
  })
})

describe('lintSchema', () => {
  it('no structured data at all is a fail with a starter block', () => {
    const sec = lintSchema('<html><body>plain</body></html>')
    expect(sec.checks[0]!.status).toBe('fail')
    expect(sec.checks[0]!.fix).toContain('application/ld+json')
  })

  it('microdata without JSON-LD steers, not scolds', () => {
    const sec = lintSchema('<div itemtype="https://schema.org/Product" itemscope>x</div>')
    expect(sec.checks[0]!.detail).toContain('microdata')
  })

  it('a Product missing its image/offers fails naming exactly what is missing', () => {
    const sec = lintSchema(
      `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Thing' })}</script>`,
    )
    expect(sec.checks).toHaveLength(1)
    expect(sec.checks[0]!.status).toBe('fail')
    expect(sec.checks[0]!.detail).toContain('image, offers')
  })

  it('a complete Organization + unknown type mixes pass and not-linted', () => {
    const sec = lintSchema(
      `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'Organization', name: 'X', url: 'https://x.com' },
          { '@type': 'CreativeWork', name: 'y' },
        ],
      })}</script>`,
    )
    expect(status(sec, 'schema-organization')).toBe('pass')
    const other = sec.checks.find((c) => c.id === 'schema-other')
    expect(other?.status).toBe('unknown')
    expect(other?.detail).toContain('CreativeWork')
  })
})

describe('the social-card verdict', () => {
  const meta = (tags: Array<Partial<{ property: string; name: string; content: string }>>) =>
    tags.map((t) => ({ property: t.property, name: t.name, content: t.content }))

  it('no og:image is the headline fail; title falls back to <title> with a nudge', () => {
    const facts = collectOgFacts(meta([]), 'Page Title', 'desc', 'https://example.com/')
    const sec = judgeOg(facts, 'https://example.com/')
    expect(status(sec, 'og-image')).toBe('fail')
    expect(status(sec, 'og-title')).toBe('fail')
    expect(sec.checks.find((c) => c.id === 'og-title')!.detail).toContain('Page Title')
    expect(sec.note).toContain('(nothing)')
  })

  it('a complete card passes and previews what X will show', () => {
    const facts = collectOgFacts(
      meta([
        { property: 'og:title', content: 'Launch' },
        { property: 'og:description', content: 'Ship faster.' },
        { property: 'og:image', content: '/card.png' },
        { name: 'twitter:card', content: 'summary_large_image' },
      ]),
      'Page Title',
      null,
      'https://example.com/',
    )
    const sec = judgeOg(facts, 'https://example.com/')
    expect(status(sec, 'og-image')).toBe('pass')
    expect(facts.ogImage).toBe('https://example.com/card.png') // resolved absolute
    expect(status(sec, 'twitter-card')).toBe('pass')
    expect(sec.note).toContain('Launch')
  })

  it('an http image on an https page is a warn; a foreign og:url host too', () => {
    const facts = collectOgFacts(
      meta([
        { property: 'og:image', content: 'http://cdn.example.com/card.png' },
        { property: 'og:url', content: 'https://other.example/' },
      ]),
      'T',
      null,
      'https://example.com/',
    )
    const sec = judgeOg(facts, 'https://example.com/')
    expect(status(sec, 'og-image')).toBe('warn')
    expect(status(sec, 'og-url')).toBe('warn')
  })
})

describe('the extractable-text lens', () => {
  it('a JS-only shell fails with the word count as evidence', () => {
    const facts = textFacts('<html><head><title>App</title></head><body><div id="root"></div><script src="app.js"></script></body></html>')
    expect(facts.wordCount).toBe(1) // only the <title> text survives a non-rendering fetch
    const sec = judgeText(facts)
    expect(status(sec, 'extractable')).toBe('fail')
    expect(sec.note).toContain('App')
  })

  it('a rich page passes and reports its outline', () => {
    const html = `<h1>Guide</h1><p>${'word '.repeat(200)}</p><h2>Part two</h2><p>${'more '.repeat(60)}</p>`
    const sec = judgeText(textFacts(html))
    expect(status(sec, 'extractable')).toBe('pass')
    expect(status(sec, 'outline')).toBe('pass')
    expect(sec.checks.find((c) => c.id === 'outline')!.detail).toContain('Guide')
  })

  it('two h1s draw the multipolar-document warn', () => {
    const sec = judgeText(textFacts(`<h1>One</h1><p>${'a '.repeat(200)}</p><h1>Two</h1>`))
    expect(status(sec, 'outline')).toBe('warn')
  })
})
