/**
 * The free site report's two blocks: the LIVE scan screen (checklist, bar,
 * queue position — mirrors the web panel's stage list and pacing) and the
 * rendered report. Both are strictly data-driven from the payload the
 * server returns — a metric the server doesn't send is a line the CLI
 * doesn't draw. Everything adapts to the terminal width.
 */
import { Box, Text, useInput } from 'ink'
import React, { useEffect, useState } from 'react'
import type { PublicReportPayload, PublicScanState } from '../api/public-scan.js'
import { PUBLIC_SCAN_STAGES, stageBarPct, stagePacing } from '../api/public-scan.js'
import { paceColor } from '../lib/ansi.js'
import { timeAgo } from '../lib/format.js'
import { scoreColor } from '../lib/score.js'
import { IssueLine, Score, Section, useTerminalColumns } from './components.js'
import {
  AeoBlock,
  AiFixCardBlock,
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

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Bar({ pct, right, rightTone, tone, width }: { pct: number; right?: string; rightTone?: 'green' | 'yellow' | 'red'; tone?: 'green' | 'yellow' | 'red'; width: number }) {
  const w = Math.max(6, width)
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * w)
  const bar = '█'.repeat(Math.min(filled, w)) + '░'.repeat(Math.max(0, w - Math.min(filled, w)))
  // Complete → green; otherwise the pace tone wins when a stage overruns
  // (yellow ≤2× its expected seconds, red beyond); normal pace stays cyan.
  const color = pct >= 100 ? 'green' : tone === 'yellow' || tone === 'red' ? tone : 'cyan'
  return (
    <Text>
      {'  '}
      <Text color={color}>{bar}</Text>{' '}
      <Text bold>{Math.floor(pct)}%</Text>
      {right ? (
        rightTone && rightTone !== 'green' ? (
          <Text color={rightTone}> {right}</Text>
        ) : (
          <Text dimColor> {right}</Text>
        )
      ) : null}
    </Text>
  )
}

/**
 * The LIVE scan screen. Self-ticking between polls: the caller re-renders it
 * with a fresh `state` at every poll (~2s) and the local clock keeps the bar
 * and elapsed line moving at 400ms in between — the same pacing model the
 * web panel runs, bounded at 95% until the report read answers.
 */
export function PublicScanProgress({
  state,
  showEscHint,
  onEsc,
}: {
  state: PublicScanState
  showEscHint?: boolean
  /** Wire esc to a real abort — the hint is rendered only when this exists. */
  onEsc?: () => void
}) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 400)
    return () => clearInterval(t)
  }, [])
  // The wait's own abort — the prompt-level BusyEscape can't fire in the
  // places this screen renders alone (argv TTY mode, pre-auth menu),
  // so esc handling rides the component that shows the hint.
  useInput(
    (input, key) => {
      if (key.escape && state.phase !== 'done') onEsc?.()
    },
    { isActive: !!onEsc },
  )
  const pacing = stagePacing()
  const elapsedInStage = (Date.now() - state.stageStartMs) / 1000
  const barPct = Math.max(state.barPct, stageBarPct(state.stageIdx, elapsedInStage, pacing))
  const cols = useTerminalColumns()
  // Pace tones ("lower is better"): the bar tracks the ACTIVE stage against
  // its expected seconds; the total clock tracks elapsed against everything
  // planned so far. Green within plan, yellow ≤2× over, red beyond.
  const stageExpected = PUBLIC_SCAN_STAGES[state.stageIdx]?.seconds ?? 0
  const barTone = state.phase === 'done' ? 'green' : paceColor(elapsedInStage, stageExpected)
  const plannedSec = PUBLIC_SCAN_STAGES.slice(0, state.stageIdx + 1).reduce((a, s) => a + s.seconds, 0)
  const clockTone = state.phase === 'done' ? 'green' : paceColor(state.elapsedSec, plannedSec)
  // Checklist rows start at 6 columns (indent + mark); keep at least 20 for
  // the label, cap so the bar and elapsed line still fit on 60-col terminals.
  const labelW = Math.max(20, Math.min(42, cols - 40))

  return (
    <Box flexDirection="column">
      <Text bold>{'  '}Free site report — full scan</Text>
      {PUBLIC_SCAN_STAGES.map((stage, i) => {
        const label = stage.label.slice(0, labelW).trim()
        if (i < state.stageIdx) {
          return (
            <Text key={stage.id} dimColor>
              {'  '}<Text color="green">✓</Text> {label}
            </Text>
          )
        }
        if (i === state.stageIdx) {
          if (state.phase === 'done') {
            return (
              <Text key={stage.id}>
                {' '}<Text color="green" bold>✓</Text> {label}
              </Text>
            )
          }
          // The bar already carries the elapsed clock — the active row only
          // adds what the bar cannot say (queue position).
          return (
            <Text key={stage.id}>
              {'  '}<Text color="cyan" bold>▸</Text> {label}
              {state.phase === 'queued' && state.queuePosition != null ? (
                <Text dimColor>{`  · position ${state.queuePosition} in the free queue`}</Text>
              ) : null}
            </Text>
          )
        }
        return (
          <Text key={stage.id} dimColor>
            {'  '}· {label}
          </Text>
        )
      })}
      <Box marginTop={1}>
        <Bar
          pct={barPct}
          right={fmtClock(state.elapsedSec)}
          rightTone={clockTone}
          tone={barTone}
          width={Math.max(12, Math.min(32, cols - 44))}
        />
      </Box>
      <Text dimColor>{'  '}{state.stageNote}</Text>
      {showEscHint && state.phase !== 'done' && onEsc ? (
        <Box marginTop={1}>
          <Text dimColor>{'  '}esc stops waiting — the scan keeps running on krawlup.com</Text>
        </Box>
      ) : null}
    </Box>
  )
}

/** Guard every dynamic string a JSX child receives — server JSON is loosely typed. */
function safeText(v: unknown): string {
  if (v == null) return '—'
  return typeof v === 'string' ? v : String(v)
}

/** The site's own axis naming (ScoreSummaryHero), title case on every surface. */
const AXIS_LABELS: Record<string, string> = {
  performance: 'Speed',
  aeo: 'Search & AI',
  conversion: 'Conversion',
}

/** Row width the Axes table aligns on — fits "Trust & security". */
const AXIS_W = 16

/**
 * The hero's Trust & security counts: the same six checks the web card
 * scores (HTTPS redirect, live TLS, HSTS / CSP / X-Frame-Options, Safe
 * Browsing). A pass COUNT is not a 0–100 score — it renders as "n/m", never
 * through scoreColor. A check the sweep never ran is excluded, never scored false.
 */
function trustPasses(site: NonNullable<PublicReportPayload['site']> | null): { pass: number; total: number } {
  if (!site) return { pass: 0, total: 0 }
  const checks: Array<boolean | null> = [
    site.httpsRedirect === true,
    // An unparseable date is neither never-run nor a real expiry — excluded
    // like the other unknowns, never scored false (NaN > x is false).
    site.tlsValidTo && Number.isFinite(new Date(site.tlsValidTo).getTime())
      ? new Date(site.tlsValidTo).getTime() > Date.now()
      : null,
    site.headers?.hsts === true,
    site.headers?.csp === true,
    site.headers?.xFrameOptions === true,
    site.safeBrowsing === 'clean',
  ]
  const scored = checks.filter((v): v is boolean => v !== null)
  return { pass: scored.filter(Boolean).length, total: scored.length }
}

/** Scorecard planes, the LCP element, conversion checks, the mobile test,
 *  trust rows, authority, CrUX and findings all live in report-sections.tsx —
 *  the founder insights render the SAME blocks through the SAME components. */

export function PublicReportBlock({ domain, report }: { domain: string; report: PublicReportPayload }) {
  const overall = report.overall ?? null
  const overallScore = overall?.score ?? report.scorecards?.overall?.score ?? report.psi?.performance ?? null
  const parts = overall?.parts ?? {}
  const issues = Array.isArray(report.issues) ? report.issues : (Array.isArray(report.seoCrawl?.issues) ? (report.seoCrawl!.issues as unknown[]) : [])
  const trust = trustPasses(report.site ?? null)
  const psi = report.psi ?? null

  // Lighthouse's three category scores stay in the Axes table (Speed detail
  // below carries the lab metrics behind the performance number).
  const lighthouseBits: string[] = []
  for (const key of ['accessibility', 'bestPractices', 'seo'] as const) {
    const v = (psi as Record<string, unknown> | null)?.[key]
    if (typeof v === 'number') lighthouseBits.push(`${key === 'bestPractices' ? 'best practices' : key === 'seo' ? 'SEO' : key} ${Math.round(v)}`)
  }
  const lighthouseLine = lighthouseBits.join(' · ') || null
  const quota = report.publicQuota ?? null
  const verdictLine = report.verdict?.line ?? overall?.verdict ?? null
  const updated = report.updatedAt ?? report.checkedAt ?? null

  return (
    <Box flexDirection="column">
      <Text bold>
        {'  '}Site report · <Text color="cyan">{domain}</Text>
        {report.category ? <Text dimColor> · {safeText(report.category)}</Text> : null}
        {updated ? <Text dimColor> · updated {timeAgo(updated)}</Text> : null}
      </Text>
      <Box>
        <Score label="overall" score={overallScore} width={14} />
        {overall?.band ? <Text dimColor> ({overall.band})</Text> : null}
        {overall?.archetype ? <Text dimColor> · {overall.archetype}</Text> : null}
      </Box>
      {verdictLine ? <Text dimColor>{'  '}{safeText(verdictLine)}</Text> : null}

      <Section title="Axes">
        {(['performance', 'aeo', 'conversion'] as const).map((axis) => {
          const v = (parts as Record<string, number | null | undefined>)[axis]
          return (
            <Text key={axis}>
              {'  '}
              <Text dimColor>{(AXIS_LABELS[axis] ?? axis).padEnd(AXIS_W + 1)}</Text>
              {v == null ? <Text dimColor>— (partial scan)</Text> : <Text bold color={scoreColor(v)}>{Math.round(v)}</Text>}
              {overall?.bottleneck === axis ? <Text dimColor> · primary bottleneck</Text> : null}
            </Text>
          )
        })}
        {/* The n/m count leads; TrustRows names every check behind it. */}
        <Text>
          {'  '}
          <Text dimColor>{'Trust & security'.padEnd(AXIS_W + 1)}</Text>
          {trust.total ? (
            <Text color={trust.pass === trust.total ? 'green' : undefined}>
              {trust.pass}/{trust.total}
              <Text dimColor> checks passing</Text>
            </Text>
          ) : (
            <Text dimColor>not checked</Text>
          )}
        </Text>
        <TrustRows site={report.site ?? null} linkPreview={report.linkPreview ?? null} />
        <AuthorityRows dr={report.dr ?? null} opr={report.opr ?? null} />
        {lighthouseLine ? (
          <Text>
            {'  '}
            <Text dimColor>{'Lighthouse'.padEnd(AXIS_W + 1)}</Text>
            {lighthouseLine}
          </Text>
        ) : null}
        <CruxRows crux={report.crux ?? null} />
      </Section>

      <VitalsBlock psi={psi} />
      <ScorecardPlanes scorecards={report.scorecards ?? null} />

      {issues.length ? (
        <Section title={`Issues (${issues.length})`}>
          {issues.slice(0, 10).map((iss: any, i: number) => (
            <IssueLine key={i} issue={iss} />
          ))}
          {issues.length > 10 ? <Text dimColor>{'  '}… {issues.length - 10} more</Text> : null}
        </Section>
      ) : null}

      <FindingsBlock findings={report.findings ?? []} />
      <AeoBlock aeo={report.aeo ?? null} />
      <CroBlock cro={report.cro ?? null} />
      <MobileBlock mobile={report.mobile ?? null} />
      <SeoCrawlBlock seoCrawl={report.seoCrawl ?? null} />
      <ScreenshotLines shot={report.screenshot ?? null} mobileShot={report.mobileScreenshot ?? null} />
      <AiFixCardBlock aiFixes={report.aiFixes ?? null} issues={issues} aiFixPreparing={report.aiFixPreparing === true} />
      <BottleneckCardBlock card={report.bottleneck?.card ?? null} />
      <CheckStatusBlock providerHealth={report.providerHealth ?? null} />

      <Section title="Your free quota">
        {quota?.betaUnlimited ? (
          <Text dimColor>{'  '}unlimited — this account is on the beta allowlist</Text>
        ) : quota?.scansLeft === 0 && (quota.scansUsed ?? 0) === 0 ? (
          // Zero LEFT with zero USED is not a spent pool — the device was never
          // granted one (the admin can switch the CLI pool off entirely). Say
          // that instead of quoting "0 used", which reads like a charge.
          <Text dimColor>{'  '}no free scans on this device right now — a signed-in beta tester scans unlimited</Text>
        ) : quota?.scansLeft != null ? (
          <Text>
            {'  '}
            <Text dimColor>full scans on this device: </Text>
            {quota.scansLeft}
            <Text dimColor>{` left this month (${quota.scansUsed ?? 0} used) · page-speed re-checks left today: ${quota.pageSpeedChecksLeftToday ?? '—'}`}</Text>
          </Text>
        ) : (
          <Text dimColor>{'  '}free scans: quota not reported by the server</Text>
        )}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{'  '}full report on the web: https://krawlup.com/site-report/{domain}</Text>
          <Text dimColor>{'  '}markdown: `krawlup report {domain} --md`</Text>
        </Box>
      </Section>
    </Box>
  )
}
