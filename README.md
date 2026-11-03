<div align="center">

<img src="assets/wordmark.svg" alt="krawlup" width="460" />

**krawl** everything up — [krawlup.com](https://krawlup.com)

</div>

# Official CLI for krawlup — manage products, insights and analytics from the terminal, with a free no-account site battery.

An interactive, streaming CLI for [krawlup.com](https://krawlup.com):
your products, scan scores, website analytics, keyword boards and
rescans — without leaving the terminal. Sign in once with your browser
(OAuth); everything after that is plain text at typing speed.

Runs on **Node.js** (≥ 18) or **Bun** (≥ 1.2).

## Quick Start (Zero Install)

Run directly with your preferred package runner:

```bash
# npm / npx
npx @krawlup/cli

# Bun
bunx @krawlup/cli

# pnpm
pnpm dlx @krawlup/cli

# Yarn
yarn dlx @krawlup/cli
```

## Global Installation

Install globally to make the `krawlup` binary available everywhere:

```bash
# npm
npm install -g @krawlup/cli

# Bun
bun install -g @krawlup/cli

# pnpm
pnpm add -g @krawlup/cli

# Yarn
yarn global add @krawlup/cli
```

Once installed, just type:

```bash
krawlup
```

## What it does

`krawlup` boots to a welcome screen — the krawlup wordmark drawn as
ASCII art from the actual brand logo — with a select menu (portfolio,
products, open/scan a product, subscription…) that drops you straight
into the result. From there you're at a prompt with slash commands
(tab completes, ↑↓ recalls). Results stream into your normal
scrollback — nothing takes over the screen.

| Command | What you get |
|---|---|
| `/overview [range] [sort]` | portfolio table: visitors, views, revenue, scores — sort and range cycling |
| `/report <domain>` | **FREE full site scan + report — no login needed** (see below) |
| `/check <domain>` | **local battery — TLS, headers, mail, AI access, schema, links, OG, text (no account)** |
| `/robots <domain>` / `/mail <domain>` | AI-crawler verdicts / email records — local, no account |
| `/diff <url>` | page drift snapshots — local, no account |
| `/products` | every product, public and private |
| `/open <product>` | the live pane: redraw-in-place tabs — overview, insights, analytics, keywords, history |
| `/insights <p>` | overall score, issues, First Edit, fix cards |
| `/analytics <p> [range]` | totals + deltas, daily chart, top pages/referrers/countries/devices, realtime visitors, AI crawls |
| `/keywords <p>` | rank board with trends, stored ideas with verdicts |
| `/research <p> [seed]` | run keyword research (spends a monthly run — asks first) |
| `/scan <p>` | trigger a full re-scan and wait, streaming progress |
| `/add <url>` | readiness check + add a product |
| `/publish <p>` / `/unpublish <p>` | directory visibility |
| `/snippet <p>` | the analytics tag + excluded paths |
| `/exclude <p> /a /b` | replace the excluded pages board (`none` clears) |
| `/subscription` | plan, status, usage meters |

Everything the terminal shows comes straight from your krawlup
account's own reports — same numbers, no re-scoring, no drift.

## The free site report (no login)

```bash
krawlup report example.com       # full scan + interactive report, nothing to sign up for
krawlup report example.com --md  # same report as the site's markdown export
krawlup report example.com --json
```

This is the same flow the public [/site-report](https://krawlup.com/site-report)
page runs, keyed by the CLI's own device id (`~/.krawlup/device-id`)
instead of a browser cookie:

- **The per-device pool is a server setting, not a CLI constant.** The
  CLI reads its allowance from the API at startup and prints whatever is
  in force — the admin panel's
  *Settings ▸ Free Site Scanning ▸ Free scans per device / month*, which
  ships at `0` (no free CLI pool). The browser page's cookie pool is its
  own number, and the shared per-IP backstop still bounds every run. No
  account required to try; when the pool is off the refusal says so.
- **Beta testers scan without a limit.** Sign in with `krawlup login`
  before `krawlup report`; when your account is on the beta allowlist,
  the CLI rides your session on the public endpoints and the server
  waives the device quota (reads were already unlimited) — including
  while the device pool is switched off for everyone else.
- **Every report read is free and unlimited** — once a scan has run, the
  stored report (and its markdown export) never costs anything again.
- A **live scan screen** walks the real stages — queue wait → page
  capture → real-user field data → Lighthouse → scoring → saving — with
  a pacing bar that never claims 100% before the report exists, and
  tesc to stop waiting while the scan itself keeps running server-side.
- The report block is the site's own numbers: overall score, band,
  verdict, scorecards, issues with severities, broken links, Lighthouse
  and Crux context. Every server refusal (quota, listed domain, rate
  limit) prints as that server's exact sentence.

## Local checks (no account, no API)

Ten commands that run entirely on **your machine** — no login, no key, no
quota, nothing touches krawlup's servers. Each takes `--json` (and `--md`
for markdown), and exits `0` when clean, `1` when a concrete finding was
measured, `2` on a usage mistake — so scripts and agents can gate on them.

```bash
krawlup check example.com        # the full battery: TLS, headers, mail records,
                                 # AI access, schema, social card, links, text
krawlup check example.com --md   # same report as shareable markdown
krawlup robots example.com --agent GPTBot --path /blog/x   # "may GPTBot read this?"
krawlup mail example.com         # SPF / DKIM / DMARC / MX with the fix for each gap
krawlup ssl example.com          # certificate expiry, issuer, protocol
krawlup headers example.com      # HSTS / CSP / framing / caching with exact fixes
krawlup text example.com         # what an LLM sees (--as-bot fetches as GPTBot)
krawlup schema example.com       # JSON-LD lint: types + required properties
krawlup links example.com        # broken links, redirect chains, mixed content
krawlup og example.com/blog/post # social-card lint + the text X/Slack will show
krawlup diff example.com         # snapshot a page; every later run reports the drift
```

What each one is for:

- **check** — one command before a launch, a redesign, or a client call.
  Everything the spot commands measure, composed, shareable.
- **robots** — nobody else's CLI answers "is GPTBot allowed here?" before
  an agent crawls. Same parser as the krawlup scanner, so the verdicts match.
- **mail** — missing DMARC and SPF are the two most common real
  deliverability failures; this names them in five seconds with the exact
  DNS record to add.
- **diff** — watch your own (or a competitor's) page between monthly
  scans: first run stores a baseline in `~/.krawlup/snapshots/`, later runs
  print added/removed lines, title changes and word deltas, exit 1 on drift.

`check` needs a minute (it probes up to 40 links); the spot commands are
seconds. Every verdict is tri-state: something that could not be measured
(blocked fetch, DNS failure) reports as *unknown*, never as a pass or a fail.

## Login

`krawlup login` (or `npx @krawlup/cli login`) opens your browser: you approve the **Krawlup TUI**
connection once (read your data, start scans, manage listings — the
consent screen lists exactly that), and the terminal picks the tokens
up on a localhost callback. Tokens rotate automatically and sit at
`~/.krawlup/session.json` (mode 0600). Revoke any time from the
dashboard's **Agent access** page, or `krawlup logout`.

In CI (or anywhere a browser is awkward), `KRAWLUP_KEY` with an agent
key from the same page works as a static escape hatch, and
`KRAWLUP_API` moves the API base (a local dev API is exempt from the
https-only rule).

## Scriptable too

Every command runs one-shot outside interactive mode. Perfect for scripts, CI pipelines, or AI agents:

```bash
# With global install:
krawlup insights myapp.com
krawlup analytics myapp.com 30d --json
krawlup scan myapp.com
krawlup report example.com        # the free one — no login needed

# Or directly with npx / bunx:
npx @krawlup/cli overview
npx @krawlup/cli insights myapp.com
npx @krawlup/cli analytics myapp.com 30d --json
bunx @krawlup/cli scan myapp.com
```

Same renderers, `--json` for machines, honest exit codes (2 = not
logged in, 1 = the server refused — its sentence is printed verbatim).

## Agents

Point any MCP client at krawlup's own MCP server (`https://api.krawlup.com/mcp`)
— the terminal and your agent read the same tools.

## License

[MIT](./LICENSE)
