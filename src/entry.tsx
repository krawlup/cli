#!/usr/bin/env node
/**
 * krawlup — your krawlup account in the terminal.
 *
 * TTY: the interactive app (prompt, slash commands, live pane).
 * Non-TTY or with argv: one-shot command mode — same actions, same
 * renderers, no prompt. `--json` prints the raw tool payloads instead.
 */
import React from 'react'
import { render } from 'ink'
import { App } from './ui/app.js'
import { ActionView } from './ui/render.js'
import { PublicScanProgress } from './ui/public-report.js'
import * as actions from './actions.js'
import { fetchPublicReportMd } from './api/public-scan.js'
import { runLogin, runLogout } from './api/login.js'
import { ReLoginRequired, ToolError } from './api/rpc.js'
import { getSession } from './api/session.js'
import type { ActionResult } from './actions.js'
import { refreshScanConfig, scanConfig } from './state/scan-config.js'
import { reportLeadPhrase, scanAllowance, type ScanConfig } from './lib/scan-allowance.js'
import { normalizeDomainArg } from './lib/domain.js'
import {
  localUsage,
  renderLocalJson,
  renderLocalMarkdown,
  renderLocalText,
  runLocalCommand,
  UsageError,
} from './commands/local.js'
import type { PublicScanState } from './api/public-scan.js'

const LOCAL_HELP_BLOCK = `
  Local checks — run on YOUR machine, no account, no API, no quota
  (--json everywhere; exit 1 = findings, so agents can gate on them):

  krawlup check <domain>        the full battery: TLS, headers, mail records,
                                AI access, schema, social card, links, text
  krawlup robots <domain>       which AI crawlers may read the site
                                (--agent GPTBot --path /blog/x for one verdict)
  krawlup mail <domain>         SPF / DKIM / DMARC / MX with fixes
  krawlup ssl <domain>          certificate expiry + issuer
  krawlup headers <url>         security + cache headers with fixes
  krawlup text <url>            what an LLM sees (--as-bot fetches as GPTBot)
  krawlup schema <url>          JSON-LD structured-data lint
  krawlup links <url>           broken links, redirect chains, mixed content
  krawlup og <url>              social-card lint (what X/Slack will show)
  krawlup diff <url>            snapshot a page; next run reports the drift
`

const argv = process.argv.slice(2)
const interactive = !!process.stdout.isTTY && !!process.stdin.isTTY && argv.length === 0

/**
 * The help text. The free-report line quotes the allowance the SERVER reports
 * (an admin setting), so it is built per run instead of baked into a constant:
 * a literal "1/month" here would keep advertising a number the reserve
 * pipeline no longer enforces.
 */
function helpText(cfg: ScanConfig): string {
  const allowance = scanAllowance(cfg)
  const reportLead = reportLeadPhrase(cfg)
  return `krawlup — your krawlup account in the terminal

  krawlup                  interactive mode (requires a terminal)
  krawlup help             this screen (also: --help, -h, or bare krawlup)
  krawlup login            sign in with your browser (OAuth)
  krawlup logout           revoke + forget this session
  krawlup report <domain>  ${reportLead}, no login (${allowance}; --md for markdown)
                           signed-in beta testers scan without a limit

  krawlup overview [range] [sort]     portfolio table
  krawlup products                    list products
  krawlup insights <product>          scores, issues, fix cards
  krawlup analytics <product> [range] website analytics (today|7d|30d)
  krawlup keywords <product>          rank board + ideas
  krawlup history <product>           last 100 scans
  krawlup scan <product>              trigger a full re-scan and wait
  krawlup track <product> <kw…>       add keywords to the rank board
  krawlup untrack <product> <kw…>     remove keywords from the board
  krawlup research <product> [seed]   run keyword research (spends a monthly run)
  krawlup exclude <product> <paths…>  replace the excluded pages board
  krawlup add <url>                   readiness-check + add a product
  krawlup publish <product>           public in the directory
  krawlup unpublish <product>         private
  krawlup snippet <product>           analytics tag
  krawlup subscription                plan, status, usage
${LOCAL_HELP_BLOCK}
  --json                   machine-readable output on data commands
  --help, -h               this page

'krawlup report' needs no account: your device id (~/.krawlup/device-id)
carries the free quota — ${allowanceText(cfg)} — and every report read
afterwards is free and unlimited. The browser page's cookie pool is its own
number (${cfg.loaded ? `${cfg.webScansPerMonth}/month` : 'reported separately'}).
Sign in with 'krawlup login' and, if your account is on the beta allowlist,
free scans run without a limit.

Runs on Node.js (≥18) or Bun (≥1.2). The API base defaults to
https://krawlup.com (KRAWLUP_API overrides; KRAWLUP_KEY uses a static
agent key instead of the browser login).`
}

/** The allowance as a sentence fragment for running prose. */
function allowanceText(cfg: ScanConfig): string {
  if (cfg.betaUnlimited) return 'unlimited, because this account is on the beta allowlist'
  if (!cfg.loaded) return 'the current allowance is checked on every run'
  if (cfg.cliScansPerMonth === 0) return 'no free scans are switched on right now'
  if (cfg.cliScansPerMonth === 1) return '1 full scan per month'
  return `${cfg.cliScansPerMonth} full scans per month`
}

async function renderOnce(result: ActionResult): Promise<void> {
  // One-shot mode: render the block, let Ink flush, then unmount — Ink
  // never exits on its own and waitUntilExit would hang without this.
  const instance = render(<ActionView result={result} />, { exitOnCtrlC: true })
  await new Promise((r) => setTimeout(r, 80))
  instance.unmount()
  await instance.waitUntilExit()
}

async function argvMode(): Promise<void> {
  // Flags are stripped before the command word so `krawlup --json` is
  // "help", not "unknown command --json".
  const positional = argv.filter((a) => a !== '--json' && a !== '--md')
  const cmd = (positional[0] ?? 'help').toLowerCase()
  const args = positional.slice(1)
  const wantsJson = argv.includes('--json')

  try {
    switch (cmd) {
      case 'help':
      case '--help':
      case '-h':
        // Help is the one place the allowance is worth a round trip: fetch it
        // first (best-effort, 8s), then print whatever the server reports.
        await refreshScanConfig()
        console.log(helpText(scanConfig.get()))
        return
      case 'login': {
        const out = await runLogin({
          apiBase: args[0],
          onUrl: (url, opened) =>
            console.log(opened ? `opening your browser — if it did not, sign in at: ${url}` : `sign in: ${url}`),
        })
        console.log(`✓ signed in → ${out.api} (session stored at ~/.krawlup/session.json)`)
        // A beta tester's allowance changes on sign-in — quote the new one.
        await refreshScanConfig(out.api)
        if (scanConfig.get().betaUnlimited) console.log('✓ beta tester — free scans are unlimited on this account')
        return
      }
      case 'logout':
        await runLogout()
        console.log('✓ signed out')
        return
      case 'report': {
        const domain = args[0] ? normalizeDomainArg(args[0]) : null
        if (!domain) {
          console.error('usage: krawlup report <domain>   (e.g. krawlup report example.com — no login needed)')
          process.exitCode = 2
          return
        }
        const wantsMd = argv.includes('--md')
        // Fetch the allowance first so a refusal (or --md header) quotes the
        // number the server enforces; a failed read just leaves it unknown.
        await refreshScanConfig()
        let lastLabel = ''
        function initialScanState(): PublicScanState {
          return {
            phase: 'requesting',
            stageIdx: 0,
            stageLabel: 'Waiting for a free scan slot',
            stageNote: 'Asking krawlup.com whether this device still has free scans.',
            stageStartMs: Date.now(),
            elapsedSec: 0,
            barPct: 0,
            queuePosition: null,
          }
        }

        let result: ActionResult
        if (process.stdout.isTTY) {
          // TTY: the full live scan screen (checklist + pacing bar), redrawn
          // on every poll, then the finished report block below it. esc
          // stops the WAIT (never the scan) via the crash AbortController.
          const abort = new AbortController()
          const live = render(
            <PublicScanProgress state={initialScanState()!} showEscHint onEsc={() => abort.abort()} />,
            { exitOnCtrlC: true },
          )
          try {
            result = await actions.publicReportAction(domain, (state) => {
              live.rerender(<PublicScanProgress state={state} showEscHint onEsc={() => abort.abort()} />)
            }, { signal: abort.signal })
          } finally {
            abort.abort()
            live.unmount()
            await live.waitUntilExit().catch(() => {})
          }
        } else {
          result = await actions.publicReportAction(
            domain,
            (state: PublicScanState) => {
              // Piped output can't redraw in place: one line per stage change.
              if (state.stageLabel !== lastLabel) {
                lastLabel = state.stageLabel
                console.error(
                  `⏳ ${lastLabel}${state.queuePosition != null ? ` — position ${state.queuePosition}` : ''}${state.phase === 'done' ? ' ✓' : '…'}`,
                )
              }
            },
          )
        }

        if (result.kind !== 'public-report') return
        if (wantsJson) {
          console.log(JSON.stringify({ domain: result.domain, report: result.report }, null, 2))
          return
        }
        if (wantsMd) {
          console.log(await fetchPublicReportMd(result.domain))
          return
        }
        await renderOnce(result)
        return
      }
      case 'check':
      case 'robots':
      case 'mail':
      case 'ssl':
      case 'headers':
      case 'text':
      case 'schema':
      case 'links':
      case 'og':
      case 'diff': {
        // Local battery — no session, no API. Per-command --help prints the
        // command's own manual; findings drive the exit code.
        if (args.includes('--help') || args.includes('-h')) {
          console.log(localUsage(cmd))
          return
        }
        let result
        try {
          result = await runLocalCommand(cmd, args)
        } catch (e) {
          if (e instanceof UsageError) {
            console.error(e.message)
            process.exitCode = 2
            return
          }
          throw e
        }
        if (wantsJson) console.log(renderLocalJson(result))
        else if (argv.includes('--md')) console.log(renderLocalMarkdown(result))
        else console.log(renderLocalText(result))
        process.exitCode = result.exit
        return
      }
      default:
        break
    }

    // Everything below needs a session.
    const session = getSession()
    if (!session) {
      console.error('not logged in — run `krawlup login` first')
      process.exitCode = 2
      return
    }

    const jsonOut = async (result: ActionResult): Promise<void> => {
      if (result.kind === 'text') {
        console.log(result.text)
        return
      }
      const { kind, ...data } = result
      console.log(JSON.stringify(data, null, 2))
    }

    switch (cmd) {
      case 'overview': {
        const result = await actions.overviewAction(args)
        if (wantsJson) await jsonOut(result)
        else await renderOnce(result)
        return
      }
      case 'products': {
        const result = await actions.productsAction()
        if (wantsJson) await jsonOut(result)
        else await renderOnce(result)
        return
      }
      case 'subscription': {
        const result = await actions.subscriptionAction()
        if (wantsJson) await jsonOut(result)
        else await renderOnce(result)
        return
      }
      case 'insights':
      case 'analytics':
      case 'keywords':
      case 'history':
      case 'snippet':
      case 'scan':
      case 'publish':
      case 'unpublish':
      case 'research':
      case 'track':
      case 'untrack': {
        const query = args[0]
        if (!query) {
          console.error(`usage: krawlup ${cmd} <product>${cmd === 'track' || cmd === 'untrack' ? ' <keyword…>' : ''}`)
          process.exitCode = 2
          return
        }
        const product = (await actions.resolveProduct(query)) ?? (args.length > 1 && cmd !== 'track' && cmd !== 'untrack' ? await actions.resolveProduct(args.join(' ')) : null)
        if (!product) {
          console.error(`no product matches "${query}" — \`krawlup products\` lists them`)
          process.exitCode = 2
          return
        }
        let result: ActionResult
        switch (cmd) {
          case 'analytics': {
            const range = (['today', '7d', '30d'] as const).find((r) => args.includes(r)) ?? '7d'
            result = await actions.analyticsAction(product, range)
            break
          }
          case 'keywords':
            result = await actions.keywordsAction(product, true)
            break
          case 'history':
            result = await actions.historyAction(product)
            break
          case 'snippet':
            result = await actions.snippetAction(product)
            break
          case 'scan':
            result = await actions.scanAction(product, (update) => {
              if (process.stderr.isTTY) console.error(update.pending ? '⏳ scan running…' : '⏳ scan finished')
            })
            break
          case 'publish':
            result = await actions.visibilityAction(product, true)
            break
          case 'unpublish':
            result = await actions.visibilityAction(product, false)
            break
          case 'research':
            result = await actions.researchAction(product, args[1])
            break
          case 'track':
          case 'untrack': {
            const kws = args.slice(1).filter((k) => k && k !== 'none')
            if (!kws.length) {
              console.error(`usage: krawlup ${cmd} <product> <keyword…>`)
              process.exitCode = 2
              return
            }
            result = await actions.trackAction(product, kws, cmd === 'untrack')
            break
          }
          default:
            result = await actions.insightsAction(product)
        }
        if (wantsJson) await jsonOut(result)
        else await renderOnce(result)
        return
      }
      case 'add': {
        const url = args[0]
        if (!url) {
          console.error('usage: krawlup add <url>')
          process.exitCode = 2
          return
        }
        const result = await actions.addAction(url)
        if (wantsJson) await jsonOut(result)
        else await renderOnce(result)
        return
      }
      case 'exclude': {
        const rawPaths = args.slice(1)
        if (!args[0] || !rawPaths.length) {
          console.error('usage: krawlup exclude <product> /path1 /path2… (or "none" to clear)')
          process.exitCode = 2
          return
        }
        const product = await actions.resolveProduct(args[0]!)
        if (!product) {
          console.error(`no product matches "${args[0]}" — \`krawlup products\` lists them`)
          process.exitCode = 2
          return
        }
        const paths = rawPaths[0] === 'none' ? [] : rawPaths.map((p) => (p.startsWith('/') ? p : `/${p}`))
        const result = await actions.excludeAction(product, paths)
        if (wantsJson) await jsonOut(result)
        else await renderOnce(result)
        return
      }
      default:
        console.error(`unknown command "${cmd}"\n\n${helpText(scanConfig.get())}`)
        process.exitCode = 2
    }
  } catch (e) {
    const msg = e instanceof ToolError || e instanceof ReLoginRequired ? e.message : e instanceof Error ? e.message : String(e)
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ error: true, message: msg }, null, 2))
    } else {
      console.error(`✗ ${msg}`)
    }
    process.exitCode = e instanceof ReLoginRequired ? 2 : 1
  }
}

if (interactive) {
  const instance = render(<App />, { exitOnCtrlC: true })
  instance.waitUntilExit().catch(() => {})
} else {
  void argvMode()
}
