/**
 * Terminal charts — pure string renderers. No deps: block glyphs do the
 * drawing, and every function takes explicit widths so the callers keep
 * layout deterministic across terminal sizes.
 */

const SPARK_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

/**
 * A one-line sparkline over a numeric series. Nulls (no data that day)
 * render as a space so gaps stay honest. Constant series pins to the
 * mid glyph instead of dividing by zero.
 */
export function sparkline(values: Array<number | null>, width = 40): string {
  const pts = values.slice(-width)
  const nums = pts.filter((v): v is number => v != null && !Number.isNaN(v))
  if (!nums.length) return ''
  const min = Math.min(...nums)
  const constant = min === Math.max(...nums)
  const max = constant ? min + 1 : Math.max(...nums)
  return pts
    .map((v) => {
      if (v == null || Number.isNaN(v)) return ' '
      // A constant series pins to the mid glyph — flat is a real shape.
      const t = constant ? 0.5 : (v - min) / (max - min)
      return SPARK_GLYPHS[Math.min(SPARK_GLYPHS.length - 1, Math.floor(t * SPARK_GLYPHS.length))]!
    })
    .join('')
}

/**
 * One horizontal bar row: `label …… ███████░░░ 1,234`. The label is
 * truncated to fit; the bar shares the remaining width with the value.
 * Pass `labelWidth` to line a stack of bars up in one column — without it
 * each row pads to its own label, so bars start at different offsets.
 */
export function barRow(
  label: string,
  value: number | null,
  max: number,
  opts: { width?: number; valueText?: string; labelWidth?: number } = {},
): { label: string; bar: string; value: string } {
  const width = opts.width ?? 20
  const valueText = opts.valueText ?? (value == null ? '—' : String(value))
  const labelWidth = Math.max(4, Math.min(28, opts.labelWidth ?? label.length))
  const shown = label.length > labelWidth ? `${label.slice(0, Math.max(0, labelWidth - 1))}…` : label.padEnd(labelWidth)
  if (value == null || Number.isNaN(value) || max <= 0) {
    return { label: shown, bar: '░'.repeat(width), value: valueText }
  }
  const filled = Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width))
  return { label: shown, bar: '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(0, width - Math.min(filled, width))), value: valueText }
}

/** The max across a bar list (guarding an all-zero list). */
export function barMax(values: number[]): number {
  const max = Math.max(0, ...values)
  return max > 0 ? max : 1
}
