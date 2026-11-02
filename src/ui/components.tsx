/** Ink building blocks — spinner, score chips, bars, tables. Pure presentational. */
import { Box, Text, useInput } from 'ink'
import React, { useEffect, useState } from 'react'
import { barRow, sparkline } from '../lib/charts.js'
import { fmtNum } from '../lib/format.js'
import { scoreColor, severityTone } from '../lib/score.js'
import { MARKS, STATUS_COLOR } from '../checks/verdict.js'
import type { LocalResult } from '../commands/local.js'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/**
 * Live terminal width (ink 6 has no dimensions hook; plain stdout works
 * for both the TUI and one-shot mode). Defaults to 80 when unknown.
 */
export function useTerminalColumns(): number {
  const [cols, setCols] = useState(process.stdout.columns ?? 80)
  useEffect(() => {
    const onResize = (): void => setCols(process.stdout.columns ?? 80)
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
    }
  }, [])
  return cols
}

export function Spinner({ label }: { label?: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])
  return (
    <Text dimColor>
      {SPINNER_FRAMES[frame]} {label ?? 'working…'}
    </Text>
  )
}

/** Pad or ellipsize a label to an exact cell count, so stacked rows share a
 *  column no matter how long the text is. */
function fitLabel(label: string, width: number): string {
  if (label.length === width) return label
  if (label.length > width) return `${label.slice(0, Math.max(0, width - 1))}…`
  return label.padEnd(width)
}

/** `███░░ 87` — a one-line score chip with tone color. Indented to the
 *  shared 2-space gutter so score rows line up under every other row.
 *  `labelWidth` locks the bar column across a stack of scores. */
export function Score({ label, score, width = 10, labelWidth }: { label?: string; score: number | null | undefined; width?: number; labelWidth?: number }) {
  const filled = score == null ? 0 : Math.max(score > 0 ? 1 : 0, Math.round((score / 100) * width))
  const bar = '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(0, width - Math.min(filled, width)))
  const shownLabel = label == null ? null : labelWidth == null ? label : fitLabel(label, labelWidth)
  return (
    <Text>
      {'  '}
      {shownLabel ? <Text>{shownLabel} </Text> : null}
      <Text color={scoreColor(score)}>{bar}</Text>{' '}
      <Text color={scoreColor(score)} bold>
        {score == null ? '—' : score}
      </Text>
    </Text>
  )
}

export function BarList({
  entries,
  width = 24,
  format = (n: number) => fmtNum(n),
  emptyText = 'no data yet',
}: {
  entries: Array<{ label: string; value: number | null }>
  width?: number
  format?: (n: number) => string
  emptyText?: string
}) {
  // A facility-gated plan returns rows whose counts are all null — that is
  // honest absence and must not draw a rail of empty bars.
  if (!entries.length || entries.every((e) => e.value == null)) return <Text dimColor>{'  '}{emptyText}</Text>
  const max = Math.max(1, ...entries.map((e) => e.value ?? 0))
  // One label column for the whole stack: bars must start at the same cell.
  const rows = entries.slice(0, 8)
  const labelWidth = Math.min(28, Math.max(4, ...rows.map((e) => e.label.length)))
  return (
    <Box flexDirection="column">
      {rows.map((e) => {
        const row = barRow(e.label, e.value, max, { width, labelWidth, valueText: e.value == null ? '—' : format(e.value) })
        return (
          <Text key={e.label}>
            {'  '}
            <Text dimColor>{row.label}</Text> <Text color="cyan">{row.bar}</Text> <Text>{row.value}</Text>
          </Text>
        )
      })}
    </Box>
  )
}

export function Spark({ values, width = 44, pad = '' }: { values: Array<number | null>; width?: number; pad?: string }) {
  const s = sparkline(values, width)
  if (!s) return <Text dimColor>{pad} (no series)</Text>
  return <Text color="cyan">{pad}{s}</Text>
}

export interface TableColumn {
  header: string
  /** Upper bound for this column — content narrower than this shrinks to fit. */
  width: number
  /** Cell value → display text. */
  get: (row: any) => string
  /** Optional per-cell color. */
  color?: (row: any) => string | undefined
  /** Numbers right-align so digits stack; labels stay left. */
  align?: 'left' | 'right'
}

function fit(text: string, width: number, align: 'left' | 'right' | undefined): string {
  const clipped = text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
  return align === 'right' ? clipped.padStart(width) : clipped.padEnd(width)
}

/** Fixed-width ANSI table; no wrapping. Columns shrink to their widest cell
 *  (up to the declared cap) so a sparse table never floats in dead space,
 *  and the whole grid only compresses when the terminal is narrower. */
export function Table({ columns, rows }: { columns: TableColumn[]; rows: any[] }) {
  const termCols = useTerminalColumns()
  if (!rows.length) return <Text dimColor>{'  '}(nothing here yet)</Text>
  const SEP = 2
  const widths = columns.map((c) => {
    let widest = c.header.length
    for (const row of rows) widest = Math.max(widest, String(c.get(row) ?? '').length)
    return Math.min(c.width, widest)
  })
  const natural = widths.reduce((s, w) => s + w, 0) + SEP * (columns.length - 1)
  if (termCols >= 20 && natural > termCols - 2) {
    const budget = termCols - 2 - SEP * (columns.length - 1)
    const scale = budget / widths.reduce((s, w) => s + w, 0)
    for (let i = 0; i < widths.length; i += 1) widths[i] = Math.max(Math.min(widths[i]!, 4), Math.floor(widths[i]! * scale))
  }
  const headerLine = columns.map((c, i) => fit(c.header, widths[i]!, c.align)).join('  ')
  return (
    <Box flexDirection="column">
      <Text bold dimColor>
        {'  '}
        {headerLine}
      </Text>
      {rows.map((row, i) => (
        <Text key={i}>
          {'  '}
          {columns.map((c, j) => {
            const color = c.color?.(row)
            return (
              <Text key={j} color={color}>
                {fit(String(c.get(row) ?? ''), widths[j]!, c.align)}
                {j < columns.length - 1 ? '  ' : ''}
              </Text>
            )
          })}
        </Text>
      ))}
    </Box>
  )
}

export function KV({ entries }: { entries: Array<[string, React.ReactNode]> }) {
  return (
    <Box flexDirection="column">
      {entries.map(([k, v], i) => (
        <Text key={i}>
          {'  '}
          <Text dimColor>{k.padEnd(18)}</Text>
          {v}
        </Text>
      ))}
    </Box>
  )
}

export function Section({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{'  '}{title}</Text>
      {children}
    </Box>
  )
}

/** A severity-colored issue line. */
export function IssueLine({ issue }: { issue: { id?: string; title?: string; severity?: string; displayValue?: string; message?: string } }) {
  const raw = issue.title || issue.message || issue.id || 'issue'
  const title = typeof raw === 'string' ? raw : String(raw)
  return (
    <Text>
      {'  '}
      <Text color={severityTone(issue.severity)}>●</Text> {title}
      {issue.displayValue ? <Text dimColor> — {issue.displayValue}</Text> : null}
    </Text>
  )
}

/** DETAIL_CAP parity with the argv renderer (local.ts keeps it private). */
const LOCAL_DETAIL_CAP = 240

/**
 * The local battery result, structured for the TUI scrollback — the Ink
 * twin of `renderLocalText` with the same palette (marks by status, cyan
 * section titles, dim notes, cyan fix values). Lives in history, so it
 * renders once and never re-renders.
 */
export function LocalResultView({ result }: { result: LocalResult }) {
  const s = result.summary
  return (
    <Box flexDirection="column">
      <Text bold>{result.title}</Text>
      <Text>
        {[
          s.fail ? <Text key="f" color="red">{s.fail} fail</Text> : null,
          s.warn ? <Text key="w" color="yellow">{s.warn} warn</Text> : null,
          s.unknown ? <Text key="u" color="gray">{s.unknown} unknown</Text> : null,
          s.pass ? <Text key="p" color="green">{s.pass} pass</Text> : null,
        ]
          .filter(Boolean)
          .map((node, i) => (
            <Text key={i}>
              {i > 0 ? <Text dimColor> · </Text> : null}
              {node}
            </Text>
          ))}
      </Text>
      {result.sections.map((sec) => (
        <Box key={sec.id} flexDirection="column" marginTop={1}>
          <Text bold color="cyan">
            {sec.title}
          </Text>
          {sec.checks.map((ch) => (
            <Box key={ch.id} flexDirection="column">
              <Text>
                {'  '}
                <Text color={STATUS_COLOR[ch.status]} bold={ch.status !== 'unknown'}>
                  {MARKS[ch.status]}
                </Text>{' '}
                {ch.label.padEnd(18)}
                {ch.detail.slice(0, LOCAL_DETAIL_CAP)}
              </Text>
              {ch.fix ? (
                <Text>
                  {'    '}
                  <Text dimColor>fix: </Text>
                  <Text color="cyan">{ch.fix}</Text>
                </Text>
              ) : null}
            </Box>
          ))}
          {sec.note ? (
            <Text dimColor>
              {'  '}
              {sec.note.split('\n').map((l) => l.slice(0, LOCAL_DETAIL_CAP)).join('\n  ')}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  )
}
