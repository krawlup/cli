# Changelog

All notable changes to `@krawlup/cli` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/) and the package
uses [semantic versioning](https://semver.org/).

## Unreleased

### Added

- **Colored output across the CLI.** Battery marks read at a glance —
  ✓ green, ! yellow, ✗ red, – gray — with section titles bold cyan,
  `fix:` values cyan, and summary counts in their own colors. Success
  messages print green, errors red, and the login URL cyan.
- **Pace-colored loading screens** ("lower is better"): the free-report
  progress bar and elapsed clock run green while a stage is within its
  expected time, yellow up to twice over, red beyond — completed, green.
- `NO_COLOR` is honored everywhere; `FORCE_COLOR=1`/`FORCE_COLOR=0`
  forces color on or off past the TTY auto-detection. `--json` and
  `--md` output never carry escape codes, and pipes stay byte-clean.
- The interactive TUI renders battery results as a structured colored
  view (same palette) instead of pasting the plain text render.

## 1.2.1 - 2026-11-03

### Added

- **`--version` / `-v`** prints the CLI version and exits — read from
  `package.json` at runtime, and the battery's User-Agent string
  (`krawlup-cli/x.y.z`) now derives from the same source so the two can
  never drift.

## 1.2.0 - 2026-11-03

### Added

- **The local battery — ten zero-cost commands that run on your machine.**
  `krawlup check` composes the whole audit (TLS, security + cache headers,
  SPF/DKIM/DMARC/MX with the exact record to add, AI-crawler access from
  robots.txt, JSON-LD structured-data lint, the social card with the text
  X/Slack will show, depth-1 broken links with redirect chains and mixed
  content, and the extractable-text lens with `--as-bot` fetching as
  GPTBot); the spot commands (`robots`, `mail`, `ssl`, `headers`, `text`,
  `schema`, `links`, `og`) each answer one question in seconds, and
  `krawlup diff` snapshots a page and reports the exact line drift on every
  later run. No account, no key, no quota — nothing touches the API. Every
  command takes `--json`/`--md` and exits 0 clean / 1 findings / 2 usage, so
  agents and CI can gate on them. The robots parser, the strip-to-text rule
  and the broken-link probe are ports of the scanner's own logic, so a
  `krawlup` verdict matches a krawlup scan verdict on the same input, and
  every verdict is tri-state — unmeasurable reports as unknown, never as a
  false pass or fail.

- **The terminal report is now the whole report.** The free report and the
  founder insights render every stored block through one set of shared
  section components: AI readiness (llms.txt verdict, the per-agent robots
  matrix, structured-data types, FAQ, Open Graph), the conversion checks,
  the real-browser mobile layout test with capped evidence, Core Web
  Vitals + the LCP element + speed opportunities, the named trust rows
  (HTTPS redirect, TLS expiry, HSTS/CSP/X-Frame-Options, Safe Browsing,
  OG tags, the X/Slack unfurl), CrUX field data, DR/OpenPageRank, the SEO
  crawl, the 30-day screenshots as links, the cached AI First Edit card
  and bottleneck, the site's category, and a per-check status block where
  any check that did not succeed names itself. The founder `insights`
  view gained the same sections (its scorecard planes never rendered —
  the old code read a field the server never sent), and `analytics`
  gained session duration, pages/session, exit pages, acquisition
  channels, UTM sources and conversion goals (plan-gated server-side as
  the dashboard gates them).

- **Unlimited free scans for beta testers.** `krawlup report` now rides
  the CLI's session bearer on the public scan endpoints. The server
  reads it optionally: anonymous callers keep the 1-scan/month device
  pool, while a signed-in founder on the beta allowlist scans without a
  quota. A token is only ever sent to the API base it was minted for,
  and a dead session degrades to the anonymous device pool.

- **The free report renders everything the server actually sent.** The
  axis rows use the site's own naming (Speed, Search & AI, Conversion)
  with the primary bottleneck marked, and the block gains the rows the
  web hero and Search & AI tab show: Ahrefs Authority (DR, integer
  convention, ▲/▼ only from a real previous value), the Trust &
  security pass counts, OpenPageRank (score · global rank · referring
  domains), Lighthouse accessibility/best-practices/SEO, CrUX field
  factors per device side, the five-plane scorecard breakdown, and the
  cross-provider open findings (status-chipped, URL or provider
  evidence as the detail line). A number the server never sent never
  renders — rows drop out or say "Not checked" instead.

### Changed

- **The free-scan allowance is read from the server, not baked in.** The
  per-device monthly pool is now an admin setting
  (*Settings ▸ Free Site Scanning ▸ Free scans per device / month*), so
  the CLI fetches it from `GET /api/tools/public-insights/scan-config`
  at startup and renders that number in the help text, the menu hint,
  the report footer and its quota refusals. A failed read degrades to
  "checking…" instead of inventing a figure. The pool ships at `0` (off)
  unless an admin grants one; signed-in beta testers are still told
  "unlimited", and a device whose pool is spent is not misreported as
  having never been granted one.
- **Consistent vertical rhythm across the TUI.** Rendered blocks are
  separated by one blank line, block and section headings sit on the
  same two-space gutter as their rows, the live scan screen groups its
  checklist, pacing bar and caption with real gaps, and the duplicate
  spinner/esc hint above a running scan is gone.
- **Tables size to their content** instead of stretching to fixed caps,
  and numeric columns right-align — narrow terminals stay readable
  instead of truncating values mid-number.
- **The signed-out menu steps aside while a report is on screen.** The
  free site report (or its refusal/error) renders alone with a single
  `back` pick — or esc — to return to the menu, instead of the four
  options crowding beneath the result.
- **Bar lists and score stacks share one column.** Labels pad to the
  widest label in the block (long ones ellipsize at 28 cells) so the
  bars and numbers start at the same offset instead of staggering down
  the screen.

### Fixed

- Help and the command list claimed the CLI gets 2 free scans per device
  per month; the device cap is 1 (browsers get 2).
- The TUI command list kept promising a "free full site scan" right next
  to its own "(no free CLI scans right now)". The lead is now one shared
  phrase (`reportLeadPhrase`) that the help screen and the command list
  both build from, so they can never disagree again.
- Both domain doors — the argv `report` command and the TUI domain input
  — share one normalizer: `http://` is stripped like `https://`, trailing
  slashes go, and anything that still cannot be a bare host (a path,
  whitespace) is refused instead of sent to the server as a key.
- A malformed TLS expiry date is excluded from the Trust & security pass
  count instead of being scored as a failing check, and the pacing bar
  reads its stage spans from the pacing it was handed.

The first npm release: an interactive terminal client for your krawlup
account — and it runs the free site report before any sign-in.

- **Browser login (OAuth 2.1 + PKCE)** — no API keys. One consent in the
  browser grants read / scans / listing management; refresh tokens
  rotate silently; revoke from the dashboard or `krawlup logout`.
- **Interactive mode** — a streaming prompt with slash commands, tab
  completion and input history; results render into your scrollback.
- **Live product pane** — `/open` opens a redraw-in-place tabbed view:
  overview, insights, analytics, keywords, scan history.
- **Everything your dashboard has, over the same data path**: portfolio
  table, website analytics (realtime visitors, AI crawls, conversions),
  keyword rank boards + research, rescans with budget readouts,
  publishing, analytics snippets, excluded pages.
- **One-shot mode** — every command works non-interactively, `--json`
  included, so scripts and CI get the same surface.
- **`krawlup report <domain>`** runs the exact flow the public
  /site-report page runs — refresh → live stage polling → stored report
  — keyed by the CLI's own device id (`~/.krawlup/device-id`), with no
  account: the per-device pool is a server setting the CLI reads and
  reports at run time (the web page's browser-cookie pool is its own
  number; a shared per-IP backstop bounds every run); every report read
  afterwards is free and unlimited. No login, no OAuth.
- **A live scan screen** mirrors the web panel's own checklist: the six
  real stages (queue wait → capture → Crux field data → Lighthouse →
  scoring → history), a pacing bar that holds under 100% until the
  report actually lands, queue position while waiting for a scan slot,
  and `esc` to stop waiting without stopping the scan — it keeps
  running on krawlup.com and any later `krawlup report <domain>` call
  reads the stored result for free.
- **The full interactive report block**: the overall score, band and
  verdict, scorecards, the issue list with severities, broken-link
  results, Lighthouse and Crux context; narrow terminals shrink to fit.
  `--md` downloads the site's markdown export; `--json` prints the raw
  payload. Every refusal (quota exhausted, listed domain, rate limit)
  surfaces as the server's own sentence, unedited.
- **Hardened from a full adversarial audit** — the browser actually opens
  at login (printed-URL fallback when it cannot) and consents under the
  server's first-party `krawlup-cli` client, forged loopback
  callbacks are refused via the OAuth state check, scan refusals surface
  instantly instead of polling, esc stops waiting on a running scan,
  tables shrink to fit narrow terminals, session writes are atomic, and
  `--json` errors print as JSON.
- Removed: the vendored local audit engine and its CI action. All
  scores now come from krawlup.com itself — identical to the website,
  by construction.
