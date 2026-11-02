/**
 * `krawlup links <url>` — the depth-1 broken-link audit, mirroring the
 * crawl's link leg: GET (never HEAD — CDNs 405/403 HEADs and that would
 * read as broken), manual redirects with the chain preserved, per-link
 * timeout, bounded concurrency. Unreachable counts as broken — a link a
 * visitor clicks and waits forever on is dead in practice — but sorts
 * below hard 4xx/5xx.
 */
import type { Check, Section } from './verdict.js'
import { extractHrefs } from './html.js'
import { localFetch, KRAWLUP_CLI_UA } from './net.js'

export interface LinkResult {
  url: string
  /** null = unreachable (timeout/refused) — sorted below any real status. */
  status: number | null
  hops: number
  finalUrl?: string
}

export type LinkFetcher = (url: string) => Promise<{ status: number | null; hops: number; finalUrl?: string }>

export const LINK_CHECK_CAP = 40
const LINK_CONCURRENCY = 8
const LINK_TIMEOUT_MS = 10_000

/** The real per-link probe: GET with manual redirects, chain counted. */
export const realLinkFetcher: LinkFetcher = async (url) => {
  let current = url
  let hops = 0
  for (let i = 0; i < 4; i++) {
    const res = await fetch(current, {
      headers: { 'User-Agent': KRAWLUP_CLI_UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) return { status: res.status, hops, finalUrl: current }
      current = new URL(location, current).toString()
      hops++
      continue
    }
    void res.body?.cancel().catch(() => {})
    return { status: res.status, hops, finalUrl: current }
  }
  return { status: null, hops }
}

/** Fetch the page, then status-check up to LINK_CHECK_CAP deduped hrefs. */
export async function checkPageLinks(
  html: string,
  pageUrl: string,
  fetcher: LinkFetcher = realLinkFetcher,
): Promise<{ checked: number; total: number; links: LinkResult[]; mixed: string[] }> {
  const hrefs = [...new Set(extractHrefs(html, pageUrl))]
  const mixed = pageUrl.startsWith('https://') ? hrefs.filter((u) => u.startsWith('http://')).slice(0, 10) : []
  const candidates = hrefs.slice(0, LINK_CHECK_CAP)

  const results: LinkResult[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const url = candidates[cursor++]!
      const r = await fetcher(url).catch(() => ({ status: null, hops: 0, finalUrl: undefined }))
      results.push({ url, status: r.status, hops: r.hops, finalUrl: r.finalUrl })
    }
  }
  await Promise.all(Array.from({ length: Math.min(LINK_CONCURRENCY, candidates.length) }, worker))

  const rank = (s: number | null): number => (s == null ? 999 : s >= 500 ? 0 : s)
  results.sort((a, b) => rank(a.status) - rank(b.status) || a.url.localeCompare(b.url))
  return { checked: results.length, total: hrefs.length, links: results, mixed }
}

export function judgeLinks(r: { checked: number; total: number; links: LinkResult[]; mixed: string[] }, pageUrl: string): Section {
  const checks: Check[] = []
  const broken = r.links.filter((l) => l.status == null || l.status >= 400)
  const deep = r.links.filter((l) => l.status != null && l.status < 400 && l.hops > 2)

  if (r.checked === 0) {
    checks.push({ id: 'links', label: 'Links', status: 'unknown', detail: 'No followable http(s) links found on the page.' })
  } else if (broken.length === 0) {
    checks.push({ id: 'links', label: 'Links', status: 'pass', detail: `${r.checked} of ${r.total} link${r.total === 1 ? '' : 's'} checked — none broken.` })
  } else {
    checks.push({
      id: 'links',
      label: 'Links',
      status: 'fail',
      detail: `${broken.length} of ${r.checked} checked links are dead${r.total > r.checked ? ` (checked the first ${LINK_CHECK_CAP} of ${r.total})` : ''}.`,
    })
    for (const l of broken.slice(0, 12)) {
      checks.push({
        id: `link-${l.url}`,
        label: l.status == null ? 'Unreachable' : `HTTP ${l.status}`,
        status: 'fail',
        detail: `${l.url}${l.finalUrl && l.finalUrl !== l.url && l.status != null ? ` (redirects to ${l.finalUrl})` : ''}`,
      })
    }
    if (broken.length > 12) {
      checks.push({ id: 'links-more', label: '…', status: 'fail', detail: `${broken.length - 12} more — see --json.` })
    }
  }

  if (deep.length > 0) {
    checks.push({ id: 'redirect-chains', label: 'Redirect chains', status: 'warn', detail: `${deep.length} link${deep.length === 1 ? '' : 's'} hop more than twice (e.g. ${deep[0]!.url} → ${deep[0]!.finalUrl ?? '?'}). Point them at the final URL.` })
  }
  if (r.mixed.length > 0) {
    checks.push({
      id: 'mixed-content',
      label: 'Mixed content',
      status: 'fail',
      detail: `${r.mixed.length} http:// link${r.mixed.length === 1 ? '' : 's'} on an https page — browsers block these resources and flag the page as not secure.`,
      fix: 'Serve every asset and href over https://.',
    })
  }

  return { id: 'links', title: 'Links (depth 1)', checks }
}
