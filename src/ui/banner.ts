/**
 * The krawlup wordmark as big, readable ASCII block letters — figlet
 * 'ANSI Regular' (`npm figlet`, `figlet.textSync('krawlup', { font: 'ANSI Regular' })`).
 * Solid ██ rows are legible at a glance, unlike the previous doubly-shaded
 * figlet art which read as pixel garbage. `SPLIT_*` is the column where blue
 * 'krawl' ends and orange 'up' begins — 42 lands in the whitespace gap
 * between the 'l' and the 'u', verified per-line by scanning for the exact
 * 'up' suffix. If the wordmark text ever changes, re-derive both the art
 * and the split column the same way; do not hand-tune the pixels.
 */

export const WORDMARK_WIDE = [
  '██   ██ ██████   █████  ██     ██ ██      ██    ██ ██████',
  '██  ██  ██   ██ ██   ██ ██     ██ ██      ██    ██ ██   ██',
  '█████   ██████  ███████ ██  █  ██ ██      ██    ██ ██████',
  '██  ██  ██   ██ ██   ██ ██ ███ ██ ██      ██    ██ ██',
  '██   ██ ██   ██ ██   ██  ███ ███  ███████  ██████  ██',
] as const

/** Column where the orange 'up' starts (wide variant). */
export const SPLIT_WIDE = 42

export const WORDMARK_NARROW = [
  '██   ██ ██████   █████  ██     ██ ██      ██    ██ ██████',
  '██  ██  ██   ██ ██   ██ ██     ██ ██      ██    ██ ██   ██',
  '█████   ██████  ███████ ██  █  ██ ██      ██    ██ ██████',
  '██  ██  ██   ██ ██   ██ ██ ███ ██ ██      ██    ██ ██',
  '██   ██ ██   ██ ██   ██  ███ ███  ███████  ██████  ██',
] as const

/** Column where the orange 'up' starts (narrow variant). */
export const SPLIT_NARROW = 42
