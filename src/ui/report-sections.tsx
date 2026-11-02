/**
 * Shared report sections: the free public report and the founder insights
 * render the SAME stored blocks through THESE components, so the terminal's
 * two readers cannot drift from each other or from the web page. Every row
 * keeps the house tri-state contract — measured passes green, measured
 * fails red, and a check the sweep never ran renders "–", never a scored
 * fail. A block whose facts are all absent renders nothing at all.
 */
import { Box, Text } from 'ink'
import React from 'react'
import type { CruxFactorWire, PublicReportPayload } from '../api/public-scan.js'
import { blockedAgents, fmtClsValue, fmtMs, humanizeId, mobileEvidenceLines, tri, vitalsEntries, absShotUrl, pickFirstEditAuditId, type TriValue } from '../lib/report-format.js'
import { shortDate } from '../lib/format.js'
import { scoreColor, severityTone } from '../lib/score.js'
import { Score, Section } from './components.js'

type AeoWire = NonNullable<PublicReportPayload['aeo']>
type CroWire = NonNullable<PublicReportPayload['cro']>
type MobileWire = NonNullable<PublicReportPayload['mobile']>
type SiteWire = NonNullable<PublicReportPayload['site']>
type PsiWire = NonNullable<PublicReportPayload['psi']>
type CruxWire = NonNullable<PublicReportPayload['crux']>
type SeoCrawlWire = NonNullable<PublicReportPayload['seoCrawl']>
type DrWire = NonNullable<PublicReportPayload['dr']>
type OprWire = NonNullable<PublicReportPayload['opr']>
type ShotWire = NonNullable<PublicReportPayload['screenshot']>

/** Render-boundary coercion: server JSON is loosely typed. */
function safeText(v: unknown): string {
  if (v == null) return '—'
  return typeof v === 'string' ? v : String(v)
}

const MARK: Record<TriValue, { glyph: string; color?: string }> = {
  pass: { glyph: '✓', color: 'green' },
  fail: { glyph: '✗', color: 'red' },
  unknown: { glyph: '–' },
}

/** One label/mark row — the label column matches the Axes table's width. */
function TriRow({ label, v, note }: { label: string; v: TriValue; note?: string | null }) {
  return (
    <Text>
      {'  '}
      <Text dimColor>{label.padEnd(17)}</Text>
      <Text color={MARK[v].color} bold={v !== 'unknown'}>{MARK[v].glyph}</Text>
      {note ? <Text dimColor> {note}</Text> : null}
    </Text>
  )
}

/** One pass/fail check with its evidence detail (CRO + mobile share this). */
function CheckRow({ id, pass, detail }: { id?: string; pass?: boolean | null; detail?: string | null }) {
  const v = tri(pass)
  return (
    <Text>
      {'  '}
      <Text color={MARK[v].color} bold={v !== 'unknown'}>{MARK[v].glyph}</Text>
      {' '}{humanizeId(id)}
      {detail ? <Text dimColor> — {safeText(detail)}</Text> : null}
    </Text>
  )
}

const PLANES: Array<[string, string]> = [
  ['technical', 'Technical (25%)'],
  ['search', 'Search (25%)'],
  ['ai', 'AI (20%)'],
  ['conversion', 'Conversion (20%)'],
  ['trust', 'Trust (10%)'],
]

/** The five scorecard planes — only planes with a real number render, so an
 *  unmeasured axis is never a fabricated 0. */
export function ScorecardPlanes({ scorecards }: { scorecards: PublicReportPayload['scorecards'] }) {
  const sc = scorecards ?? null
  const rows = PLANES
    .map(([key, label]) => [label, (sc as any)?.[key]?.score] as const)
    .filter(([, score]) => typeof score === 'number') as Array<[string, number]>
  if (!rows.length) return null
  return (
    <Section title="Scorecard breakdown">
      {rows.map(([label, score]) => (
        <Score key={label} label={label} labelWidth={16} score={score} width={12} />
      ))}
    </Section>
  )
}

/** Core Web Vitals + the LCP element + the top opportunities — the lab
 *  numbers behind the Speed axis, only what Lighthouse actually measured. */
export function VitalsBlock({ psi }: { psi: PsiWire | null | undefined }) {
  const rows = vitalsEntries(psi?.metrics)
  const lcp = psi?.lcpElement ?? null
  const opportunities = Array.isArray(psi?.opportunities) ? psi.opportunities : []
  if (!rows.length && !lcp && !opportunities.length) return null
  return (
    <Section title="Speed detail">
      {rows.length ? (
        <Text>
          {'  '}
          <Text dimColor>{'Core Web Vitals'.padEnd(17)}</Text>
          {rows.map(([k, v], i) => (
            <Text key={k}>
              {i ? <Text dimColor> · </Text> : null}
              <Text bold>{k}</Text> {v}
            </Text>
          ))}
        </Text>
      ) : null}
      {lcp ? (
        <Text dimColor>
          {'  '}LCP element: {safeText(lcp.nodeLabel)} {lcp.selector ? `(${safeText(lcp.selector)})` : ''}
        </Text>
      ) : null}
      {opportunities.slice(0, 5).map((o, i) => (
        <Text key={o?.id || i}>
          {'  '}
          <Text color="yellow">•</Text> {safeText(o?.title)}
          {o?.displayValue ? <Text dimColor> — {safeText(o.displayValue)}</Text> : null}
          {o?.savingsMs != null ? <Text dimColor> · saves {fmtMs(o.savingsMs)}</Text> : null}
        </Text>
      ))}
    </Section>
  )
}

/** AI readiness — the facts behind the Search & AI axis: llms.txt, the
 *  per-agent robots matrix, structured data, FAQ. Blocking crawlers is
 *  reported, never moralized: it is the site owner's opt-out. */
export function AeoBlock({ aeo }: { aeo: AeoWire | null | undefined }) {
  const { blocked, total } = blockedAgents(aeo?.robots)
  const schemaTypes = Array.isArray(aeo?.schema?.types) ? aeo.schema!.types!.filter(Boolean).map(String) : []
  const hasAnything = !!aeo && (aeo.llmsTxt != null || aeo.robots != null || aeo.schema != null || aeo.faqFound != null)
  if (!hasAnything) return null
  return (
    <Section title="AI readiness">
      <TriRow
        label="llms.txt"
        v={tri(aeo?.llmsTxt)}
        note={aeo?.llmsTxt === false ? 'not found — one guides AI agents to your content' : null}
      />
      {aeo?.robots != null ? (
        blocked.length ? (
          <Text>
            {'  '}
            <Text dimColor>{'AI crawlers'.padEnd(17)}</Text>
            <Text color="red" bold>{blocked.length}</Text>
            <Text dimColor>{` of ${total} blocked — `}</Text>
            {blocked.slice(0, 6).join(', ')}
            {blocked.length > 6 ? <Text dimColor>{` … +${blocked.length - 6} more`}</Text> : null}
          </Text>
        ) : (
          <TriRow label="AI crawlers" v="pass" note={`none of the ${total} tracked agents is blocked`} />
        )
      ) : null}
      <TriRow
        label="Structured data"
        v={schemaTypes.length ? 'pass' : aeo?.schema?.present === false ? 'fail' : 'unknown'}
        note={schemaTypes.length ? schemaTypes.slice(0, 8).join(', ') : null}
      />
      <TriRow label="FAQ content" v={tri(aeo?.faqFound)} />
      <TriRow label="Open Graph" v={tri(aeo?.ogComplete)} />
      {aeo?.rendered === true ? <Text dimColor>{'  '}measured on the rendered DOM (the raw page was an app shell)</Text> : null}
    </Section>
  )
}

/** The conversion checks — the CRO score's named rows. */
export function CroBlock({ cro }: { cro: CroWire | null | undefined }) {
  const checks = Array.isArray(cro?.checks) ? cro.checks : []
  if (!checks.length && cro?.score == null) return null
  const title = cro?.score != null ? `Conversion checks (${Math.round(cro.score)}/100)` : 'Conversion checks'
  return (
    <Section title={title}>
      {checks.slice(0, 12).map((c, i) => (
        <CheckRow key={i} id={c?.id} pass={c?.pass} detail={c?.detail} />
      ))}
      {checks.length > 12 ? <Text dimColor>{'  '}… {checks.length - 12} more</Text> : null}
      {cro?.truncated === true ? <Text dimColor>{'  '}the raw page hit the document cap — some checks read unverified</Text> : null}
      {cro?.rendered === true ? <Text dimColor>{'  '}measured on the rendered DOM</Text> : null}
    </Section>
  )
}

/** The real-browser 390px layout test, with capped evidence for failures. */
export function MobileBlock({ mobile }: { mobile: MobileWire | null | undefined }) {
  const checks = Array.isArray(mobile?.checks) ? mobile.checks : []
  const evidence = mobileEvidenceLines(mobile?.evidence)
  if (!checks.length && mobile?.score == null && !evidence.length) return null
  const scored = mobile?.score != null && mobile?.assessed === true
  return (
    <Section title={scored ? `Mobile layout (${Math.round(mobile!.score!)}/100)` : 'Mobile layout'}>
      {checks.slice(0, 8).map((c, i) => (
        <CheckRow key={i} id={c?.id} pass={c?.pass} detail={c?.detail} />
      ))}
      {checks.length > 8 ? <Text dimColor>{'  '}… {checks.length - 8} more</Text> : null}
      {evidence.map((line, i) => (
        <Text key={i} dimColor>{'    '}{line}</Text>
      ))}
      {mobile?.rendered === true ? <Text dimColor>{'  '}measured on the rendered DOM</Text> : null}
    </Section>
  )
}

/** Trust detail rows — the named checks behind the hero's n/m count. A
 *  site block the sweep never read renders no dash column at all: "never
 *  checked" and "checked, unknown" are different facts. */
export function TrustRows({ site, linkPreview }: { site: SiteWire | null | undefined; linkPreview?: { image?: boolean | null } | null | undefined }) {
  const hasUnfurl = linkPreview?.image != null
  if (!site && !hasUnfurl) return null
  return (
    <Box flexDirection="column">
      {site ? (
        <>
          <TriRow label="HTTPS redirect" v={tri(site.httpsRedirect)} />
          {site.tlsValidTo ? (
            <Text>
              {'  '}
              <Text dimColor>{'TLS valid to'.padEnd(17)}</Text>
              {shortDate(site.tlsValidTo)}
            </Text>
          ) : null}
          <TriRow label="HSTS" v={tri(site.headers?.hsts)} />
          <TriRow label="CSP" v={tri(site.headers?.csp)} />
          <TriRow label="X-Frame-Options" v={tri(site.headers?.xFrameOptions)} />
          <TriRow
            label="Safe Browsing"
            v={site.safeBrowsing === 'clean' ? 'pass' : site.safeBrowsing === 'flagged' ? 'fail' : 'unknown'}
          />
          {site.og ? (
            <Text dimColor>
              {'  '}{'OG tags'.padEnd(17)}
              {[site.og.title, site.og.description, site.og.image].filter(Boolean).length}/3 present
            </Text>
          ) : null}
        </>
      ) : null}
      {hasUnfurl ? <TriRow label="Unfurl image" v={linkPreview!.image ? 'pass' : 'fail'} note="X/Slack card" /> : null}
    </Box>
  )
}

/** Authority rows — Ahrefs DR (integer convention, delta only from a real
 *  previous value) and the OpenPageRank line. */
export function AuthorityRows({ dr, opr }: { dr: DrWire | null | undefined; opr: OprWire | null | undefined }) {
  const oprBits: string[] = []
  if (opr?.score != null) oprBits.push(Number(opr.score).toFixed(1))
  if (opr?.rank != null) oprBits.push(`global rank #${Number(opr.rank).toLocaleString('en-US')}`)
  if (opr?.referringDomains != null) oprBits.push(`${Number(opr.referringDomains).toLocaleString('en-US')} referring domains`)
  return (
    <Box flexDirection="column">
      <Text>
        {'  '}
        <Text dimColor>{'Authority'.padEnd(17)}</Text>
        {dr?.value != null ? (
          <Text bold color={scoreColor(Math.round(dr.value))}>
            {Math.round(dr.value)}
            {dr.prevValue != null && Math.round(dr.value) !== Math.round(dr.prevValue) ? (
              <Text color={dr.value >= dr.prevValue ? 'green' : '#f59e0b'} bold={false}>
                {` ${dr.value >= dr.prevValue ? '▲' : '▼'} ${Math.abs(Math.round(dr.value) - Math.round(dr.prevValue))}`}
              </Text>
            ) : null}
          </Text>
        ) : (
          <Text dimColor>Not checked</Text>
        )}
      </Text>
      {oprBits.length ? (
        <Text>
          {'  '}
          <Text dimColor>{'Open PageRank'.padEnd(17)}</Text>
          {oprBits.join(' · ')}
        </Text>
      ) : null}
    </Box>
  )
}

/** One CrUX side's factors — moved here so both surfaces quote field data
 *  identically. */
function cruxFactors(f: CruxFactorWire | null | undefined): string | null {
  if (!f) return null
  const bits: string[] = []
  if (f.lcpP75Ms != null) bits.push(`LCP ${(f.lcpP75Ms / 1000).toFixed(1)}s`)
  if (f.inpP75Ms != null) bits.push(`INP ${Math.round(f.inpP75Ms)}ms`)
  if (f.cls100 != null) bits.push(`CLS ${fmtClsValue(f.cls100)}`)
  return bits.join(' · ') || null
}

export function CruxRows({ crux }: { crux: CruxWire | null | undefined }) {
  if (!crux?.assessed) return null
  const rows: Array<[string, string]> = []
  const phone = cruxFactors(crux.phone)
  const desktop = cruxFactors(crux.desktop)
  if (phone) rows.push(['CrUX phone', phone])
  if (desktop) rows.push(['CrUX desktop', desktop])
  if (!rows.length) {
    return <Text dimColor>{'  '}{"CrUX".padEnd(17)}checked — no per-device factors to report yet</Text>
  }
  return (
    <Box flexDirection="column">
      {rows.map(([label, text]) => (
        <Text key={label}>
          {'  '}
          <Text dimColor>{label.padEnd(17)}</Text>
          {text}
        </Text>
      ))}
    </Box>
  )
}

/** The SEO crawl result — pages fetched and the dead-link audit. */
export function SeoCrawlBlock({ seoCrawl }: { seoCrawl: SeoCrawlWire | null | undefined }) {
  const crawled = seoCrawl?.crawled
  const broken = seoCrawl?.brokenLinks
  if (crawled == null && broken?.checked == null) return null
  return (
    <Section title={typeof seoCrawl?.score === 'number' ? `SEO crawl (${Math.round(seoCrawl.score)}/100)` : 'SEO crawl'}>
      <Text>
        {'  '}
        {crawled != null ? (
          <>
            <Text dimColor>pages fetched </Text><Text>{crawled}</Text>{'  '}
          </>
        ) : null}
        {broken?.checked != null ? (
          <>
            <Text dimColor>dead links </Text>
            {broken.broken?.length ? <Text color="red">{broken.broken.length}</Text> : <Text color="green">0</Text>}
            <Text dimColor>{` of ${broken.checked} checked`}</Text>
          </>
        ) : null}
      </Text>
    </Section>
  )
}

/** The 30-day-ephemeral captures — printed as absolute links. */
export function ScreenshotLines({ shot, mobileShot }: { shot?: ShotWire | null; mobileShot?: ShotWire | null }) {
  const absShot = absShotUrl(shot?.url)
  const absMobile = absShotUrl(mobileShot?.url)
  if (!absShot && !absMobile) return null
  return (
    <Box flexDirection="column">
      {absShot ? <Text dimColor>{'  '}desktop screenshot: {absShot}</Text> : null}
      {absMobile ? <Text dimColor>{'  '}phone screenshot: {absMobile}</Text> : null}
    </Box>
  )
}

/** Per-provider tri-state — every check that did NOT succeed names itself
 *  (failed / unavailable / not_run + the reason). All-green sweeps render
 *  nothing: silence here means every check ran clean. */
export function CheckStatusBlock({ providerHealth }: { providerHealth: PublicReportPayload['providerHealth'] }) {
  const problems = Object.entries(providerHealth ?? {}).filter(
    ([, h]) => !!h && h.status !== 'success',
  )
  if (!problems.length) return null
  return (
    <Section title="Check status">
      {problems.map(([name, h]) => (
        <Text key={name}>
          {'  '}
          <Text color={h!.status === 'failed' ? 'red' : 'yellow'}>{h!.status}</Text>
          <Text dimColor>
            {' '}{name}
            {h!.errorCode ? ` · ${h!.errorCode}` : ''}
            {h!.errorMessage ? ` — ${String(h!.errorMessage).slice(0, 90)}` : ''}
          </Text>
        </Text>
      ))}
    </Section>
  )
}

/** The cached AI First Edit card (public scope) — the card generated FOR
 *  the current First Edit pick. The payload doesn't name the pick, so the
 *  block re-derives it from the same rule the server uses; any other card
 *  must not wear the "First edit" label. */
export function AiFixCardBlock({ aiFixes, issues, aiFixPreparing }: { aiFixes: PublicReportPayload['aiFixes']; issues: PublicReportPayload['issues']; aiFixPreparing?: boolean }) {
  const list = Array.isArray(aiFixes) ? aiFixes : []
  const firstEditId = pickFirstEditAuditId(issues as Array<{ id?: string; category?: string; savingsMs?: number | null }>)
  const entry = firstEditId
    ? list.find((f) => f?.auditId === firstEditId && (f?.card?.what || f?.card?.why))
    : null
  if (!entry) {
    if (!aiFixPreparing) return null
    return <Text dimColor>{'  '}first edit: being generated — read the report again in a moment</Text>
  }
  const steps = Array.isArray(entry.card?.steps)
    ? entry.card!.steps!
    : typeof entry.card?.steps === 'string' && entry.card.steps.trim()
      ? [entry.card.steps]
      : []
  return (
    <Section title={entry.issueTitle ? `First edit — ${entry.issueTitle}` : 'First edit'}>
      <Text>{'  '}{safeText(entry.card!.what)}</Text>
      {entry.card!.why ? <Text dimColor>{'  '}{safeText(entry.card!.why)}</Text> : null}
      {steps.slice(0, 4).map((s, i) => (
        <Text key={i}>{'  '}{i + 1}. {safeText(s)}</Text>
      ))}
    </Section>
  )
}

/** The AI bottleneck card — `card` is the card object itself (the founder
 *  tool sends it bare; the public doc wraps it in {card}). */
export function BottleneckCardBlock({ card }: { card: { what?: string; why?: string; bottleneck?: string; impact?: string; steps?: string[] | string } | null | undefined }) {
  const what = card?.what || card?.bottleneck
  if (!what) return null
  const steps = Array.isArray(card!.steps)
    ? card!.steps!
    : typeof card!.steps === 'string' && card!.steps.trim()
      ? [card!.steps]
      : []
  return (
    <Section title="Bottleneck">
      <Text>{'  '}{safeText(what)}</Text>
      {card!.why ? <Text dimColor>{'  '}{safeText(card!.why)}</Text> : null}
      {card!.impact ? <Text dimColor>{'  '}{safeText(card!.impact)}</Text> : null}
      {steps.slice(0, 4).map((s, i) => (
        <Text key={i}>{'  '}{i + 1}. {safeText(s)}</Text>
      ))}
    </Section>
  )
}

/** A finding's evidence line: the checked URL, else the message/detail the provider attached. */
function findingDetail(f: NonNullable<PublicReportPayload['findings']>[number]): string | null {
  const ev = f.evidence ?? null
  const fromEvidence = typeof ev?.message === 'string' ? ev.message : typeof ev?.detail === 'string' ? ev.detail : null
  return f.url ?? fromEvidence
}

function capFirst(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}

/** Cross-provider open findings — the page's status-chipped rows, capped
 *  at the same 8 the page shows. The detail line is only ever a URL or
 *  provider evidence, never filler copy. */
export function FindingsBlock({ findings }: { findings: PublicReportPayload['findings'] }) {
  const list = Array.isArray(findings) ? findings : []
  if (!list.length) return null
  return (
    <Section title={`Open findings (${list.length})`}>
      {list.slice(0, 8).map((f, i) => {
        const detail = findingDetail(f)
        return (
          <Box key={f.fingerprint || `f${i}`} flexDirection="column">
            <Text>
              {'  '}
              <Text color={f.status === 'regressed' ? 'red' : severityTone(f.severity)}>{`[${f.status || 'open'}]`}</Text>
              {` ${capFirst(String(f.provider || ''))} · ${String(f.checkId || '').replaceAll('_', ' ')}`}
              {f.severity ? <Text dimColor> — {f.severity} severity</Text> : null}
            </Text>
            {detail ? <Text dimColor>{'  '}{detail}</Text> : null}
          </Box>
        )
      })}
      {list.length > 8 ? <Text dimColor>{'  '}… {list.length - 8} more</Text> : null}
    </Section>
  )
}
