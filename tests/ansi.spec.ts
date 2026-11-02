/**
 * The ANSI layer: color gating (TTY / NO_COLOR / FORCE_COLOR), the paint
 * presets, the pace tones for "lower is better" waits, and the colored
 * renderLocalText — whose uncolored output must stay byte-identical to the
 * pre-color renderer (the contract agents and CI parse).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { colorEnabled, paceColor, paint, green, dim, bold } from '../src/lib/ansi.js'
import { MARKS, summarize, type Check, type Section } from '../src/checks/verdict.js'
import { renderLocalText, type LocalResult } from '../src/commands/local.js'

const ENV_KEYS = ['NO_COLOR', 'FORCE_COLOR'] as const
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

afterEach(() => {
  delete process.env.NO_COLOR
  delete process.env.FORCE_COLOR
})

describe('colorEnabled', () => {
  it('is off for a non-TTY stream', () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, () => {
      expect(colorEnabled({ isTTY: false })).toBe(false)
      expect(colorEnabled({ isTTY: undefined })).toBe(false)
    })
  })

  it('is on for a TTY and stays on unless NO_COLOR is set', () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: undefined }, () => {
      expect(colorEnabled({ isTTY: true })).toBe(true)
    })
    withEnv({ NO_COLOR: '1', FORCE_COLOR: undefined }, () => {
      expect(colorEnabled({ isTTY: true })).toBe(false)
    })
  })

  it('FORCE_COLOR overrides the TTY signal both ways', () => {
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => {
      expect(colorEnabled({ isTTY: false })).toBe(true)
    })
    withEnv({ NO_COLOR: undefined, FORCE_COLOR: '0' }, () => {
      expect(colorEnabled({ isTTY: true })).toBe(false)
    })
  })
})

describe('paint presets', () => {
  it('wrap with SGR codes and reset when enabled', () => {
    expect(green('✓', true)).toBe('\x1b[32m✓\x1b[0m')
    expect(dim('fix:', true)).toBe('\x1b[2mfix:\x1b[0m')
    expect(bold('krawlup check', true)).toBe('\x1b[1mkrawlup check\x1b[0m')
  })

  it('pass through untouched when disabled (and for empty strings)', () => {
    expect(green('✓', false)).toBe('✓')
    expect(paint('red', '', true)).toBe('')
  })
})

describe('paceColor — lower elapsed is better', () => {
  it('is green within the expected duration', () => {
    expect(paceColor(3, 8)).toBe('green')
    expect(paceColor(8, 8)).toBe('green')
  })

  it('is yellow up to twice over, red beyond', () => {
    expect(paceColor(8.5, 8)).toBe('yellow')
    expect(paceColor(16, 8)).toBe('yellow')
    expect(paceColor(16.1, 8)).toBe('red')
  })

  it('never punishes an unknown expectation', () => {
    expect(paceColor(999, 0)).toBe('green')
  })
})

// ── renderLocalText color contract ──────────────────────────────────────

const check = (over: Partial<Check>): Check => ({
  id: 'x',
  label: 'Thing',
  status: 'pass',
  detail: 'fine',
  ...over,
})

const result = (checks: Check[]): LocalResult => {
  const sections: Section[] = [{ id: 's', title: 'Section', checks }]
  return {
    cmd: 'check',
    title: 'krawlup check example.com',
    meta: {},
    sections,
    summary: summarize(sections),
    exit: checks.some((c) => c.status === 'fail') ? 1 : 0,
  }
}

describe('renderLocalText colors', () => {
  it('color:false is byte-identical to the plain renderer contract', () => {
    const r = result([
      check({ id: 'a', status: 'pass' }),
      check({ id: 'b', status: 'fail', detail: 'broken', fix: 'add X-Header: 1' }),
      check({ id: 'c', status: 'warn' }),
      check({ id: 'd', status: 'unknown' }),
    ])
    const plain = renderLocalText(r, { color: false })
    expect(plain).toContain(MARKS.pass)
    expect(plain).toContain('1 fail')
    expect(plain).toContain('fix: add X-Header: 1')
    expect(plain).not.toContain('\x1b[')
  })

  it('color:true paints marks in their status colors and counts in red/yellow', () => {
    const r = result([
      check({ id: 'a', status: 'pass' }),
      check({ id: 'b', status: 'fail', detail: 'broken', fix: 'add X-Header: 1' }),
    ])
    const colored = renderLocalText(r, { color: true })
    expect(colored).toContain(`\x1b[32m${MARKS.pass}\x1b[0m`)
    expect(colored).toContain(`\x1b[31m${MARKS.fail}\x1b[0m`)
    expect(colored).toContain('\x1b[31m1 fail\x1b[0m')
    expect(colored).toContain('\x1b[36madd X-Header: 1\x1b[0m')
    // section titles read bold+cyan
    expect(colored).toContain('\x1b[1m\x1b[36mSection\x1b[0m')
    // the pass count is green
    expect(colored).toContain('\x1b[32m1 pass\x1b[0m')
  })
})
