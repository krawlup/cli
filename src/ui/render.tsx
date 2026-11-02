/**
 * ActionView: renders an ActionResult into Ink blocks. Pure — data in,
 * elements out, no fetching. Both the TUI history and the argv one-shot
 * mode use this, so a command looks identical in either mode.
 */
import { Box, Text } from 'ink'
import React from 'react'
import type { ActionResult } from '../actions.js'
import type {
  AnalyticsSnippetPayload,
  FixCardEntry,
  KeywordIdeasPayload,
  KeywordRanksPayload,
  ProductStatus,
  ScanHistoryEntry,
  SubscriptionSummary,
  WebsiteAnalyticsPayload,
} from '../api/types.js'
import { deltaTone, fmtCents, fmtDelta, fmtNum, fmtPct, shortDate, timeAgo } from '../lib/format.js'
import { fmtDurationSec } from '../lib/report-format.js'
import { scoreColor } from '../lib/score.js'
import { BarList, IssueLine, KV, Score, Section, Spark, Table, type TableColumn } from './components.js'
import { PublicReportBlock } from './public-report.js'
import {
  AeoBlock,
  AuthorityRows,
  BottleneckCardBlock,
  CheckStatusBlock,
  CroBlock,
  CruxRows,
  FindingsBlock,
  MobileBlock,
  ScorecardPlanes,
  SeoCrawlBlock,
  ScreenshotLines,
  TrustRows,
  VitalsBlock,
} from './report-sections.js'

function Delta({ value }: { value: number | null | undefined }) {
  const tone = deltaTone(value)
  return (
    <Text color={tone === 'good' ? 'green' : tone === 'bad' ? 'red' : 'gray'}>{fmtDelta(value)}</Text>
  )
}

/** Render-boundary coercion: server JSON is loosely typed, and a non-string
 *  leaf (object/number) would throw "not a valid React child". */
function safeText(v: unknown): string {
  if (v == null) return '—'
  return typeof v === 'string' ? v : String(v)
}

/** Block heading — rides the same 2-space gutter as the rows under it. */
function Title({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <Text bold>
      {'  '}
      {children}
      {note ? <Text dimColor> {note}</Text> : null}
    </Text>
  )
}

function OverallScore({ insights }: { insights: any }) {
  const score: number | null = insights?.scorecards?.overall?.score ?? insights?.performance ?? insights?.aeoScore ?? null
  const basis = insights?.scorecards?.overall?.basis
  return (
    <Box>
      <Score label="overall" score={score} width={14} />
      {basis ? <Text dimColor> ({basis})</Text> : null}
    </Box>
  )
}

function OverviewBlock({ overview }: { overview: NonNullable<ActionResult & { kind: 'overview' }>['overview'] }) {
  const products = overview.products ?? []
  const revenueGated = overview.gated?.conversion
  const analyticsGated = overview.gated?.websiteAnalytics
  const columns: TableColumn[] = [
    { header: 'product', width: 30, get: (p) => p.title || p.key },
    { header: 'vis', width: 14, align: 'right', get: (p) => (p.visitors == null ? '—' : fmtNum(p.visitors)) },
    { header: 'views', width: 14, align: 'right', get: (p) => (p.views == null ? '—' : fmtNum(p.views)) },
    {
      header: 'rev',
      width: 12,
      align: 'right',
      get: (p) => (p.revenue?.netCents == null ? '—' : fmtCents(p.revenue.netCents)),
    },
    { header: 'conv', width: 8, align: 'right', get: (p) => (p.revenue?.conversions == null ? '—' : fmtNum(p.revenue.conversions)) },
    { header: 'score', width: 6, align: 'right', get: (p) => (p.score == null ? '—' : String(p.score)), color: (p) => scoreColor(p.score) },
    { header: 'aeo', width: 6, align: 'right', get: (p) => (p.aeoScore == null ? '—' : String(p.aeoScore)), color: (p) => scoreColor(p.aeoScore) },
    { header: 'listed', width: 7, get: (p) => (p.public === false ? 'private' : 'public') },
  ]
  return (
    <Box flexDirection="column">
      <Title note={overview.range ? `· ${overview.range}` : undefined}>Portfolio</Title>
      <Table columns={columns} rows={products} />
      {(revenueGated || analyticsGated) && (
        <Text dimColor>{'  '}gated on this plan: {[
          analyticsGated ? 'website analytics' : null,
          revenueGated ? 'conversion revenue' : null,
        ].filter(Boolean).join(', ')}</Text>
      )}
      {overview.note ? <Text dimColor>{'  '}{overview.note}</Text> : null}
    </Box>
  )
}

function ProductsBlock({ statuses }: { statuses: ProductStatus[] }) {
  return (
    <Box flexDirection="column">
      <Title>Products</Title>
      <Table
        columns={[
          { header: 'product', width: 34, get: (p) => p.title || p.productKey },
          { header: 'key', width: 28, get: (p) => p.productKey },
          { header: 'added', width: 12, get: (p) => timeAgo(p.addedAt) },
          { header: 'state', width: 8, get: (p) => (p.public === false ? 'private' : 'public') },
        ]}
        rows={statuses}
      />
    </Box>
  )
}

function SubscriptionBlock({ subscription: s }: { subscription: SubscriptionSummary }) {
  const usage = s.usage ?? {}
  const usageEntries = Object.entries(usage).slice(0, 12)
  return (
    <Box flexDirection="column">
      <Title>Subscription</Title>
      <KV
        entries={[
          ['plan', <Text key="p" bold>{s.plan?.name ?? '—'}</Text>],
          ['status', <Text key="s" color={s.status === 'active' ? 'green' : s.status === 'trialing' ? 'cyan' : 'yellow'}>{s.status ?? '—'}</Text>],
          ['price', <Text key="pr">{s.plan?.price != null ? fmtCents(Math.round(s.plan.price * 100), s.plan.currency || 'USD') : '—'}{s.plan?.duration ? <Text dimColor> / {s.plan.duration}</Text> : null}</Text>],
        ]}
      />
      {usageEntries.length ? (
        <Section title="Usage">
          {usageEntries.map(([k, v]) => (
            <Text key={k}>
              {'  '}
              <Text dimColor>{k.padEnd(28)}</Text>
              {typeof v === 'object' ? JSON.stringify(v) : String(v)}
            </Text>
          ))}
        </Section>
      ) : null}
    </Box>
  )
}

function InsightsBlock({ productKey, insights, fixCards, fixCardsNote }: { productKey: string; insights: any; fixCards?: FixCardEntry[]; fixCardsNote?: string }) {
  const issues = Array.isArray(insights?.issues) ? insights.issues : []
  const findings = Array.isArray(insights?.findings) ? insights.findings : []
  return (
    <Box flexDirection="column">
      <Title note={`· ${productKey}`}>Insights</Title>
      {insights?.scanPending ? <Text color="cyan">{'  '}⏳ a scan is running — /open {productKey} to watch, re-run this when it lands</Text> : null}
      <OverallScore insights={insights} />
      {insights?.updatedAt ? <Text dimColor>{'  '}updated {timeAgo(insights.updatedAt)}</Text> : null}

      {/* The five planes live at scorecards.technical/search/ai/conversion/trust —
          the old `scorecards.cards` read never matched the server shape. */}
      <ScorecardPlanes scorecards={insights?.scorecards ?? null} />

      {issues.length ? (
        <Section title={`Issues (${issues.length})`}>
          {issues.slice(0, 12).map((iss: any, i: number) => (
            <IssueLine key={i} issue={iss} />
          ))}
          {issues.length > 12 ? <Text dimColor>{'  '}… {issues.length - 12} more</Text> : null}
        </Section>
      ) : null}

      {insights?.firstEdit ? (
        <Section title="First Edit">
          <Text>{'  '}{safeText(insights.firstEdit.title || insights.firstEdit.message || insights.firstEdit.id || '—')}</Text>
          {insights.firstEdit.displayValue ? <Text dimColor>{'  '}{safeText(insights.firstEdit.displayValue)}</Text> : null}
        </Section>
      ) : null}

      {insights?.bottleneck ? <BottleneckCardBlock card={insights.bottleneck} /> : null}

      {fixCards?.length ? (
        <Section title={`Fix cards (${fixCards.length})`}>
          {fixCards.slice(0, 5).map((f, i) => (
            <Box key={i} flexDirection="column">
              <Text>
                {'  '}
                <Text bold>{f.issueTitle || f.auditId}</Text>
                {f.stillCurrent === false ? <Text dimColor> (stale measurement)</Text> : null}
              </Text>
              {f.card?.what ? <Text dimColor>{'  '}{f.card.what}</Text> : null}
            </Box>
          ))}
        </Section>
      ) : fixCardsNote ? (
        <Text dimColor>{'  '}{fixCardsNote}</Text>
      ) : null}

      {/* The stored blocks — identical renderers to the free public report. */}
      <VitalsBlock psi={{ metrics: insights?.metrics ?? null, lcpElement: insights?.lcpElement ?? null, opportunities: insights?.opportunities ?? [] }} />
      {insights?.site ? (
        <Section title="Trust & security">
          <TrustRows site={insights.site} linkPreview={insights?.linkPreview ?? null} />
        </Section>
      ) : null}
      <AeoBlock aeo={insights?.aeo ?? null} />
      <CroBlock cro={insights?.cro ?? null} />
      <MobileBlock mobile={insights?.mobile ?? null} />
      <CruxRows crux={insights?.crux ?? null} />
      {insights?.dr || insights?.opr ? (
        <Section title="Authority">
          <AuthorityRows dr={insights?.dr ?? null} opr={insights?.opr ?? null} />
        </Section>
      ) : null}
      <SeoCrawlBlock seoCrawl={insights?.seoCrawl ?? null} />
      <FindingsBlock findings={findings} />
      <CheckStatusBlock providerHealth={insights?.providerHealth ?? null} />
      <ScreenshotLines shot={insights?.screenshot ?? null} mobileShot={insights?.mobileScreenshot ?? null} />
    </Box>
  )
}

function AnalyticsBlock({ productKey, analytics: a }: { productKey: string; analytics: WebsiteAnalyticsPayload }) {
  const t = a.totals ?? {}
  const daily = a.daily ?? []
  const series = daily.map((d) => d.views ?? null)
  const entries: Array<[string, React.ReactNode]> = [
    ['views', <Text key="v">{fmtNum(t.views)} <Delta value={t.deltas?.views} /></Text>],
    ['visitors', <Text key="vi">{fmtNum(t.visitors)} <Delta value={t.deltas?.visitors} /></Text>],
    ['sessions', <Text key="s">{fmtNum(t.sessions)}</Text>],
    ['bounce', <Text key="b">{fmtPct(t.bouncePct)}</Text>],
    ['duration', <Text key="du">{fmtDurationSec(t.avgDurationSec)}</Text>],
    ['pages/session', <Text key="pp">{t.pagesPerSession != null ? Number(t.pagesPerSession).toFixed(1) : '—'}</Text>],
  ]
  if (t.conversions != null) {
    entries.push(['conversions', <Text key="c">{fmtNum(t.conversions)} <Delta value={t.deltas?.conversions} /></Text>])
  }
  if (t.revenueCents != null) {
    entries.push(['revenue', <Text key="r">{fmtCents(t.revenueCents)} <Delta value={t.deltas?.revenueCents ?? t.deltas?.revenue} /></Text>])
  }
  return (
    <Box flexDirection="column">
      <Title note={`· ${productKey} · ${a.range ?? '7d'}`}>Analytics</Title>
      {a.realtime?.visitorsNow != null ? (
        <Text>
          {'  '}
          <Text color="green" bold>{a.realtime.visitorsNow}</Text>
          <Text dimColor> on site now ({a.realtime.windowMinutes ?? 5}m window)</Text>
        </Text>
      ) : null}
      <KV entries={entries} />
      {series.some((v) => v != null) ? (
        <Section title="Daily views">
          <Spark values={series} pad="  " />
          <Text dimColor>{'  '}{daily.length ? `${daily[0]?.day} → ${daily[daily.length - 1]?.day}` : ''}</Text>
        </Section>
      ) : null}
      <Section title="Top pages">
        <BarList entries={(a.topPages ?? []).map((p) => ({ label: String(p.path ?? p.page ?? '?'), value: p.count ?? null }))} />
      </Section>
      <Section title="Referrers">
        <BarList entries={(a.topReferrers ?? []).map((r) => ({ label: String(r.referrer ?? '?'), value: r.count ?? null }))} />
      </Section>
      <Section title="Countries">
        <BarList entries={(a.countries ?? []).map((c) => ({ label: String(c.country ?? '?'), value: c.count ?? null }))} />
      </Section>
      <Section title="Devices">
        <BarList entries={(a.devices ?? []).map((d) => ({ label: String(d.device ?? '?'), value: d.count ?? null }))} />
      </Section>
      {(a.entryPages ?? []).length ? (
        <Section title="Entry pages">
          <BarList entries={a.entryPages!.map((p) => ({ label: String(p.path ?? '?'), value: p.n ?? null }))} />
        </Section>
      ) : null}
      {(a.exitPages ?? []).length ? (
        <Section title="Exit pages">
          <BarList entries={a.exitPages!.map((p) => ({ label: String(p.path ?? '?'), value: p.n ?? null }))} />
        </Section>
      ) : null}
      {(a.channels ?? []).length ? (
        <Section title="Channels">
          <BarList entries={a.channels!.map((c) => ({ label: String(c.channel ?? '?'), value: c.n ?? null }))} />
        </Section>
      ) : null}
      {(a.utm ?? []).length ? (
        <Section title="Sources (UTM)">
          {a.utm!.slice(0, 6).map((u, i) => (
            <Text key={i}>
              {'  '}
              <Text dimColor>{String(u.source ?? '?').padEnd(18)}</Text>
              {fmtNum(u.n)}
              {u.medium ? <Text dimColor> / {String(u.medium)}</Text> : null}
              {u.campaign ? <Text dimColor> · {String(u.campaign)}</Text> : null}
            </Text>
          ))}
        </Section>
      ) : null}
      {(a.goals ?? []).length ? (
        <Section title="Goals">
          {a.goals!.slice(0, 6).map((g, i) => (
            <Text key={i}>
              {'  '}
              <Text dimColor>{String(g.name ?? '?').padEnd(18)}</Text>
              {fmtNum(g.n)}
              {g.uniqueVisitors != null ? <Text dimColor> · {fmtNum(g.uniqueVisitors)} visitors</Text> : null}
              {g.conversionRate != null ? <Text dimColor> · {Number(g.conversionRate).toFixed(1)}%</Text> : null}
              {g.revenueCents ? <Text dimColor> · {fmtCents(g.revenueCents)}</Text> : null}
            </Text>
          ))}
        </Section>
      ) : null}
      {a.crawls ? (
        <Section title="AI crawls">
          <Text>{'  '}answers: {fmtNum(a.crawls.aiAnswers?.length ?? 0)} · indexing: {fmtNum(a.crawls.indexing?.length ?? 0)} · training: {fmtNum(a.crawls.training?.length ?? 0)}</Text>
          {a.crawls.partialNote ? <Text dimColor>{'  '}{a.crawls.partialNote}</Text> : null}
        </Section>
      ) : null}
      {a.aiInsight ? (
        <Section title="AI insight">
          <Text>{'  '}{a.aiInsight}</Text>
        </Section>
      ) : null}
    </Box>
  )
}

function KeywordsBlock({ ranks, ideas }: { ranks: KeywordRanksPayload; ideas?: KeywordIdeasPayload }) {
  return (
    <Box flexDirection="column">
      <Title>Keywords</Title>
      {ranks.searchConfigured === false ? (
        <Text dimColor>{'  '}no SERP source configured for rank checks — the board stays empty until one is set up server-side</Text>
      ) : null}
      {ranks.tracked?.length ? (
        <Box flexDirection="column">
          {ranks.tracked.slice(0, 12).map((k) => (
            <Text key={k.keyword}>
              {'  '}{(k.keyword || '').slice(0, 34).padEnd(34)}
              <Text bold color={k.latest != null && k.latest <= 3 ? 'green' : undefined}> {k.latest == null ? '  —' : String(k.latest).padStart(2)}</Text>
              <Text dimColor> best {k.best == null ? '—' : k.best}</Text>
              {' '}
              <Spark values={k.series ?? []} width={16} />
            </Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>{'  '}no tracked keywords yet — add some from the ideas below or the dashboard</Text>
      )}
      {ideas?.clusters?.length ? (
        <Section title={`Ideas (${ideas.provider ?? 'autocomplete'})`}>
          {ideas.clusters.slice(0, 6).map((cl, i) => (
            <Box key={i} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Text>
                {'  '}
                <Text bold>{cl.name || cl.intent || 'cluster'}</Text>
              </Text>
              {(cl.keywords ?? []).slice(0, 4).map((k, j) => (
                <Text key={j}>
                  {'    '}
                  {String(k.keyword ?? '?').padEnd(34)}
                  <Text dimColor>vol {fmtNum(k.volume)} · diff {k.difficulty ?? '—'}</Text>
                  {k.verdict ? <Text color="magenta"> [{k.verdict}]</Text> : null}
                </Text>
              ))}
            </Box>
          ))}
        </Section>
      ) : null}
      {ideas?.actions?.length ? (
        <Section title="Actions">
          {ideas.actions.slice(0, 5).map((a, i) => (
            <Text key={i}>{'  '}• {a}</Text>
          ))}
        </Section>
      ) : null}
    </Box>
  )
}

function HistoryBlock({ entries }: { entries: ScanHistoryEntry[] }) {
  const scores = entries.map((e) => e.snapshot?.scorecards?.overall?.score ?? e.snapshot?.psi?.performance ?? e.snapshot?.aeo?.score ?? null)
  return (
    <Box flexDirection="column">
      <Title note={`· ${entries.length} scans`}>Scan history</Title>
      {scores.some((s) => s != null) ? (
        <Box marginBottom={1}>
          <Spark values={scores} pad="  " />
        </Box>
      ) : null}
      <Table
        columns={[
          { header: 'when', width: 12, get: (e) => shortDate(e.at) },
          { header: 'source', width: 12, get: (e) => e.source || '—' },
          { header: 'overall', width: 8, align: 'right', get: (e) => String(e.snapshot?.scorecards?.overall?.score ?? e.snapshot?.psi?.performance ?? '—'), color: (e) => scoreColor(e.snapshot?.scorecards?.overall?.score ?? e.snapshot?.psi?.performance) },
          { header: 'aeo', width: 5, align: 'right', get: (e) => (e.snapshot?.aeo?.score == null ? '—' : String(e.snapshot.aeo.score)) },
        ]}
        rows={entries.slice(-10).reverse()}
      />
    </Box>
  )
}

function SnippetBlock({ productKey, snippet: s }: { productKey: string; snippet: AnalyticsSnippetPayload }) {
  return (
    <Box flexDirection="column">
      <Title note={`· ${productKey}`}>Analytics tag</Title>
      {s.instructions ? <Text>{'  '}{safeText(s.instructions)}</Text> : null}
      {typeof s.snippet === 'string' ? (
        <Box marginX={2} marginTop={1} flexDirection="column">
          {s.snippet.split('\n').map((line, i) => (
            <Text key={i} color="cyan">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {s.verify ? <Text dimColor>{'  '}verify: {s.verify}</Text> : null}
      {s.tip ? <Text dimColor>{'  '}{s.tip}</Text> : null}
      {s.excludedPaths?.length ? <Text dimColor>{'  '}excluded paths: {s.excludedPaths.join(', ')}</Text> : null}
    </Box>
  )
}

function AddedBlock({ result }: { result: any }) {
  return (
    <Box flexDirection="column">
      <Title>Product added</Title>
      <KV
        entries={[
          ['key', <Text key="k">{result?.productKey ?? '—'}</Text>],
          ['slug', <Text key="s">{result?.slug ?? '—'}</Text>],
          ...(result?.dashboardUrl ? ([['dashboard', <Text key="d">{result.dashboardUrl}</Text>]] as Array<[string, React.ReactNode]>) : []),
        ]}
      />
      {Array.isArray(result?.nextSteps) && result.nextSteps.length ? (
        <Section title="Next steps">
          {result.nextSteps.slice(0, 5).map((n: any, i: number) => (
            <Text key={i}>{'  '}• {typeof n === 'string' ? n : JSON.stringify(n)}</Text>
          ))}
        </Section>
      ) : null}
    </Box>
  )
}

export function ActionView({ result }: { result: ActionResult }) {
  switch (result.kind) {
    case 'overview':
      return <OverviewBlock overview={result.overview} />
    case 'products':
      return <ProductsBlock statuses={result.statuses} />
    case 'subscription':
      return <SubscriptionBlock subscription={result.subscription} />
    case 'insights':
      return <InsightsBlock productKey={result.productKey} insights={result.insights} fixCards={result.fixCards} fixCardsNote={result.fixCardsNote} />
    case 'analytics':
      return <AnalyticsBlock productKey={result.productKey} analytics={result.analytics} />
    case 'keywords':
      return <KeywordsBlock ranks={result.ranks} ideas={result.ideas} />
    case 'history':
      return <HistoryBlock entries={result.entries} />
    case 'snippet':
      return <SnippetBlock productKey={result.productKey} snippet={result.snippet} />
    case 'added':
      return <AddedBlock result={result.result} />
    case 'visibility':
      return (
        <Text>
          {'  '}
          <Text color="green">✓</Text> {result.productKey} is now {result.nowPublic ? 'public' : 'private'}
        </Text>
      )
    case 'excluded':
      return (
        <Text>
          {'  '}
          <Text color="green">✓</Text> excluded pages for {result.productKey}: {result.paths.length ? result.paths.join(', ') : '(none — board cleared)'}
        </Text>
      )
    case 'scan-started':
      return (
        <Box flexDirection="column">
          <Text>
            {'  '}
            <Text color="green">✓</Text> scan started for <Text bold>{result.productKey}</Text>
          </Text>
          <Text dimColor>{'  '}full analyses left: {result.fullAnalysesLeft == null ? 'unlimited' : result.fullAnalysesLeft} · page speed checks left today: {result.pageSpeedChecksLeft == null ? '—' : result.pageSpeedChecksLeft}</Text>
        </Box>
      )
    case 'public-report':
      return <PublicReportBlock domain={result.domain} report={result.report} />
    case 'scan-update':
      return (
        <Text dimColor>
          {'  '}⏳ {result.note}
        </Text>
      )
    case 'text':
      return <Text>{'  '}{result.text}</Text>
    default:
      return <Text dimColor>{'  '}(nothing to show)</Text>
  }
}
