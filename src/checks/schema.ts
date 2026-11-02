/**
 * `krawlup schema <url>` — JSON-LD lint: which types are declared, and for
 * the common ones, the required properties a consumer (Google, an assistant,
 * a rich-result renderer) needs before the markup is worth anything.
 * Required-property sets cover the properties that actually gate rich
 * results — not the full schema.org graph.
 */
import type { Check, Section } from './verdict.js'
import { extractJsonLdNodes } from './html.js'

/** Required properties per type (the rich-result gates). */
export const REQUIRED_PROPS: Record<string, string[]> = {
  Organization: ['name', 'url'],
  WebSite: ['name', 'url'],
  Person: ['name'],
  Product: ['name', 'image', 'offers'],
  Article: ['headline', 'author', 'datePublished'],
  NewsArticle: ['headline', 'author', 'datePublished'],
  BlogPosting: ['headline', 'author', 'datePublished'],
  FAQPage: ['mainEntity'],
  LocalBusiness: ['name', 'address'],
  BreadcrumbList: ['itemListElement'],
  SoftwareApplication: ['name'],
  Event: ['name', 'startDate', 'location'],
}

function nodeHasProp(node: Record<string, unknown>, prop: string): boolean {
  const v = node[prop]
  if (v == null) return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length > 0
  if (typeof v === 'string') return v.trim().length > 0
  return true
}

export function lintSchema(html: string): Section {
  const nodes = extractJsonLdNodes(html)
  const checks: Check[] = []

  if (nodes.length === 0) {
    const hasMicrodata = /itemtype=["'][^"']*schema\.org/i.test(html)
    checks.push({
      id: 'jsonld',
      label: 'Structured data',
      status: 'fail',
      detail: hasMicrodata
        ? 'No JSON-LD found, but schema.org microdata is present — JSON-LD is the format Google and assistants prefer; keep the facts, move the markup.'
        : 'No structured data at all — assistants and rich results have nothing to quote.',
      fix: 'Add one JSON-LD block: <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"…","url":"…"}</script>',
    })
    return { id: 'schema', title: 'Structured data (JSON-LD)', checks }
  }

  const linted = new Set<string>()
  const unknown = new Set<string>()
  const seenRequired = new Map<string, string[]>() // type -> missing props (first node wins)

  for (const { type, node } of nodes) {
    const required = REQUIRED_PROPS[type]
    if (!required) {
      unknown.add(type)
      continue
    }
    if (linted.has(type)) continue
    linted.add(type)
    const missing = required.filter((p) => !nodeHasProp(node, p))
    if (missing.length) seenRequired.set(type, missing)
  }

  for (const [type, missing] of seenRequired) {
    checks.push({
      id: `schema-${type.toLowerCase()}`,
      label: type,
      status: 'fail',
      detail: `Declared but missing required propert${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}.`,
    })
  }
  for (const type of linted) {
    if (!seenRequired.has(type)) {
      checks.push({ id: `schema-${type.toLowerCase()}`, label: type, status: 'pass', detail: `Complete — all of ${REQUIRED_PROPS[type]!.join(', ')} present.` })
    }
  }
  if (unknown.size) {
    checks.push({ id: 'schema-other', label: 'Other types', status: 'unknown', detail: `Present, not linted: ${[...unknown].sort().join(', ')}.` })
  }

  const microdataOnly = /itemtype=["'][^"']*schema\.org\/(FAQPage|QAPage)/i.test(html) && !nodes.some((n) => n.type === 'FAQPage')
  if (microdataOnly) {
    checks.push({ id: 'schema-microdata-faq', label: 'FAQ (microdata)', status: 'unknown', detail: 'FAQPage appears as microdata but not as JSON-LD — Google accepts both, JSON-LD is easier to keep correct.' })
  }

  return { id: 'schema', title: 'Structured data (JSON-LD)', checks }
}
