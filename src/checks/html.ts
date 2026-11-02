/**
 * HTML extraction for the local battery — the strip-to-text and JSON-LD
 * rules are derived from the server's (insights-provider.ts / seo-crawl.ts):
 * the JSON-LD context rules are exact ports; the strip adds comment removal
 * and entity decoding, which only ever removes text a browser would not
 * render anyway. No DOM parser: the battery is a zero-dependency binary.
 */

/** Visible text: scripts, styles and tags dropped, whitespace collapsed. */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** Like stripHtmlToText, but each tag boundary becomes a NEWLINE — the
 *  line-per-block shape the drift diff needs (a collapsed one-line strip
 *  would make every edit one giant line). */
export function stripHtmlToLines(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

const isSchemaContext = (ctx: unknown): boolean => {
  if (typeof ctx === 'string') return /schema\.org/i.test(ctx)
  if (ctx && typeof ctx === 'object') {
    const vocab = (ctx as Record<string, unknown>)['@vocab']
    return typeof vocab === 'string' && /schema\.org/i.test(vocab)
  }
  return false
}

function jsonLdBlocks(html: string): unknown[] {
  const parsed: unknown[] = []
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  for (const m of html.matchAll(re)) {
    try {
      parsed.push(JSON.parse((m[1] ?? '').trim()))
    } catch {
      // malformed JSON-LD — contributes nothing (a crawler sees the same)
    }
  }
  return parsed
}

export interface JsonLdNode {
  type: string
  node: Record<string, unknown>
}

/** All schema.org-typed nodes, including @graph members and @type arrays. */
export function extractJsonLdNodes(html: string): JsonLdNode[] {
  const out: JsonLdNode[] = []
  const collect = (node: unknown, inSchema: boolean): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((n) => collect(n, inSchema))
      return
    }
    const obj = node as Record<string, unknown>
    const schema = inSchema || isSchemaContext(obj['@context'])
    if (schema && obj['@type'] != null) {
      const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']]
      for (const t of types) {
        if (typeof t === 'string') out.push({ type: t, node: obj })
      }
    }
    if (obj['@graph']) collect(obj['@graph'], schema)
  }
  for (const block of jsonLdBlocks(html)) collect(block, false)
  return out
}

/** Extract @type values (deduped) — the same facts the scan's AEO check reports. */
export function extractJsonLdTypes(html: string): string[] {
  return [...new Set(extractJsonLdNodes(html).map((n) => n.type))]
}

export interface MetaTag {
  name?: string
  property?: string
  content?: string
  itemprop?: string
}

/** All <meta> tags with their attributes, tolerant of attribute order. */
export function extractMetaTags(html: string): MetaTag[] {
  const out: MetaTag[] = []
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0] ?? ''
    const attr = (name: string): string | undefined =>
      new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((v) => v != null)
    const name = attr('name')
    const property = attr('property')
    const itemprop = attr('itemprop')
    if (!name && !property && !itemprop) continue
    out.push({ name, property, itemprop, content: attr('content') })
  }
  return out
}

/** First <title> text. */
export function extractTitle(html: string): string | null {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() || null
}

/** The meta description, via name= (and itemprop=description fallback). */
export function extractMetaDescription(html: string): string | null {
  for (const tag of extractMetaTags(html)) {
    if (tag.name?.toLowerCase() === 'description' && tag.content) return tag.content.trim()
  }
  for (const tag of extractMetaTags(html)) {
    if (tag.itemprop?.toLowerCase() === 'description' && tag.content) return tag.content.trim()
  }
  return null
}

export interface Heading {
  level: number
  text: string
}

/** h1–h3 outline in document order (the spine an LLM quotes). */
export function extractHeadings(html: string, cap = 20): Heading[] {
  const out: Heading[] = []
  for (const m of html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripHtmlToText(m[2] ?? '')
    if (text) out.push({ level: Number(m[1]), text: text.slice(0, 200) })
    if (out.length >= cap) break
  }
  return out
}

/** Decode the entities that show up inside attribute values — a browser
 *  decodes them before requesting, so a checker that skips this fetches a
 *  URL nobody's browser ever asks for (and reports false breakage). The
 *  ampersand is decoded LAST: `&amp;lt;` must become the TEXT `&lt;` (one
 *  decode, what a browser sees), never `<` (a second decode it never does). */
function decodeAttr(raw: string): string {
  return raw
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
}

/** EVERY http(s) href on the page — internal AND outbound. Port of the
 *  crawl's hrefs(): mailto/tel/javascript/data/fragment links can't be
 *  followed by a crawler either, so they never enter the check. */
export function extractHrefs(html: string, base: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    const raw = decodeAttr((m[1] || '').trim())
    if (!raw || /^(mailto:|tel:|javascript:|data:|#)/i.test(raw)) continue
    try {
      const u = new URL(raw, base)
      if (!/^https?:$/.test(u.protocol)) continue
      u.hash = ''
      out.push(u.toString())
    } catch {
      /* unparseable href — not a link a crawler can follow either */
    }
  }
  return out
}
