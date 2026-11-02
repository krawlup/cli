/**
 * The local battery: `krawlup check/robots/mail/ssl/headers/text/schema/
 * links/og/diff` — everything here runs on the user's machine against the
 * target they named, with Node builtins only. No API calls, no keys, no
 * quota; the value contract with agents is `--json` + stable exit codes
 * (0 = clean, 1 = findings, 2 = usage).
 */
import { Resolver } from 'node:dns/promises'
import { normalizeDomainArg } from '../lib/domain.js'
import { localFetch, GPTBOT_UA, type FetchPageResult } from '../checks/net.js'
import {
  fetchRobotsText,
  parseRobotsForAi,
  parseRobotsRecords,
  pathAllowedFor,
  type RobotsRecord,
} from '../checks/robots.js'
import { judgeMail, probeMail, type MailDns } from '../checks/mail.js'
import { judgeTls, probeTls, type TlsProber } from '../checks/ssl.js'
import { auditHeaders } from '../checks/headers.js'
import { extractMetaTags, extractMetaDescription, extractTitle } from '../checks/html.js'
import { lintSchema } from '../checks/schema.js'
import { collectOgFacts, judgeOg } from '../checks/og.js'
import { textFacts, judgeText } from '../checks/text.js'
import { checkPageLinks, judgeLinks } from '../checks/links.js'
import { diffSnapshots, judgeDiff, loadSnapshot, makeSnapshot, saveSnapshot, defaultSnapshotDir } from '../checks/diff.js'
import { exitFor, MARKS, STATUS_COLOR, summarize, type Check, type Section } from '../checks/verdict.js'
import { bold, colorEnabled, cyan, dim, green, gray, red, yellow } from '../lib/ansi.js'

export class UsageError extends Error {}

export interface LocalResult {
  cmd: string
  title: string
  meta: Record<string, unknown>
  sections: Section[]
  summary: ReturnType<typeof summarize>
  exit: 0 | 1
}

/** IO seams so every command is testable offline. */
export interface LocalIo {
  fetchPage?: (url: string, opts?: { ua?: string }) => Promise<FetchPageResult>
  probeTls?: TlsProber
  dns?: MailDns
  snapshotDir?: string
}

function systemDns(): MailDns {
  const resolver = new Resolver({ timeout: 5_000, tries: 2 })
  return {
    resolveTxt: (host) => resolver.resolveTxt(host),
    resolveMx: (host) => resolver.resolveMx(host),
    resolveA: async (host) => {
      // ENODATA = the name exists but has no records of this type: fall
      // through to AAAA, and if THAT is also ENODATA the honest answer is
      // "no addresses" — not an error (the MX verdict needs the difference
      // between "domain cannot receive mail" and "DNS could not answer").
      try {
        return await resolver.resolve4(host)
      } catch (e4) {
        if ((e4 as { code?: string }).code !== 'ENODATA') throw e4
        try {
          return await resolver.resolve6(host)
        } catch (e6) {
          if ((e6 as { code?: string }).code !== 'ENODATA') throw e6
          return []
        }
      }
    },
  }
}

async function fetchPage(url: string, io: LocalIo, opts: { ua?: string } = {}): Promise<FetchPageResult> {
  const f = io.fetchPage ?? ((u: string, o?: { ua?: string }) => localFetch(u, { capBytes: 2_000_000, timeoutMs: 12_000, ...o }))
  return f(url, opts)
}

/** A domain argument for the DNS/TLS commands (no scheme, no path). */
function requireDomain(raw: string | null | undefined, usage: string): string {
  const domain = raw ? normalizeDomainArg(raw) : null
  if (!domain) throw new UsageError(usage)
  return domain
}

/** A URL argument for the page commands: a bare domain, a domain with a
 *  path, or a full URL all land on the same https URL. */
function requireUrl(raw: string | null | undefined, usage: string): string {
  if (!raw) throw new UsageError(usage)
  const trimmed = raw.trim()
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(candidate).toString()
  } catch {
    throw new UsageError(usage)
  }
}

interface ParsedArgs {
  target: string | null
  flags: Map<string, string | boolean>
}

/** Strict flag parsing: unknown flags are usage errors (agents typo → they must hear it). */
function parseArgs(args: string[], allowed: Record<string, 'boolean' | 'value'>, usage: string): ParsedArgs {
  const flags = new Map<string, string | boolean>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (!(name in allowed)) throw new UsageError(usage)
    if (allowed[name] === 'boolean') {
      if (eq !== -1) throw new UsageError(usage)
      flags.set(name, true)
    } else {
      const value = eq === -1 ? args[++i] : a.slice(eq + 1)
      if (!value || value.startsWith('--')) throw new UsageError(`--${name} needs a value\n\n${usage}`)
      flags.set(name, value)
    }
  }
  return { target: positional[0] ?? null, flags }
}

// ── Section builders ────────────────────────────────────────────────────

function fetchFailureSection(id: string, title: string, what: string, e: unknown): Section {
  return {
    id,
    title,
    checks: [{ id: 'fetch', label: 'Fetch', status: 'fail', detail: `${what} could not be fetched: ${e instanceof Error ? e.message : String(e)}` }],
  }
}

/** The AI-crawler-access verdict for a domain's robots.txt. Unreachable,
 *  absent, and unparseable files are three different verdicts — never one
 *  green "everything allowed". */
async function aiAccessSection(domain: string, io: LocalIo): Promise<Section> {
  const origin = `https://${domain}/`
  const checks: Check[] = []
  let robotsText: string | null
  try {
    // fetchRobotsText returns null ONLY for a non-2xx answer (no file);
    // network errors propagate and land in the catch below.
    robotsText = await fetchRobotsText(origin, io.fetchPage ? async (u) => io.fetchPage!(u) : undefined)
  } catch (e) {
    checks.push({ id: 'robots', label: 'robots.txt', status: 'unknown', detail: `Could not read https://${domain}/robots.txt: ${e instanceof Error ? e.message : 'network error'}` })
    return { id: 'ai-access', title: 'AI crawler access', checks }
  }

  if (robotsText == null) {
    checks.push({ id: 'robots', label: 'robots.txt', status: 'pass', detail: 'No robots.txt — every crawler is allowed by default. Nothing is blocked, and nothing declares itself either.' })
    return { id: 'ai-access', title: 'AI crawler access', checks }
  }

  const parsed = parseRobotsForAi(robotsText)
  if (!parsed) {
    checks.push({ id: 'robots', label: 'robots.txt', status: 'warn', detail: 'The response is not a robots file (HTML/challenge/empty) — crawlers cannot read your directives at all.' })
    return { id: 'ai-access', title: 'AI crawler access', checks }
  }

  if (parsed.blocked.length === 0) {
    checks.push({ id: 'ai-blocked', label: 'AI crawlers', status: 'pass', detail: `0 of ${parsed.total} known AI crawlers are whole-site blocked.` })
  } else {
    checks.push({
      id: 'ai-blocked',
      label: 'AI crawlers',
      status: 'fail',
      detail: `${parsed.blocked.length} of ${parsed.total} AI crawlers are whole-site BLOCKED: ${parsed.blocked.join(', ')}. Answer engines cannot read or cite the site.`,
      fix: 'In robots.txt, remove the whole-site "Disallow: /" groups for these agents (or set explicit "Allow: /").',
    })
  }
  checks.push({ id: 'sitemap', label: 'Sitemap', status: parsed.sitemapDeclared ? 'pass' : 'warn', detail: parsed.sitemapDeclared ? 'A Sitemap: line is declared.' : 'No Sitemap: line in robots.txt — discovery relies on links alone.', fix: parsed.sitemapDeclared ? undefined : `Add: Sitemap: https://${domain}/sitemap.xml` })
  return { id: 'ai-access', title: 'AI crawler access', checks }
}

/** The `robots` standalone: matrix + optional per-agent/per-path verdict. */
async function robotsSection(domain: string, io: LocalIo, agent: string | null, path: string | null): Promise<Section> {
  const sec = await aiAccessSection(domain, io)
  if (!agent) return sec

  const target = path ?? '/'
  let parsed: ReturnType<typeof parseRobotsRecords> = null
  try {
    const text = await fetchRobotsText(`https://${domain}/`, io.fetchPage ? async (u) => io.fetchPage!(u) : undefined)
    parsed = text != null ? parseRobotsRecords(text) : null
  } catch {
    parsed = null
  }
  if (!parsed) {
    sec.checks.push({ id: 'agent', label: `@${agent}`, status: 'unknown', detail: 'No parseable robots.txt — cannot verdict a specific agent.' })
    return sec
  }

  const records: RobotsRecord[] = parsed.records
  const v = pathAllowedFor(records, agent, target)
  if (!v.groupFound) {
    sec.checks.push({ id: 'agent', label: `@${agent}`, status: 'pass', detail: `No group for "${agent}" and no wildcard group — nothing restricts it; every path is allowed.` })
  } else if (v.allowed === false) {
    sec.checks.push({ id: 'agent', label: `@${agent}`, status: 'fail', detail: `DISALLOWED from ${target} by the "${v.matched ? `${v.matched.allow ? 'Allow' : 'Disallow'}: ${v.matched.pattern}` : 'applicable group'}" rule.` })
  } else {
    sec.checks.push({ id: 'agent', label: `@${agent}`, status: 'pass', detail: `MAY fetch ${target}${v.matched ? ` (allowed by "Allow: ${v.matched.pattern}")` : ' (no matching Disallow rule)'}.` })
  }
  return sec
}

async function mailSection(domain: string, io: LocalIo): Promise<Section> {
  try {
    const records = await probeMail(domain, io.dns ?? systemDns())
    return { id: 'mail', title: 'Email (SPF · DKIM · DMARC · MX)', checks: judgeMail(records, domain) }
  } catch (e) {
    return { id: 'mail', title: 'Email (SPF · DKIM · DMARC · MX)', checks: [{ id: 'dns', label: 'DNS', status: 'unknown', detail: `DNS lookups failed: ${e instanceof Error ? e.message : String(e)}` }] }
  }
}

/** Which sections the page fetch should produce — the composed battery runs
 *  them all; single-lens commands ask for one so the 40-link probe never
 *  runs for a `krawlup text` call. */
export interface PageParts {
  headers?: boolean
  schema?: boolean
  og?: boolean
  text?: boolean
  links?: boolean
}

async function pageSections(url: string, io: LocalIo, parts: PageParts, ua?: string): Promise<Section[]> {
  let page: FetchPageResult
  try {
    page = await fetchPage(url, io, ua ? { ua } : undefined)
  } catch (e) {
    return [fetchFailureSection('page', 'Page', url, e)]
  }

  const sections: Section[] = []
  if (parts.headers) sections.push(auditHeaders(page.headers, { status: page.status }))

  const wantsDocument = parts.schema || parts.og || parts.text
  if (wantsDocument) {
    const meta = extractMetaTags(page.body)
    const title = extractTitle(page.body)
    const description = extractMetaDescription(page.body)
    if (parts.schema) sections.push(lintSchema(page.body))
    if (parts.og) sections.push(judgeOg(collectOgFacts(meta, title, description, page.url), page.url))
    if (parts.text) sections.push(judgeText(textFacts(page.body)))
  }

  if (parts.links) {
    const links = await checkPageLinks(page.body, page.url, async (u) => {
      const r = await localFetch(u, { capBytes: 64_000, timeoutMs: 10_000 })
      return { status: r.status, hops: r.redirectChain.length, finalUrl: r.url }
    })
    sections.push(judgeLinks(links, page.url))
  }
  return sections
}

function finish(cmd: string, title: string, meta: Record<string, unknown>, sections: Section[], durationMs: number): LocalResult {
  const summary = summarize(sections)
  return { cmd, title, meta: { ...meta, durationMs }, sections, summary, exit: exitFor(summary) }
}

/** The composed battery — one command, the whole picture, markdown-ready. */
async function runCheck(domain: string, io: LocalIo): Promise<LocalResult> {
  const started = Date.now()
  const origin = `https://${domain}/`

  const [tls, ai, mail, pageSections_] = await Promise.all([
    (io.probeTls ?? probeTls)(domain, 443).catch(() => null),
    aiAccessSection(domain, io),
    mailSection(domain, io),
    pageSections(origin, io, { headers: true, schema: true, og: true, text: true, links: true }),
  ])

  const sections: Section[] = [judgeTls(tls, domain), pageSections_[0]!, ai, mail, ...pageSections_.slice(1)]
  return finish('check', `check — ${domain}`, { domain, url: origin }, sections, Date.now() - started)
}

// ── Per-command entry ───────────────────────────────────────────────────

export async function runLocalCommand(cmd: string, args: string[], io: LocalIo = {}): Promise<LocalResult> {
  const started = Date.now()
  switch (cmd) {
    case 'check': {
      const usage = 'usage: krawlup check <domain>   (e.g. krawlup check example.com)'
      const { target } = parseArgs(args, {}, usage)
      const domain = requireDomain(target, usage)
      return runCheck(domain, io)
    }
    case 'robots': {
      const usage = 'usage: krawlup robots <domain> [--agent GPTBot] [--path /blog/x]'
      const { target, flags } = parseArgs(args, { agent: 'value', path: 'value' }, usage)
      const domain = requireDomain(target, usage)
      const agent = typeof flags.get('agent') === 'string' ? (flags.get('agent') as string) : null
      const path = typeof flags.get('path') === 'string' ? (flags.get('path') as string) : null
      const sections = [await robotsSection(domain, io, agent, path)]
      return finish('robots', `robots — ${domain}`, { domain, agent, path }, sections, Date.now() - started)
    }
    case 'mail': {
      const usage = 'usage: krawlup mail <domain>   (e.g. krawlup mail example.com)'
      const { target } = parseArgs(args, {}, usage)
      const domain = requireDomain(target, usage)
      const sections = [await mailSection(domain, io)]
      return finish('mail', `mail — ${domain}`, { domain }, sections, Date.now() - started)
    }
    case 'ssl': {
      const usage = 'usage: krawlup ssl <domain>   (e.g. krawlup ssl example.com)'
      const { target } = parseArgs(args, {}, usage)
      const domain = requireDomain(target, usage)
      const probe = await (io.probeTls ?? probeTls)(domain, 443).catch(() => null)
      const sections = [judgeTls(probe, domain)]
      return finish('ssl', `ssl — ${domain}`, { domain }, sections, Date.now() - started)
    }
    case 'headers': {
      const usage = 'usage: krawlup headers <url>   (e.g. krawlup headers example.com or https://example.com/pricing)'
      const { target } = parseArgs(args, {}, usage)
      const url = requireUrl(target, usage)
      const sections = await pageSections(url, io, { headers: true })
      return finish('headers', `headers — ${url}`, { url }, sections, Date.now() - started)
    }
    case 'text': {
      const usage = 'usage: krawlup text <url> [--as-bot]   (--as-bot fetches with the GPTBot user-agent)'
      const { target, flags } = parseArgs(args, { 'as-bot': 'boolean' }, usage)
      const url = requireUrl(target, usage)
      const asBot = flags.get('as-bot') === true
      const sections = await pageSections(url, io, { text: true }, asBot ? GPTBOT_UA : undefined)
      return finish('text', `text — ${url}`, { url, asBot }, sections, Date.now() - started)
    }
    case 'schema': {
      const usage = 'usage: krawlup schema <url>   (e.g. krawlup schema example.com/pricing)'
      const { target } = parseArgs(args, {}, usage)
      const url = requireUrl(target, usage)
      const sections = await pageSections(url, io, { schema: true })
      return finish('schema', `schema — ${url}`, { url }, sections, Date.now() - started)
    }
    case 'links': {
      const usage = 'usage: krawlup links <url>   (e.g. krawlup links example.com)'
      const { target } = parseArgs(args, {}, usage)
      const url = requireUrl(target, usage)
      const sections = await pageSections(url, io, { links: true })
      return finish('links', `links — ${url}`, { url }, sections, Date.now() - started)
    }
    case 'og': {
      const usage = 'usage: krawlup og <url>   (e.g. krawlup og example.com/blog/post)'
      const { target } = parseArgs(args, {}, usage)
      const url = requireUrl(target, usage)
      const sections = await pageSections(url, io, { og: true })
      return finish('og', `og — ${url}`, { url }, sections, Date.now() - started)
    }
    case 'diff': {
      const usage = 'usage: krawlup diff <url> [--reset]   (first run stores a baseline; next run reports the drift)'
      const { target, flags } = parseArgs(args, { reset: 'boolean' }, usage)
      const url = requireUrl(target, usage)
      const dir = io.snapshotDir ?? defaultSnapshotDir()

      if (flags.get('reset') === true) {
        try {
          const page = await fetchPage(url, io)
          const snap = makeSnapshot(url, page.body)
          await saveSnapshot(dir, snap)
          return finish('diff', `diff — ${url}`, { url, reset: true, savedAt: snap.savedAt }, [{ id: 'diff', title: 'Content drift', checks: [{ id: 'snapshot', label: 'Baseline', status: 'pass', detail: 'Baseline re-stored — the next run compares against this snapshot.' }] }], Date.now() - started)
        } catch (e) {
          return finish('diff', `diff — ${url}`, { url, reset: true }, [fetchFailureSection('diff', 'Content drift', url, e)], Date.now() - started)
        }
      }

      let section: Section
      const meta: Record<string, unknown> = { url }
      try {
        const page = await fetchPage(url, io)
        const next = makeSnapshot(url, page.body)
        const prev = await loadSnapshot(dir, url)
        await saveSnapshot(dir, next)
        if (!prev) {
          section = judgeDiff(diffSnapshots(next, next), null)
          meta.savedAt = next.savedAt
          meta.baseline = true
        } else {
          const d = diffSnapshots(prev, next)
          section = judgeDiff(d, prev.savedAt)
          Object.assign(meta, { changed: d.changed, added: d.added, removed: d.removed, titleChanged: d.titleChanged, wordDelta: d.wordDelta, prevSavedAt: prev.savedAt, savedAt: next.savedAt })
        }
      } catch (e) {
        section = fetchFailureSection('diff', 'Content drift', url, e)
      }
      return finish('diff', `diff — ${url}`, meta, [section], Date.now() - started)
    }
    default:
      throw new UsageError(`unknown local command "${cmd}"`)
  }
}

// ── Renderers ───────────────────────────────────────────────────────────

const DETAIL_CAP = 240

/**
 * Human output: mark + padded label + detail, one block per section.
 * `color` defaults to TTY auto-detection so pipes and `--json`/`--md`
 * stay byte-clean; the Ink TUI renders its own structured view instead.
 */
export function renderLocalText(r: LocalResult, opts?: { color?: boolean }): string {
  const on = opts?.color ?? colorEnabled()
  const out: string[] = []
  out.push(bold(r.title, on))
  out.push(
    [
      r.summary.fail ? red(`${r.summary.fail} fail`, on) : null,
      r.summary.warn ? yellow(`${r.summary.warn} warn`, on) : null,
      r.summary.unknown ? gray(`${r.summary.unknown} unknown`, on) : null,
      r.summary.pass ? green(`${r.summary.pass} pass`, on) : null,
    ]
      .filter(Boolean)
      .join(dim(' · ', on)),
  )
  for (const sec of r.sections) {
    out.push('')
    out.push(bold(cyan(sec.title, on), on))
    for (const ch of sec.checks) {
      out.push(`  ${mark(ch.status, on)} ${ch.label.padEnd(18)}${ch.detail.slice(0, DETAIL_CAP)}`)
      if (ch.fix) out.push(`    ${dim('fix:', on)} ${cyan(ch.fix, on)}`)
    }
    if (sec.note) for (const line of sec.note.split('\n')) out.push(`  ${dim(line.slice(0, DETAIL_CAP), on)}`)
  }
  return out.join('\n')
}

/** The status glyph in its status color (green/yellow/red/gray). */
function mark(status: Check['status'], on: boolean): string {
  const preset = STATUS_COLOR[status]
  const painter = preset === 'green' ? green : preset === 'yellow' ? yellow : preset === 'red' ? red : gray
  return painter(MARKS[status], on)
}

export function renderLocalJson(r: LocalResult): string {
  return JSON.stringify(r, null, 2)
}

export function renderLocalMarkdown(r: LocalResult): string {
  const out: string[] = []
  out.push(`# krawlup ${r.title}`)
  const bits = [
    r.summary.fail ? `**${r.summary.fail} fail**` : null,
    r.summary.warn ? `${r.summary.warn} warn` : null,
    r.summary.unknown ? `${r.summary.unknown} unknown` : null,
    r.summary.pass ? `${r.summary.pass} pass` : null,
  ].filter(Boolean)
  out.push('')
  out.push(`${bits.join(' · ')} — exit ${r.exit}`)
  for (const sec of r.sections) {
    out.push('', `## ${sec.title}`, '')
    for (const c of sec.checks) {
      const mark = MARKS[c.status]
      const fix = c.fix ? ` Fix: \`${c.fix}\`.` : ''
      const detail = c.detail.replace(/\n/g, ' ').slice(0, DETAIL_CAP)
      out.push(`- ${mark} **${c.label}** — ${detail}${/[.!?…]$/.test(detail) ? '' : '.'}${fix}`)
    }
    if (sec.note) out.push('', ...sec.note.split('\n').map((l) => `> ${l}`))
  }
  return out.join('\n')
}

// ── Usage / help ────────────────────────────────────────────────────────

export const LOCAL_COMMAND_HELP: Record<string, string> = {
  check: `krawlup check <domain>
  The composed battery on one domain: TLS, security headers, email records,
  AI-crawler access (robots.txt), structured data, the social card, depth-1
  links and extractable text. --md for a shareable markdown report.
  Exit 1 = at least one concrete finding.`,
  robots: `krawlup robots <domain> [--agent GPTBot] [--path /blog/x]
  Which AI crawlers the site allows. Without flags: the whole-site matrix.
  With --agent: that agent's verdict; add --path for one URL.
  Answers "may GPTBot read this?" before an agent crawls.`,
  mail: `krawlup mail <domain>
  SPF / DKIM / DMARC / MX records with the plain-English fix for each gap.
  No DMARC and no SPF are the two most common deliverability failures.`,
  ssl: `krawlup ssl <domain>
  Certificate validity, issuer, expiry countdown and protocol version.`,
  headers: `krawlup headers <url>
  Security + cache header audit (HSTS, CSP, MIME sniffing, framing,
  referrer, COOP, caching) with the exact header to add.`,
  text: `krawlup text <url> [--as-bot]
  What an LLM sees: the page stripped to extractable text, word count and
  heading outline. --as-bot fetches with the GPTBot user-agent.`,
  schema: `krawlup schema <url>
  JSON-LD structured-data lint: types present + required properties per
  type (Organization, Product, Article, FAQPage, LocalBusiness, …).`,
  links: `krawlup links <url>
  Depth-1 broken-link check: statuses, redirect chains, mixed content.`,
  og: `krawlup og <url>
  Social-card lint: og:image/title/description, twitter:card — plus the
  exact text X/Slack will show when the link is pasted.`,
  diff: `krawlup diff <url> [--reset]
  Snapshot a page's text; every later run reports exactly what changed
  (added/removed lines, title, word count). Snapshots live in
  ~/.krawlup/snapshots/. Exit 1 when the page drifted.`,
}

export function localUsage(cmd: string): string {
  return LOCAL_COMMAND_HELP[cmd] ?? `unknown command "${cmd}"`
}
