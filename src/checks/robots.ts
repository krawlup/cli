/**
 * robots.txt parsing and verdicts, run client-side.
 *
 * The parser is a faithful port of the server's (insights-provider.ts) so a
 * `krawlup robots` verdict can never disagree with a krawlup scan verdict on
 * the same file: user-agent-boundary records (NOT blank lines), own-group
 * precedence over `*`, and "blocks the site" = a disallow rule that covers
 * every path with no covering allow rule.
 */
import { localFetch } from './net.js'

/** AI crawlers a product site should not block. Kept identical to the server's list. */
export const AI_CRAWLERS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'anthropic-ai',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Amazonbot',
  'Bytespider',
  'meta-externalagent',
  'Meta-ExternalFetcher',
  'DeepSeekBot',
  'QwenBot',
  'ChatGLM-Spider',
  'KimiBot',
  'Kimi-SearchBot',
  'MiniMaxBot',
  'MiMoBot',
  // ChatGPT's web retrieval and much of Perplexity's index both route
  // through Bing, so blocking these blocks AI answer surfaces outright.
  'Bingbot',
  'BingPreview',
  'MistralAI-User',
  'DuckAssistBot',
  'YouBot',
  'cohere-ai',
  'Timpibot',
  'Omgilibot',
  'PanguBot',
  'PetalBot',
] as const

/** Whether a rule blocks EVERYTHING for a crawler — the only case that
 *  means an AI assistant cannot read the site at all. */
export function blocksEverything(pattern: string): boolean {
  const residue = pattern.replace(/[*$]/g, '').trim()
  return residue === '' || residue === '/'
}

/** A WAF challenge served at /robots.txt is not a robots file. */
export function looksLikeHtml(text: string): boolean {
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/.test(text.slice(0, 2000).toLowerCase())
}

export interface RobotsRecord {
  agents: string[]
  rules: Array<{ allow: boolean; pattern: string }>
}

/**
 * The shared robots record parser: user-agent-boundary records + rules, and
 * whether any sitemap was declared. `null` for a non-robots response (WAF
 * challenge, empty body) — never parsed as "no rules at all".
 */
export function parseRobotsRecords(text: string): {
  records: RobotsRecord[]
  sitemapDeclared: boolean
} | null {
  if (!text.trim() || looksLikeHtml(text)) return null

  const records: RobotsRecord[] = []
  let sitemapDeclared = false
  let current: RobotsRecord | null = null

  const flush = () => {
    if (current && current.agents.length) records.push(current)
    current = null
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const [rawKey, ...rest] = line.split(':')
    const key = (rawKey ?? '').trim().toLowerCase()
    const value = rest.join(':').trim()

    if (key === 'sitemap') {
      sitemapDeclared = true
      continue
    }
    if (key === 'user-agent') {
      // A user-agent line that follows rules opens a NEW record.
      if (!current || current.rules.length) flush()
      current = current ?? { agents: [], rules: [] }
      current.agents.push(value.toLowerCase())
      continue
    }
    if (key === 'disallow' || key === 'allow') {
      if (!current) continue
      current.rules.push({ allow: key === 'allow', pattern: value })
    }
  }
  flush()

  return { records, sitemapDeclared }
}

function groupsFor(records: RobotsRecord[], agent: string): RobotsRecord[] {
  const own = records.filter((r) => r.agents.includes(agent))
  return own.length ? own : records.filter((r) => r.agents.includes('*'))
}

/** Whether ANY of `agents` (with the `*` fallback) is whole-site disallowed. */
export function agentBlockedByRobots(records: RobotsRecord[], agents: string[]): boolean {
  return agents.some((bot) =>
    groupsFor(records, bot).some(
      (r) =>
        r.rules.some((rule) => !rule.allow && blocksEverything(rule.pattern)) &&
        !r.rules.some((rule) => rule.allow && blocksEverything(rule.pattern)),
    ),
  )
}

/**
 * Whole-site verdict per known AI crawler. `null` means the file could not
 * be read as robots.txt — never rendered as "everything allowed".
 */
export function parseRobotsForAi(text: string): {
  blocked: string[]
  total: number
  sitemapDeclared: boolean
} | null {
  const total = AI_CRAWLERS.length
  const parsed = parseRobotsRecords(text)
  if (!parsed) return null
  const blocked = AI_CRAWLERS.filter((bot) => agentBlockedByRobots(parsed.records, [bot.toLowerCase()]))
  return { blocked: [...blocked], total, sitemapDeclared: parsed.sitemapDeclared }
}

/** Robots path matching (RFC 9309): `*` wildcards, `$` anchor, longest rule wins.
 *  The pattern comes from a REMOTE robots.txt, so it is capped before it
 *  becomes a regex — a hostile file with hundreds of wildcards must not be
 *  able to burn CPU in regex backtracking. No real robots rule comes close. */
const MAX_PATTERN_CHARS = 256
const MAX_PATTERN_WILDCARDS = 16

export function ruleMatchesPath(pattern: string, path: string): boolean {
  if (pattern.length > MAX_PATTERN_CHARS) return false
  if (pattern.split('*').length - 1 > MAX_PATTERN_WILDCARDS) return false
  const anchored = pattern.endsWith('$')
  const body = anchored ? pattern.slice(0, -1) : pattern
  const escaped = body
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path)
}

export interface PathVerdict {
  allowed: boolean | null
  /** The winning rule, when one matched. */
  matched?: { allow: boolean; pattern: string }
  groupFound: boolean
}

/**
 * May `agent` fetch `path` (path + query, RFC 9309)? Own group first, else
 * `*`; within the group the LONGEST matching rule wins; no match = allowed.
 */
export function pathAllowedFor(records: RobotsRecord[], agent: string, path: string): PathVerdict {
  const groups = groupsFor(records, agent.toLowerCase())
  if (!groups.length) return { allowed: null, groupFound: false }
  let best: { allow: boolean; pattern: string } | null = null
  for (const g of groups) {
    for (const rule of g.rules) {
      if (!rule.pattern || !ruleMatchesPath(rule.pattern, path)) continue
      if (!best || rule.pattern.length > best.pattern.length) best = rule
    }
  }
  if (!best) return { allowed: true, groupFound: true }
  return { allowed: best.allow, matched: best, groupFound: true }
}

/**
 * May ANY of `agents` fetch `path`? (An agent blocked on a path is blocked if
 * its own group or the `*` group disallows it — allow in one group does not
 * override a disallow in the applicable group, because the applicable group
 * selection is already per-agent.)
 */
export function anyAgentAllowed(records: RobotsRecord[], agents: string[], path: string): boolean {
  return agents.every((a) => {
    const v = pathAllowedFor(records, a, path)
    return v.allowed !== false
  })
}

/** Fetch /robots.txt as text, following redirects. Returns null ONLY for a
 *  non-2xx answer (no robots file — allow-all by design); network errors
 *  propagate so callers can distinguish "absent" from "unreadable".
 *  Capped at the AEO asset cap: robots.txt is measured in kilobytes; the
 *  cap only stops an HTML catch-all from being read into memory whole. */
export async function fetchRobotsText(
  origin: string,
  fetcher: (url: string) => Promise<{ status: number; body: string }> = defaultFetcher,
): Promise<string | null> {
  const res = await fetcher(new URL('/robots.txt', origin).toString())
  if (res.status < 200 || res.status >= 300) return null
  return res.body
}

const defaultFetcher = async (url: string): Promise<{ status: number; body: string }> => {
  const res = await localFetch(url, { capBytes: 200_000, timeoutMs: 10_000 })
  return { status: res.status, body: res.body }
}
