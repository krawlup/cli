/**
 * `krawlup og <url>` — the social-card lint: what X, Slack, WhatsApp and
 * iMessage will show when the link is pasted. Pure over the extracted
 * <meta> facts, so the standalone command and `check` share one verdict.
 */
import type { Check, Section } from './verdict.js'
import type { MetaTag } from './html.js'

export interface OgFacts {
  ogTitle: string | null
  ogDescription: string | null
  ogImage: string | null
  ogUrl: string | null
  ogType: string | null
  ogSiteName: string | null
  twitterCard: string | null
  title: string | null
  description: string | null
}

export function collectOgFacts(meta: MetaTag[], title: string | null, description: string | null, pageUrl: string): OgFacts {
  const byProperty = (key: string): string | null => {
    const hit = meta.find((m) => (m.property ?? m.name ?? '').toLowerCase() === key && m.content?.trim())
    return hit?.content?.trim() ?? null
  }
  const resolve = (raw: string | null): string | null => {
    if (!raw) return null
    try {
      return new URL(raw, pageUrl).toString()
    } catch {
      return raw
    }
  }
  return {
    ogTitle: byProperty('og:title'),
    ogDescription: byProperty('og:description'),
    ogImage: resolve(byProperty('og:image')),
    ogUrl: byProperty('og:url'),
    ogType: byProperty('og:type'),
    ogSiteName: byProperty('og:site_name'),
    twitterCard: byProperty('twitter:card'),
    title,
    description,
  }
}

export function judgeOg(f: OgFacts, pageUrl: string): Section {
  const checks: Check[] = []

  // og:image — the single highest-impact tag: without it X/Slack show a bare link.
  if (!f.ogImage) {
    checks.push({
      id: 'og-image',
      label: 'Image',
      status: 'fail',
      detail: 'No og:image — shares render as a bare text link with no card.',
      fix: '<meta property="og:image" content="https://…/card.png"> (1200×630 works everywhere)',
    })
  } else if (/^http:\/\//i.test(f.ogImage) && pageUrl.startsWith('https://')) {
    checks.push({ id: 'og-image', label: 'Image', status: 'warn', detail: `og:image is http:// on an https page — X and iMessage block or warn on insecure images. Use: ${f.ogImage}` })
  } else {
    checks.push({ id: 'og-image', label: 'Image', status: 'pass', detail: f.ogImage })
  }

  // og:title
  if (!f.ogTitle) {
    checks.push({
      id: 'og-title',
      label: 'Title',
      status: 'fail',
      detail: f.title ? `No og:title — platforms fall back to the <title> ("${f.title.slice(0, 60)}"), which is often a SEO-length string, not a share line.` : 'No og:title and no <title> — shares show the bare URL.',
      fix: '<meta property="og:title" content="…">',
    })
  } else {
    const long = f.ogTitle.length > 70
    checks.push({ id: 'og-title', label: 'Title', status: long ? 'warn' : 'pass', detail: `"${f.ogTitle}"${long ? ` — ${f.ogTitle.length} chars; X truncates around 70.` : ''}` })
  }

  // og:description
  if (!f.ogDescription) {
    checks.push({
      id: 'og-description',
      label: 'Description',
      status: 'warn',
      detail: f.description ? `No og:description — platforms fall back to the meta description ("${f.description.slice(0, 60)}…").` : 'No og:description and no meta description — the card shows no body text.',
      fix: '<meta property="og:description" content="…"> (50–160 chars)',
    })
  } else if (f.ogDescription.length > 200) {
    checks.push({ id: 'og-description', label: 'Description', status: 'warn', detail: `${f.ogDescription.length} chars — X clips around 200; front-load the point.` })
  } else {
    checks.push({ id: 'og-description', label: 'Description', status: 'pass', detail: `"${f.ogDescription}"` })
  }

  // twitter:card
  if (!f.twitterCard) {
    checks.push({
      id: 'twitter-card',
      label: 'X card',
      status: 'warn',
      detail: 'No twitter:card — X guesses the layout (usually a small square).',
      fix: '<meta name="twitter:card" content="summary_large_image">',
    })
  } else {
    checks.push({ id: 'twitter-card', label: 'X card', status: 'pass', detail: f.twitterCard })
  }

  // og:url host consistency
  if (f.ogUrl) {
    try {
      const ogHost = new URL(f.ogUrl, pageUrl).host
      const pageHost = new URL(pageUrl).host
      if (ogHost !== pageHost) {
        checks.push({ id: 'og-url', label: 'Canonical host', status: 'warn', detail: `og:url points at ${ogHost} but the page lives on ${pageHost} — some platforms attribute the share (and its likes) to the og:url host.` })
      }
    } catch {
      /* unparseable og:url — leave alone */
    }
  }

  const line = (label: string, value: string | null, fallback: string | null): string =>
    `${label}: ${value ?? fallback ?? '(nothing)'}`
  return {
    id: 'og',
    title: 'Social card (Open Graph)',
    checks,
    note: [
      'When pasted into X/Slack, the card will read:',
      `  ${line('title', f.ogTitle, f.title)}`,
      `  ${line('desc', f.ogDescription, f.description)}`,
      `  ${line('image', f.ogImage, null)}`,
    ].join('\n'),
  }
}
