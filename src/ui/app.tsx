/**
 * The interactive app: an always-present bottom prompt with slash commands
 * (tab completion, input history), a streamed history of rendered blocks
 * (Ink Static — frozen output above, live UI below), and the product live
 * pane. Claude Code's shape: streaming CLI, not a full-screen takeover.
 */
import { Box, Static, Text, useApp, useInput } from 'ink'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api/commands.js'
import { runLogin, runLogout } from '../api/login.js'
import { ReLoginRequired, ToolError } from '../api/rpc.js'
import { getSession } from '../api/session.js'
import { PublicScanError, ScanAborted } from '../api/public-scan.js'
import type { PublicScanState } from '../api/public-scan.js'
import * as actions from '../actions.js'
import type { ActionResult } from '../actions.js'
import type { ProductStatus } from '../api/types.js'
import { SPLIT_NARROW, SPLIT_WIDE, WORDMARK_NARROW, WORDMARK_WIDE } from './banner.js'
import { LocalResultView, Spinner, useTerminalColumns } from './components.js'
import { LivePane } from './live-pane.js'
import { ActionView } from './render.js'
import { PublicScanProgress } from './public-report.js'
import { invalidate } from '../state/store.js'
import { refreshScanConfig, useScanConfig } from '../state/scan-config.js'
import { reportLeadPhrase, scanAllowance, scanAllowanceDetail, type ScanConfig } from '../lib/scan-allowance.js'
import { normalizeDomainArg } from '../lib/domain.js'
import { localUsage, runLocalCommand, UsageError } from '../commands/local.js'

/**
 * The command list. The report line quotes the FREE-SCAN ALLOWANCE the server
 * reports (state/scan-config.ts) — the per-device pool is an admin setting, so
 * a hardcoded "1/month" here would be a lie the moment it changes.
 */
function commandList(cfg: ScanConfig): Array<[string, string]> {
  return [
  ['help', 'show every command'],
  ['report <domain>', `${reportLeadPhrase(cfg)} — no account needed (${scanAllowanceDetail(cfg)})`],
  ['check <domain>', 'local battery — TLS, headers, mail, AI access, schema, links, OG, text (no account)'],
  ['robots <domain>', 'which AI crawlers may read the site (no account)'],
  ['mail <domain>', 'SPF / DKIM / DMARC / MX with fixes (no account)'],
  ['diff <url>', 'snapshot a page; next run reports the drift (no account)'],
  ['overview [range] [sort]', 'portfolio table — range: lifetime|today|7d|30d|90d, sort: visitors|views|revenue|score|…'],
  ['products', 'list your products (public + private)'],
  ['open <product>', 'open the live product pane (tabs: overview, insights, analytics, keywords, history)'],
  ['insights <product>', 'print scores, issues, first edit, fix cards'],
  ['analytics <product> [range]', 'print website analytics — range: today|7d|30d'],
  ['keywords <product>', 'rank board + stored ideas'],
  ['research <product> [seed]', 'run keyword research — spends a monthly run'],
  ['track <product> <kw…>', 'add keywords to the rank board'],
  ['untrack <product> <kw…>', 'remove keywords from the board'],
  ['history <product>', 'last 100 scans as a trend'],
  ['scan <product>', 'trigger a full re-scan and wait for it (spends your budget)'],
  ['add <url>', 'readiness-check + add a product'],
  ['publish <product>', 'make a product public in the directory'],
  ['unpublish <product>', 'make a product private'],
  ['snippet <product>', 'show the analytics tag + excluded paths'],
  ['exclude <product> <paths…>', 'replace the excluded pages board ("none" clears)'],
  ['subscription', 'plan, status and usage meters'],
  ['login', 'sign in via the browser (OAuth)'],
  ['logout', 'revoke + forget this session'],
  ['clear', 'clear the screen history'],
  ]
}

export interface HistoryItem {
  id: number
  /** Rendered-out blocks tombstone to null — see push(). */
  element: React.ReactElement | null
}

/**
 * <Static> is index-tracked: its internal cursor follows items.length, so
 * the history array must only ever GROW or be RESET — shifting it would
 * re-render old blocks as new. The element window caps real memory:
 * entries older than ELEMENT_CAP keep their slot but release their React
 * element, and the array compacts wholesale at the hard cap.
 */
const HISTORY_ELEMENT_CAP = 200
const HISTORY_HARD_CAP = 1000

function HelpBlock({ commands }: { commands: Array<[string, string]> }) {
  return (
    <Box flexDirection="column">
      <Text bold>{'  '}Commands</Text>
      {commands.map(([cmd, desc]) => (
        <Text key={cmd}>
          {'  '}
          <Text color="cyan">/{cmd}</Text>
          <Text dimColor> — {desc}</Text>
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>{'  '}tab completes · ↑↓ input history · ctrl+c exits</Text>
      </Box>
    </Box>
  )
}

function Header({ subscription, error }: { subscription: any | null; error: string | null }) {
  if (error) return <Text dimColor>  signed in · {error}</Text>
  if (!subscription) return <Spinner label="loading your account…" />
  const plan = subscription.plan?.name ?? '—'
  const status = subscription.status ?? '—'
  return (
    <Text>
      {'  '}
      <Text bold>krawlup</Text>
      <Text dimColor> · </Text>
      <Text color={status === 'active' ? 'green' : 'yellow'}>
        {plan} ({status})
      </Text>
      <Text dimColor> · /help for commands</Text>
    </Text>
  )
}

/** Bottom prompt: a hand-rolled line editor with slash + product completion. */
function Prompt({
  onSubmit,
  productNames,
  commands,
  disabled,
}: {
  onSubmit: (value: string) => void
  productNames: string[]
  commands: Array<[string, string]>
  disabled: boolean
}) {
  const [value, setValue] = useState('')
  const [lineHistory, setLineHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState<number | null>(null)

  const completions = React.useMemo(() => {
    if (!value.startsWith('/')) return []
    const body = value.slice(1)
    const spaceAt = body.indexOf(' ')
    if (spaceAt === -1) {
      return commands.map(([c]) => `/${c.split(' ')[0]}`).filter((c) => c.startsWith(`/${body}`) && c !== `/${body}`)
    }
    // past the command word: complete the argument with a product name
    const last = body.slice(spaceAt + 1)
    if (!last) return []
    const stem = value.slice(0, value.length - last.length)
    const match = productNames.find((p) => p.toLowerCase().startsWith(last.toLowerCase()))
    return match ? [stem + match] : []
  }, [value, productNames, commands])

  useInput(
    (input, key) => {
      if (key.return) {
        const v = value.trim()
        if (v) setLineHistory((h) => [v, ...h].slice(0, 100))
        setHistIdx(null)
        setValue('')
        onSubmit(v)
        return
      }
      if (key.tab) {
        if (completions.length === 1) setValue(`${completions[0]} `)
        else if (completions.length > 1) {
          let prefix = completions[0]!
          for (const c of completions) {
            while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1)
          }
          setValue(prefix)
        }
        return
      }
      if (key.upArrow) {
        if (!lineHistory.length) return
        const next = histIdx == null ? 0 : Math.min(histIdx + 1, lineHistory.length - 1)
        setHistIdx(next)
        setValue(lineHistory[next] ?? '')
        return
      }
      if (key.downArrow) {
        if (histIdx == null) return
        const next = histIdx - 1
        setHistIdx(next < 0 ? null : next)
        setValue(next < 0 ? '' : lineHistory[next] ?? '')
        return
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta || key.escape || key.pageUp || key.pageDown || key.return) return
      if (input) setValue((v) => v + input)
    },
    { isActive: !disabled },
  )

  return (
    <Box flexDirection="column">
      {completions.length > 1 ? (
        <Box flexDirection="column">
          {completions.slice(0, 6).map((c) => (
            <Text key={c} dimColor>
              {'  '}
              {c}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text>
        {'  '}
        <Text color="cyan" bold>
          {'> '}
        </Text>
        {value}
        <Text inverse> </Text>
      </Text>
    </Box>
  )
}

interface PendingConfirm {
  label: string
  run: () => Promise<void>
}

export function App(): React.ReactElement {
  const { exit } = useApp()
  const [history, setHistory] = useState<HistoryItem[]>([])
  const idRef = useRef(1)
  /** Synchronous double-fire guard — React state flips land a render too late. */
  const busyRef = useRef(false)
  const scanAbortRef = useRef<AbortController | null>(null)
  const [sessionApi, setSessionApi] = useState<string | null>(getSession()?.api ?? null)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [loginOpened, setLoginOpened] = useState(false)
  const [loggingIn, setLoggingIn] = useState(false)
  const [subscription, setSubscription] = useState<any | null>(null)
  const [subError, setSubError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pane, setPane] = useState<{ key: string; title?: string } | null>(null)
  const [productNames, setProductNames] = useState<string[]>([])
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const [showWelcome, setShowWelcome] = useState(true)
  // The free site report: a LIVE progress block (replaced on every poll)
  // plus an optional domain prompt used by the pre-auth/welcome entry
  // points — one flow, three doors.
  const [publicScan, setPublicScan] = useState<PublicScanState | null>(null)
  const [askDomain, setAskDomain] = useState(false)
  // The signed-out shell has no history pane, so its Help entry renders the
  // command list inline (with a back pick) instead of pushing to history.
  const [signedOutHelp, setSignedOutHelp] = useState(false)
  const [preauthResult, setPreauthResult] = useState<ActionResult | null>(null)

  const push = useCallback((element: React.ReactElement) => {
    setHistory((h) => {
      const next = [...h, { id: idRef.current++, element }]
      if (next.length > HISTORY_HARD_CAP) return next.slice(-HISTORY_ELEMENT_CAP)
      if (next.length > HISTORY_ELEMENT_CAP) {
        const cut = next.length - HISTORY_ELEMENT_CAP
        return next.map((it, i) => (i < cut ? { id: it.id, element: null } : it))
      }
      return next
    })
  }, [])
  const pushResult = useCallback((result: ActionResult) => push(<ActionView result={result} />), [push])
  const pushError = useCallback(
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      push(
        <Text color="red">
          {'  '}✗ {msg}
        </Text>,
      )
    },
    [push],
  )

  /**
   * The one gate every interactive dispatch flows through — prompt, welcome
   * menu, pre-auth menu, confirm. All entry points can fire twice inside a
   * single stdin chunk (double Enter, paste); busyRef is set synchronously
   * so the second call is dropped before any state flips.
   */
  const dispatch = useCallback((fn: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    void fn()
      .catch(() => {})
      .finally(() => {
        busyRef.current = false
        scanAbortRef.current = null
        setBusy(null)
      })
  }, [])

  // The free-scan allowance is SERVER-owned (admin setting), so the hints that
  // quote it — the command list, the sign-in menu, the domain prompt — read the
  // fetched value. Until it lands the state is 0/unknown and the copy says
  // "checking…" rather than "0 left"; a failed fetch leaves it that way and
  // the scan request itself still quotes the real numbers.
  const scanCfg = useScanConfig()
  const commands = React.useMemo(() => commandList(scanCfg), [scanCfg])
  useEffect(() => {
    void refreshScanConfig()
  }, [])

  // Boot: subscription header + product names for completion.
  useEffect(() => {
    if (!sessionApi) return
    let alive = true
    void (async () => {
      try {
        const sub = await api.fetchSubscription()
        if (alive) setSubscription(sub)
      } catch (e) {
        if (!alive) return
        if (e instanceof ReLoginRequired) {
          // The stored session is dead (rotated away, revoked, wiped
          // server-side): never show the tool menu against it — every pick
          // would just fail back here. Drop straight to sign-in with the
          // reason, same as a mid-session 401.
          setSessionApi(null)
          setSubscription(null)
          setProductNames([])
          setPane(null)
          setConfirm(null)
          setHistory([])
          setShowWelcome(true)
          setLoginError('session expired — sign in again')
          return
        }
        setSubError(e instanceof Error ? e.message : String(e))
      }
      try {
        const statuses = await api.fetchProductStatuses()
        if (alive) setProductNames(statuses.map((p) => p.title || p.productKey))
      } catch {
        /* completion stays empty — non-fatal */
      }
    })()
    return () => {
      alive = false
    }
  }, [sessionApi])

  /**
   * The free site-report flow (device-keyed, no login). Runs through the
   * same dispatch double-fire guard as everything else; the scan lives in
   * the LIVE area (`publicScan`), the finished report goes where the
   * caller wants — the scrollback history, or preauth's inline result.
   */
  const pushFreeScan = useCallback(
    async (domain: string, preauth: boolean = false) => {
      const abort = new AbortController()
      scanAbortRef.current = abort
      // The welcome/pass-through doors call this WITHOUT runCommand's
      // setBusy — BusyEscape (the esc-abort hook) only mounts while busy,
      // so set it here to keep the esc promise true on every door. Harmless
      // pre-auth, where no busy UI renders.
      setBusy(`scanning ${domain} — esc stops waiting…`)
      setPublicScan(null)
      try {
        const result = await actions.publicReportAction(domain, (s) => setPublicScan(s), { signal: abort.signal })
        if (abort.signal.aborted) {
          const stopped: ActionResult = {
            kind: 'text',
            text: `stopped waiting — the scan keeps running on krawlup.com; check https://krawlup.com/site-report/${domain} or run /report ${domain} again (reads are free).`,
          }
          if (preauth) setPreauthResult(stopped)
          else pushResult(stopped)
        } else if (preauth) {
          setPreauthResult(result)
        } else {
          pushResult(result)
        }
      } catch (e) {
        if (e instanceof ScanAborted) {
          // Same honest line, thrown by the sleep when esc landed.
          const stopped: ActionResult = {
            kind: 'text',
            text: `stopped waiting — the scan keeps running on krawlup.com; try again in a minute to read it (reads are free).`,
          }
          if (preauth) setPreauthResult(stopped)
          else pushResult(stopped)
        } else if (e instanceof PublicScanError || e instanceof ToolError) {
          if (preauth) setPreauthResult({ kind: 'text', text: `✗ ${e.message}` })
          else pushError(e)
        } else {
          if (preauth) setPreauthResult({ kind: 'text', text: `✗ ${e instanceof Error ? e.message : String(e)}` })
          else pushError(e)
        }
      } finally {
        scanAbortRef.current = null
        setPublicScan(null)
      }
    },
    [push, pushResult, pushError],
  )

  const startLogin = useCallback(async () => {
    setLoggingIn(true)
    setLoginError(null)
    try {
      const out = await runLogin({
        onUrl: (url, opened) => {
          setLoginUrl(url)
          setLoginOpened(opened)
          push(
            <Text dimColor>
              {'  '}
              {opened ? 'opening your browser — if it did not, sign in here: ' : 'sign in here: '}
              {url}
            </Text>,
          )
        },
      })
      setSessionApi(out.api)
      setLoginUrl(null)
      push(
        <Text color="green">
          {'  '}✓ signed in
        </Text>,
      )
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e))
      pushError(e)
    } finally {
      setLoggingIn(false)
    }
  }, [push, pushError])

  /** Resolve the `<product>` argument or push a usage error. Product
   *  titles may contain spaces, so the joined args get a try too. */
  const resolveOrUsage = useCallback(
    async (cmd: string, args: string[]): Promise<ProductStatus | null> => {
      const q = args[0] ?? ''
      if (!q) {
        push(
          <Text dimColor>
            {'  '}usage: /{cmd} &lt;product&gt;
          </Text>,
        )
        return null
      }
      const product = (await actions.resolveProduct(q)) ?? (args.length > 1 ? await actions.resolveProduct(args.join(' ')) : null)
      if (!product) {
        push(<Text color="red">{'  '}✗ no product matches "{q}" — /products lists them</Text>)
      }
      return product
    },
    [push],
  )

  const runCommand = useCallback(
    async (raw: string) => {
      const line = raw.trim()
      if (!line) return
      if (!line.startsWith('/')) {
        push(<Text dimColor>{'  '}commands start with / — try /help</Text>)
        return
      }
      const parts = line.slice(1).split(/\s+/)
      const cmd = parts[0]!.toLowerCase()
      const args = parts.slice(1)

      setBusy(`running /${cmd}…`)
      try {
        switch (cmd) {
          case 'help':
            push(<HelpBlock commands={commands} />)
            break
          case 'clear':
            setHistory([])
            break
          case 'login':
            await startLogin()
            break
          case 'logout':
            await runLogout()
            setSessionApi(null)
            setSubscription(null)
            setProductNames([])
            push(<Text>{'  '}signed out</Text>)
            break
          case 'report': {
            const domain = args[0] ? normalizeDomainArg(args[0]) : null
            if (!domain) {
              push(<Text dimColor>{'  '}usage: /report example.com</Text>)
              break
            }
            await pushFreeScan(domain)
            break
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
            // The local battery — same runner as argv mode, no session, no API.
            // Output flags make no sense in the TUI (renderers are shared), so
            // they are ignored rather than answered with a usage error.
            const localArgs = args.filter((a) => a !== '--md' && a !== '--json')
            if (localArgs.includes('--help') || localArgs.includes('-h')) {
              push(<Text dimColor>{localUsage(cmd)}</Text>)
              break
            }
            try {
              const result = await runLocalCommand(cmd, localArgs)
              push(<LocalResultView result={result} />)
            } catch (e) {
              if (e instanceof UsageError) {
                push(<Text dimColor>{e.message}</Text>)
              } else {
                throw e
              }
            }
            break
          }
          case 'overview':
            pushResult(await actions.overviewAction(args))
            break
          case 'products':
            pushResult(await actions.productsAction())
            break
          case 'subscription':
            pushResult(await actions.subscriptionAction())
            break
          case 'open': {
            const product = await resolveOrUsage(cmd, args)
            if (product) setPane({ key: product.productKey, title: product.title })
            break
          }
          case 'insights': {
            const product = await resolveOrUsage(cmd, args)
            if (product) pushResult(await actions.insightsAction(product))
            break
          }
          case 'analytics': {
            const range = (['today', '7d', '30d'] as const).find((r) => args.includes(r)) ?? '7d'
            const product = await resolveOrUsage(cmd, args)
            if (product) pushResult(await actions.analyticsAction(product, range))
            break
          }
          case 'keywords': {
            const product = await resolveOrUsage(cmd, args)
            if (product) pushResult(await actions.keywordsAction(product, true))
            break
          }
          case 'history': {
            const product = await resolveOrUsage(cmd, args)
            if (product) pushResult(await actions.historyAction(product))
            break
          }
          case 'snippet': {
            const product = await resolveOrUsage(cmd, args)
            if (product) pushResult(await actions.snippetAction(product))
            break
          }
          case 'scan': {
            const product = await resolveOrUsage(cmd, args)
            if (!product) break
            const abort = new AbortController()
            scanAbortRef.current = abort
            try {
              const started = await actions.scanAction(
                product,
                // Poll progress rides the busy label — pushing a history
                // block every 5s would flood <Static> (≈150 blocks per wait).
                (update) =>
                  setBusy(update.pending ? 'scan running — polling every 5s (esc stops waiting)…' : 'scan finished — reading insights…'),
                { signal: abort.signal },
              )
              if (abort.signal.aborted) {
                push(
                  <Text dimColor>
                    {'  '}stopped waiting — the scan keeps running server-side; check /history {product.productKey} in a minute.
                  </Text>,
                )
              } else if (started.kind === 'scan-started') {
                try {
                  pushResult(await actions.insightsAction(product))
                } catch {
                  /* the fresh insights may not be readable yet — the started block already tells the story */
                }
              }
              // The scan spent budget — the header's plan/usage line re-reads.
              api.fetchSubscription().then(setSubscription).catch(() => {
                invalidate('subscription')
                setSubError('could not refresh the plan/usage header')
              })
            } finally {
              scanAbortRef.current = null
            }
            break
          }
          case 'research': {
            const product = await resolveOrUsage(cmd, args)
            if (!product) break
            setConfirm({
              label: `keyword research for ${product.productKey} spends one of your monthly runs`,
              run: async () => {
                setBusy('running keyword research…')
                try {
                  pushResult(await actions.researchAction(product, args[1]))
                } catch (e) {
                  pushError(e)
                } finally {
                  setBusy(null)
                }
              },
            })
            break
          }
          case 'track':
          case 'untrack': {
            const kws = args.slice(1).filter((k) => k && k !== 'none')
            if (!args[0] || !kws.length) {
              push(
                <Text dimColor>
                  {'  '}usage: /{cmd} &lt;product&gt; &lt;keyword…&gt;
                </Text>,
              )
              break
            }
            const product = await actions.resolveProduct(args[0]!)
            if (!product) {
              push(<Text color="red">{'  '}✗ no product matches "{args[0]}"</Text>)
              break
            }
            pushResult(await actions.trackAction(product, kws, cmd === 'untrack'))
            break
          }
          case 'add': {
            const url = args[0] ?? ''
            if (!url) {
              push(<Text dimColor>{'  '}usage: /add &lt;url&gt;</Text>)
              break
            }
            pushResult(await actions.addAction(url))
            break
          }
          case 'publish':
          case 'unpublish': {
            const product = await resolveOrUsage(cmd, args)
            if (product) pushResult(await actions.visibilityAction(product, cmd === 'publish'))
            break
          }
          case 'exclude': {
            const rawPaths = args.slice(1)
            if (!args[0] || !rawPaths.length) {
              push(<Text dimColor>{'  '}usage: /exclude &lt;product&gt; /path1 /path2… (or "none" to clear)</Text>)
              break
            }
            const product = await actions.resolveProduct(args[0]!)
            if (!product) {
              push(<Text color="red">{'  '}✗ no product matches "{args[0]}"</Text>)
              break
            }
            const paths = rawPaths[0] === 'none' ? [] : rawPaths.map((p) => (p.startsWith('/') ? p : `/${p}`))
            pushResult(await actions.excludeAction(product, paths))
            break
          }
          default:
            push(<Text color="red">{`  ✗ unknown command /${cmd} — /help lists them`}</Text>)
        }
      } catch (e) {
        if (e instanceof ReLoginRequired) {
          // Back to the sign-in screen with everything authed wiped — the
          // history would otherwise re-appear verbatim after re-login.
          setSessionApi(null)
          setSubscription(null)
          setProductNames([])
          setPane(null)
          setConfirm(null)
          setHistory([])
          setShowWelcome(true)
          setLoginError(e.message)
        }
        pushError(e)
      } finally {
        setBusy(null)
      }
    },
    [push, pushResult, pushError, startLogin, pushFreeScan, resolveOrUsage],
  )

  if (!sessionApi) {
    return (
      <Box flexDirection="column" paddingBottom={1}>
        <Wordmark />
        {/* Wordmark already owns its bottom gap — one blank line, not two. */}
        <Box flexDirection="column">
          {loginUrl ? (
            <>
              <Text>{'  '}{loginOpened ? 'opening your browser to sign in…' : 'sign in with this link:'}</Text>
              {!loginOpened ? <Text>{'  '}{loginUrl}</Text> : null}
              <Spinner label="waiting for the browser consent…" />
            </>
          ) : (
            <>
              {loginError ? <Text color="red">{'  '}✗ {loginError}</Text> : null}
              {askDomain ? (
                <>
                  <Text bold>{'  '}Free site report — no account needed</Text>
                  <Box marginTop={1}>
                    <DomainInput
                      onSubmit={(domain) => {
                        setAskDomain(false)
                        dispatch(() => pushFreeScan(domain, true))
                      }}
                    />
                  </Box>
                </>
              ) : (
                <>
                  <Box flexDirection="column">
                    <Text dimColor>{'  '}Sign in once in your browser — read, scans and listing management.</Text>
                    <Text dimColor>{'  '}Or run a free site report right now, no account:</Text>
                  </Box>
                  {loggingIn ? <Spinner label="waiting for the browser consent…" /> : null}
                  {/* While a scan is live the menu steps aside: every option
                      except Exit would be dispatch-guarded anyway, and Exit
                      would kill the app (and its running wait) mid-scan. */}
                  {/* While a report or scan result is on screen the menu steps
                      aside entirely — the same "the screen shows one thing"
                      rule the busy state already follows. A single back pick
                      (or esc) brings the menu back; the result itself stays. */}
                  {!loggingIn && !busy && !preauthResult ? (
                    signedOutHelp ? (
                      <Box flexDirection="column">
                        <HelpBlock commands={commands} />
                        <Text dimColor>{'  '}esc or pick back to return to the menu</Text>
                        <Box marginTop={1}>
                          <SelectMenu
                            items={[{ label: 'back', value: 'back' }]}
                            onSelect={() => setSignedOutHelp(false)}
                            onEscape={() => setSignedOutHelp(false)}
                          />
                        </Box>
                      </Box>
                    ) : (
                      <Box marginTop={1}>
                        <SelectMenu
                          items={[
                            { label: 'Run a free site report (no sign-in)', hint: scanAllowance(scanCfg), value: 'free-report' },
                            { label: 'Sign in with your browser', hint: 'OAuth', value: 'login' },
                            { label: 'Help', hint: 'all commands', value: 'help' },
                            { label: 'Exit', value: 'exit' },
                          ]}
                          onSelect={(item) => {
                            if (item.value === 'free-report') setAskDomain(true)
                            else if (item.value === 'login') dispatch(() => startLogin())
                            else if (item.value === 'help') setSignedOutHelp(true)
                            else exit()
                          }}
                        />
                      </Box>
                    )
                  ) : null}
                </>
              )}
            </>
          )}
          {publicScan ? (
            <Box marginTop={1}>
              <PublicScanProgress state={publicScan} showEscHint onEsc={() => scanAbortRef.current?.abort()} />
            </Box>
          ) : null}
          {preauthResult ? (
            <Box marginTop={1} flexDirection="column">
              <ActionView result={preauthResult} />
              {!busy ? (
                <>
                  <Text dimColor>{'  '}esc or pick back for the menu</Text>
                  <Box marginTop={1}>
                    <SelectMenu
                      items={[{ label: 'back', value: 'back' }]}
                      onSelect={() => setPreauthResult(null)}
                      onEscape={() => setPreauthResult(null)}
                    />
                  </Box>
                </>
              ) : null}
            </Box>
          ) : null}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {/* One blank line between rendered blocks — every command result gets
          the same breathing room regardless of what it contains. */}
      <Static items={history}>{(item) => <Box key={item.id} marginBottom={1}>{item.element}</Box>}</Static>
      {askDomain && !busy && !confirm ? (
        <Box flexDirection="column" marginTop={1}>
          <DomainInput
            onSubmit={(domain) => dispatch(() => pushFreeScan(domain))}
            onCancel={() => setAskDomain(false)}
          />
        </Box>
      ) : null}
      {pane ? (
        <LivePane
          product={pane}
          onClose={() => setPane(null)}
          onScan={(productKey) => {
            // `r` in the pane must not spend budget without a confirm.
            setPane(null)
            setConfirm({
              label: `rescan ${productKey} now? It spends one of your full-analysis runs`,
              run: async () => {
                await runCommand(`/scan ${productKey}`)
              },
            })
          }}
        />
      ) : showWelcome ? (
        <Box flexDirection="column">
          <Wordmark />
          <WelcomeScreen
            onCommand={(cmd) => {
              setShowWelcome(false)
              if (cmd === 'free-report') setAskDomain(true)
              else if (cmd.startsWith('/scan ')) {
                // A menu-picked scan asks first — same gate as the pane's
                // rescan key. A typed '/scan <product>' is deliberate by
                // construction; a one-key menu pick is not.
                setConfirm({
                  label: `rescan ${cmd.slice('/scan '.length)} now? It spends one of your full-analysis runs`,
                  run: async () => {
                    await runCommand(cmd)
                  },
                })
              } else dispatch(() => runCommand(cmd))
            }}
            onSkip={() => setShowWelcome(false)}
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Header subscription={subscription} error={subError} />
          {confirm ? (
            <Box marginTop={1}>
              <ConfirmWrapper
                confirm={confirm}
                onCancel={() => setConfirm(null)}
                onConfirm={() => dispatch(() => confirm.run())}
              />
            </Box>
          ) : null}
          {/* The live scan screen owns its own status line — a second spinner
              label above it would say the same thing twice. */}
          {busy && !publicScan ? (
            <Box marginTop={1}>
              <Spinner label={busy} />
            </Box>
          ) : null}
          {busy ? <BusyEscape onAbort={() => scanAbortRef.current?.abort()} /> : null}
          {publicScan ? (
            <Box marginTop={1}>
              <PublicScanProgress state={publicScan} showEscHint onEsc={() => scanAbortRef.current?.abort()} />
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Prompt onSubmit={(v) => dispatch(() => runCommand(v))} productNames={productNames} commands={commands} disabled={!!busy || !!confirm || askDomain} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

/** While a command runs, esc aborts the (only abortable) scan wait. */
function BusyEscape({ onAbort }: { onAbort: () => void }) {
  useInput((input, key) => {
    if (key.escape) onAbort()
  })
  return null
}

/** The brand wordmark as readable ASCII block art (see banner.ts) — blue
 *  'krawl', orange 'up', split at the whitespace gap between them. */
function Wordmark() {
  const cols = useTerminalColumns()
  const wide = cols >= 100
  const lines = wide ? WORDMARK_WIDE : WORDMARK_NARROW
  const split = wide ? SPLIT_WIDE : SPLIT_NARROW
  return (
    <Box flexDirection="column" marginLeft={2} marginBottom={1}>
      {lines.map((line, i) => {
        const left = line.slice(0, split)
        const right = line.slice(split)
        return (
          <Text key={i}>
            {left ? <Text color="#2b7ff2">{left}</Text> : null}
            {right ? <Text color="#f47c20">{right}</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}

export interface SelectItem {
  label: string
  hint?: string
  value: string
}

/** Arrow-key + number-key menu; enter picks, esc leaves. */
function SelectMenu({
  items,
  onSelect,
  onEscape,
  active = true,
}: {
  items: SelectItem[]
  onSelect: (item: SelectItem) => void
  onEscape?: () => void
  active?: boolean
}) {
  const [idx, setIdx] = useState(0)
  useInput(
    (input, key) => {
      if (key.upArrow) setIdx((i) => (i + items.length - 1) % items.length)
      else if (key.downArrow) setIdx((i) => (i + 1) % items.length)
      else if (key.return) {
        const item = items[idx]
        if (item) onSelect(item)
      } else if (key.escape) {
        onEscape?.()
      } else if (input.length === 1 && input >= '1' && input <= '9') {
        // length guard: ink can deliver a multi-char chunk (fast typing /
        // paste) and a lexicographic '12' <= '9' would pick item 11.
        const n = Number(input) - 1
        if (n < items.length) {
          const item = items[n]
          if (item) onSelect(item)
        }
      }
    },
    { isActive: active },
  )
  // Hints line up in one column — a ragged hint edge is what makes a menu
  // read as a wall of text rather than a list of options.
  const labelW = Math.max(...items.map((item) => item.label.length), 0)
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={item.value}>
          {'  '}
          {i === idx ? <Text color="cyan" bold>❯ </Text> : '  '}
          {item.hint ? (
            <Text bold={i === idx}>{item.label.padEnd(labelW)}</Text>
          ) : i === idx ? (
            <Text bold>{item.label}</Text>
          ) : (
            <Text>{item.label}</Text>
          )}
          {item.hint ? <Text dimColor>  {item.hint}</Text> : null}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>{'  '}↑↓ move · enter select · 1-{Math.min(9, items.length)} quick-pick{onEscape ? ' · esc back' : ''}</Text>
      </Box>
    </Box>
  )
}

/** The boot menu: picks dispatch into the same command runner as the prompt. */
function WelcomeScreen({
  onCommand,
  onSkip,
}: {
  onCommand: (cmd: string) => void
  onSkip: () => void
}) {
  const [mode, setMode] = useState<'menu' | 'pick'>('menu')
  const [pickCmd, setPickCmd] = useState<string>('')
  const [statuses, setStatuses] = useState<ProductStatus[] | null>(null)
  const [pickError, setPickError] = useState<string | null>(null)

  useEffect(() => {
    if (mode !== 'pick' || statuses) return
    let alive = true
    void api
      .fetchProductStatuses()
      .then((s) => {
        if (alive) setStatuses(s)
      })
      .catch((e) => {
        if (alive) setPickError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [mode, statuses])

  if (mode === 'pick') {
    if (pickError) {
      return (
        <Box flexDirection="column">
          <Text color="red">{'  '}✗ {pickError}</Text>
          <Text dimColor>{'  '}press esc to go back</Text>
          <Box marginTop={1}>
            <SelectMenu items={[{ label: 'back', value: 'back' }]} onSelect={onSkip} onEscape={onSkip} />
          </Box>
        </Box>
      )
    }
    if (!statuses) return <Spinner label="loading products…" />
    if (!statuses.length) {
      return (
        <Box flexDirection="column">
          <Text dimColor>{'  '}no products yet — add one with /add &lt;url&gt;</Text>
          <Box marginTop={1}>
            <SelectMenu items={[{ label: 'back', value: 'back' }]} onSelect={onSkip} onEscape={onSkip} />
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text bold>{'  '}{pickCmd.slice(1)} which product?</Text>
        <Box marginTop={1}>
          <SelectMenu
            items={statuses.map((p) => ({ label: p.title || p.productKey, hint: p.productKey, value: `${pickCmd} ${p.productKey}` }))}
            onSelect={(item) => onCommand(item.value)}
            onEscape={() => setMode('menu')}
          />
        </Box>
      </Box>
    )
  }

  return (
    <SelectMenu
      items={[
        { label: 'Free site report', hint: 'any website — unlimited for beta testers', value: 'free-report' },
        { label: 'Portfolio overview', hint: '/overview', value: '/overview' },
        { label: 'Products', hint: '/products', value: '/products' },
        { label: 'Open a product…', value: 'pick:/open' },
        { label: 'Scan a product…', value: 'pick:/scan' },
        { label: 'Analytics…', value: 'pick:/analytics' },
        { label: 'Subscription & usage', hint: '/subscription', value: '/subscription' },
        { label: 'Help', hint: '/help', value: '/help' },
        { label: 'Sign out', hint: '/logout', value: '/logout' },
      ]}
      onSelect={(item) => {
        if (item.value.startsWith('pick:')) {
          setPickCmd(item.value.slice(5))
          setMode('pick')
          return
        }
        onCommand(item.value)
      }}
      onEscape={onSkip}
    />
  )
}

/**
 * A domain line editor for the free-report doors (pre-auth menu, welcome
 * menu). Plain text — no slash completions. Enter runs, esc cancels.
 */
function DomainInput({ onSubmit, onCancel }: { onSubmit: (domain: string) => void; onCancel?: () => void }) {
  const [value, setValue] = useState('')
  // Server-owned allowance: the footer must not promise a number the reserve
  // pipeline would refuse.
  const scanCfg = useScanConfig()
  useInput(
    (input, key) => {
      if (key.return) {
        const v = normalizeDomainArg(value)
        if (v) onSubmit(v)
        return
      }
      if (key.escape && onCancel) {
        onCancel()
        return
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta || key.escape || key.pageUp || key.pageDown || key.return) return
      if (input) setValue((v) => v + input)
    },
    { isActive: true },
  )
  return (
    <Box flexDirection="column">
      <Text>
        {'  '}
        <Text color="cyan" bold>
          domain{'> '}
        </Text>
        {value}
        <Text inverse> </Text>
      </Text>
      <Text dimColor>{'  '}e.g. example.com · enter runs · esc back</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{'  '}your device id carries the free quota — {scanAllowance(scanCfg)}, then reads stay free</Text>
        <Text dimColor>{'  '}signed-in beta testers scan without a limit</Text>
      </Box>
    </Box>
  )
}

/** y/n confirm — owns the keys while visible (no prompt underneath). */
function ConfirmWrapper({ confirm, onCancel, onConfirm }: { confirm: PendingConfirm; onCancel: () => void; onConfirm: () => void }) {
  useInput((input, key) => {
    if (input === 'y') {
      onCancel()
      onConfirm()
    }
    if (input === 'n' || key.escape) onCancel()
  })
  return (
    <Text>
      {'  '}
      <Text color="yellow">?</Text> {confirm.label} — <Text bold>y</Text>/<Text bold>n</Text>
    </Text>
  )
}
