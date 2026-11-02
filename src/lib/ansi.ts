/**
 * Zero-dependency ANSI color for the plain-string output paths (argv
 * renderers, console messages). Ink screens don't come through here — they
 * use `<Text color>` natively.
 *
 * Color is strictly opt-out-able: on only for a TTY, killed by NO_COLOR,
 * forced past a pipe with FORCE_COLOR — so `--json`, `--md`, and every
 * pipe/CI consumer keep receiving byte-clean output.
 */

const CODES = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
} as const

export type AnsiPreset = keyof typeof CODES

const RESET = '\x1b[0m'

/** Color decision for one output stream (stdout vs stderr can differ). */
export function colorEnabled(stream: { isTTY?: boolean | undefined } | undefined = process.stdout): boolean {
  if (process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === 'true') return true
  if (process.env.FORCE_COLOR === '0' || process.env.FORCE_COLOR === 'false') return false
  if (process.env.NO_COLOR) return false
  return !!stream?.isTTY
}

/** Wrap `s` in the preset's SGR codes when `enabled`, else pass it through untouched. */
export function paint(preset: AnsiPreset, s: string, enabled: boolean): string {
  if (!enabled || s.length === 0) return s
  return `${CODES[preset]}${s}${RESET}`
}

export const green = (s: string, enabled: boolean) => paint('green', s, enabled)
export const yellow = (s: string, enabled: boolean) => paint('yellow', s, enabled)
export const red = (s: string, enabled: boolean) => paint('red', s, enabled)
export const cyan = (s: string, enabled: boolean) => paint('cyan', s, enabled)
export const gray = (s: string, enabled: boolean) => paint('gray', s, enabled)
export const dim = (s: string, enabled: boolean) => paint('dim', s, enabled)
export const bold = (s: string, enabled: boolean) => paint('bold', s, enabled)

/**
 * Pace tone for "lower is better" waits (elapsed time against the stage's
 * expected seconds): green within plan, yellow up to twice over, red beyond.
 * An unknown expectation (≤ 0) is never punished — always green.
 */
export function paceColor(elapsedSec: number, expectedSec: number): 'green' | 'yellow' | 'red' {
  if (expectedSec <= 0) return 'green'
  if (elapsedSec <= expectedSec) return 'green'
  if (elapsedSec <= expectedSec * 2) return 'yellow'
  return 'red'
}
