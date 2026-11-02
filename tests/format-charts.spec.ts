import { describe, expect, it } from 'vitest'
import { fmtCents, fmtDelta, fmtNum, fmtPct, timeAgo } from '../src/lib/format.js'
import { barMax, barRow, sparkline } from '../src/lib/charts.js'
import { scoreColor, scoreTone } from '../src/lib/score.js'

describe('format', () => {
  it('formats numbers compactly and never lies about nulls', () => {
    expect(fmtNum(0)).toBe('0')
    expect(fmtNum(999)).toBe('999')
    expect(fmtNum(1234)).toBe('1,234')
    expect(fmtNum(12_345)).toBe('12.3k')
    expect(fmtNum(2_500_000)).toBe('2.5M')
    expect(fmtNum(null)).toBe('—')
    expect(fmtNum(undefined)).toBe('—')
  })

  it('formats money and percentages with a null-safe dash', () => {
    expect(fmtCents(0)).toBe('$0.00')
    expect(fmtCents(20900)).toBe('$209.00')
    expect(fmtCents(123_456_78)).toBe('$123.5k')
    expect(fmtCents(45_678)).toBe('$456.78')
    expect(fmtCents(null)).toBe('—')
    expect(fmtPct(12.34)).toBe('12.3%')
    expect(fmtPct(null)).toBe('—')
  })

  it('signs deltas and tones them', () => {
    expect(fmtDelta(12.4)).toBe('+12.4%')
    expect(fmtDelta(-3.1)).toBe('−3.1%')
    expect(fmtDelta(0)).toBe('0.0%')
    expect(fmtDelta(null)).toBe('—')
  })

  it('timeAgo buckets honestly', () => {
    expect(timeAgo(null)).toBe('never')
    expect(timeAgo(Date.now() - 30_000)).toBe('just now')
    expect(timeAgo(Date.now() - 5 * 60_000)).toBe('5m ago')
    expect(timeAgo(Date.now() - 3 * 3600_000)).toBe('3h ago')
    expect(timeAgo(Date.now() - 2 * 24 * 3600_000)).toBe('2d ago')
  })
})

describe('charts', () => {
  it('sparkline maps the series into block glyphs with gaps for nulls', () => {
    expect(sparkline([])).toBe('')
    expect(sparkline([null, null])).toBe('')
    expect(sparkline([1, 2, 3])).toBe('▁▅█')
    expect(sparkline([5, 5, 5])).toBe('▅▅▅') // constant → mid glyph, never NaN
    expect(sparkline([1, null, 3])).toBe('▁ █')
  })

  it('barRow renders filled and empty segments with a floored 1-block minimum', () => {
    expect(barRow('a', 50, 100, { width: 10 })).toMatchObject({ bar: '█████░░░░░', value: '50' })
    expect(barRow('a', 0, 100, { width: 10 }).bar).toBe('░░░░░░░░░░')
    expect(barRow('a', 1, 100, { width: 10 }).bar).toBe('█░░░░░░░░░')
    expect(barRow('a', null, 100, { width: 10 }).value).toBe('—')
  })

  it('barRow can hold one label column so a stacked list of bars lines up', () => {
    // Without a shared width each row pads to its own label, so the bars
    // start at different cells — the exact misalignment a bar list shows.
    expect(barRow('/', 1, 1, { width: 4 }).label.length).not.toBe(barRow('/pricing', 1, 1, { width: 4 }).label.length)
    const shared = { width: 4, labelWidth: 12 }
    expect(barRow('/', 1, 1, shared).label).toBe('/           ')
    expect(barRow('/pricing', 1, 1, shared).label).toBe('/pricing    ')
    expect(barRow('/pricing', 1, 1, shared).label.length).toBe(barRow('/', 1, 1, shared).label.length)
    // Overlong labels ellipsize into the same cell instead of widening it.
    expect(barRow('/a-very-long-path', 1, 1, shared).label).toBe('/a-very-lon…')
    // The 28-cell cap still bounds a labelWidth handed in by a caller.
    expect(barRow('x', 1, 1, { width: 4, labelWidth: 80 }).label.length).toBe(28)
  })

  it('barMax guards an all-zero list', () => {
    expect(barMax([0, 0])).toBe(1)
    expect(barMax([0, 7])).toBe(7)
  })
})

describe('score semantics', () => {
  it('tones by threshold and renders null as gray', () => {
    expect(scoreTone(91)).toBe('good')
    expect(scoreTone(65)).toBe('mid')
    expect(scoreTone(10)).toBe('bad')
    expect(scoreTone(null)).toBe('none')
    expect(scoreColor(null)).toBe('gray')
  })
})
