#!/usr/bin/env bun
/**
 * Regenerate assets/wordmark.svg from src/ui/banner.ts — the README banner
 * is the SAME grid the TUI prints, as SVG rects (browser monospace fonts
 * render U+2588 with glyph gaps, so raw block art falls apart on GitHub).
 *
 * Per banner.ts: `krawl` is brand blue, `up` brand orange, split at the
 * module's own column. Horizontal runs merge into one rect each so no
 * hairline seams show between cells. If the wordmark ever changes, run
 * `bun scripts/wordmark-svg.ts` and commit the refreshed SVG.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { SPLIT_WIDE, WORDMARK_WIDE } from '../src/ui/banner.js'

const CELL_W = 12
const CELL_H = 22
const PAD = 16
const BLUE = '#2b7ff2'
const ORANGE = '#f47c20'

const rows = WORDMARK_WIDE as readonly string[]
const cols = Math.max(...rows.map((r) => r.length))
const rects: string[] = []

for (let y = 0; y < rows.length; y++) {
  const line = rows[y]!
  let x = 0
  while (x < line.length) {
    if (line[x] !== '█') {
      x++
      continue
    }
    let end = x
    while (end < line.length && line[end] === '█') end++
    const fill = x >= SPLIT_WIDE ? ORANGE : BLUE
    rects.push(
      `<rect x="${x * CELL_W}" y="${y * CELL_H}" width="${(end - x) * CELL_W}" height="${CELL_H}" fill="${fill}"/>`,
    )
    x = end
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols * CELL_W + PAD * 2} ${rows.length * CELL_H + PAD * 2}" width="${cols * CELL_W + PAD * 2}" height="${rows.length * CELL_H + PAD * 2}" role="img" aria-label="krawlup">
${rects.join('\n')}
</svg>
`

mkdirSync(new URL('../assets/', import.meta.url), { recursive: true })
writeFileSync(new URL('../assets/wordmark.svg', import.meta.url), svg)
console.error(`wrote assets/wordmark.svg (${rects.length} rects, ${cols * CELL_W + PAD * 2}x${rows.length * CELL_H + PAD * 2})`)
