/**
 * LivePane: the one opencode-like element — an open product becomes a
 * redraw-in-place tabbed view above the prompt. Data loads per tab through
 * the cached command layer; Esc returns to the prompt with scrollback kept.
 */
import { Box, Text, useInput } from 'ink'
import React, { useEffect, useState } from 'react'
import * as api from '../api/commands.js'
import * as actions from '../actions.js'
import type { ActionResult } from '../actions.js'
import { Spinner } from './components.js'
import { ActionView } from './render.js'

const TABS = ['overview', 'insights', 'analytics', 'keywords', 'history'] as const
type Tab = (typeof TABS)[number]

export function LivePane({
  product,
  onClose,
  onScan,
}: {
  product: { key: string; title?: string }
  onClose: () => void
  /** `r` triggers a rescan from the pane; the app owns the run + history. */
  onScan: (productKey: string) => void
}) {
  const [tabIdx, setTabIdx] = useState(0)
  const [range, setRange] = useState<'today' | '7d' | '30d'>('7d')
  const [result, setResult] = useState<ActionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const tab = TABS[tabIdx]!

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    const load = async (): Promise<void> => {
      try {
        let r: ActionResult
        const stub = { productKey: product.key, title: product.title }
        switch (tab) {
          case 'overview':
          case 'insights':
            r = await api.fetchInsights(product.key).then((insights) => ({ kind: 'insights', productKey: product.key, insights }) as ActionResult)
            break
          case 'analytics':
            r = { kind: 'analytics', productKey: product.key, analytics: await api.fetchAnalytics(product.key, range) }
            break
          case 'keywords':
            r = await actions.keywordsAction(stub as any, false)
            break
          case 'history':
            r = await actions.historyAction(stub as any)
            break
        }
        if (alive) setResult(r)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [product.key, tab, range])

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (key.leftArrow) setTabIdx((i) => (i + TABS.length - 1) % TABS.length)
    if (key.rightArrow) setTabIdx((i) => (i + 1) % TABS.length)
    if (['1', '2', '3', '4', '5'].includes(input)) setTabIdx(Number(input) - 1)
    if (input === 'r') onScan(product.key)
    if (tab === 'analytics') {
      if (input === 'd') setRange('today')
      if (input === 'w') setRange('7d')
      if (input === 'm') setRange('30d')
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{product.title || product.key}</Text>
          <Text dimColor> · {product.key}</Text>
        </Text>
        <Text dimColor>esc close</Text>
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>
          {TABS.map((t, i) => (i === tabIdx ? <Text key={t} bold color="cyan">[{t}]</Text> : <Text key={t}> {t} </Text>))}
          {tab === 'analytics' ? <Text> · d/w/m = today/7d/30d ({range})</Text> : null}
          {tab !== 'analytics' ? <Text> · r rescan</Text> : null}
        </Text>
      </Box>
      {loading ? <Spinner label={`loading ${tab}…`} /> : error ? <Text color="red">{'  '}{error}</Text> : result ? <ActionView result={result} /> : null}
    </Box>
  )
}
