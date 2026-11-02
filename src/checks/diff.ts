/**
 * `krawlup diff <url>` — local content snapshots: the first run stores the
 * page's extractable text, every later run reports exactly what drifted.
 * Snapshots live in ~/.krawlup/snapshots/ keyed by host + path hash, and the
 * storage dir is injectable so the semantics are testable offline.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { stripHtmlToLines, extractTitle } from './html.js'
import type { Check, Section } from './verdict.js'

/** Text stored per snapshot — beyond this, only the hash verdict survives. */
const SNAPSHOT_TEXT_CAP = 200_000
/** Lines per side for a real LCS hunk diff; beyond this, multiset counts. */
const DIFF_LCS_LINES = 600

export interface PageSnapshot {
  url: string
  savedAt: string
  title: string | null
  wordCount: number
  textSha256: string
  text: string
}

export function snapshotPath(dir: string, url: string): string {
  const u = new URL(url)
  const key = createHash('sha256').update(`${u.host}${u.pathname}${u.search}`).digest('hex').slice(0, 24)
  return path.join(dir, `${u.host.replace(/[^a-z0-9.-]/gi, '_')}-${key}.json`)
}

export function makeSnapshot(url: string, html: string): PageSnapshot {
  const text = stripHtmlToLines(html).slice(0, SNAPSHOT_TEXT_CAP)
  return {
    url,
    savedAt: new Date().toISOString(),
    title: extractTitle(html),
    wordCount: text ? text.split(/\s+/).length : 0,
    textSha256: createHash('sha256').update(text).digest('hex'),
    text,
  }
}

export async function loadSnapshot(dir: string, url: string): Promise<PageSnapshot | null> {
  try {
    const raw = await readFile(snapshotPath(dir, url), 'utf-8')
    const snap = JSON.parse(raw) as PageSnapshot
    if (typeof snap?.textSha256 !== 'string') return null
    return snap
  } catch {
    return null
  }
}

export async function saveSnapshot(dir: string, snap: PageSnapshot): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(snapshotPath(dir, snap.url), JSON.stringify(snap), 'utf-8')
}

export interface DiffResult {
  changed: boolean
  /** Hash-level change with nothing to show (over-cap text). */
  hashOnly: boolean
  added: string[]
  removed: string[]
  titleChanged: boolean
  wordDelta: number
}

/** Line-level drift. Common prefix/suffix trimmed, then LCS hunks when the
 *  middle is small enough to stay O(n·m) sane; multiset counts otherwise. */
export function diffSnapshots(prev: PageSnapshot, next: PageSnapshot): DiffResult {
  const changed = prev.textSha256 !== next.textSha256
  const titleChanged = (prev.title ?? null) !== (next.title ?? null)
  const wordDelta = next.wordCount - prev.wordCount
  if (!changed) {
    return { changed: false, hashOnly: false, added: [], removed: [], titleChanged, wordDelta }
  }
  if (prev.text.length >= SNAPSHOT_TEXT_CAP || next.text.length >= SNAPSHOT_TEXT_CAP) {
    return { changed: true, hashOnly: true, added: [], removed: [], titleChanged, wordDelta }
  }

  const a = prev.text.split('\n')
  const b = next.text.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const cap = DIFF_LCS_LINES
  if (midA.length > cap || midB.length > cap) {
    // Multiset counts: what exists only in the new version, and vice versa.
    const count = (lines: string[]): Map<string, number> => {
      const m = new Map<string, number>()
      for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1)
      return m
    }
    const ca = count(midA)
    const cb = count(midB)
    const added: string[] = []
    const removed: string[] = []
    for (const [line, n] of cb) {
      const excess = n - (ca.get(line) ?? 0)
      for (let i = 0; i < Math.max(0, excess); i++) added.push(line)
    }
    for (const [line, n] of ca) {
      const excess = n - (cb.get(line) ?? 0)
      for (let i = 0; i < Math.max(0, excess); i++) removed.push(line)
    }
    return { changed: true, hashOnly: false, added: added.slice(0, 50), removed: removed.slice(0, 50), titleChanged, wordDelta }
  }

  // LCS DP over the trimmed middle.
  const n = midA.length
  const m = midB.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = midA[i] === midB[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }
  const added: string[] = []
  const removed: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      i++
      j++
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      removed.push(midA[i]!)
      i++
    } else {
      added.push(midB[j]!)
      j++
    }
  }
  while (i < n) removed.push(midA[i++]!)
  while (j < m) added.push(midB[j++]!)
  return { changed: true, hashOnly: false, added: added.slice(0, 50), removed: removed.slice(0, 50), titleChanged, wordDelta }
}

export function judgeDiff(d: DiffResult, prevSavedAt: string | null): Section {
  if (!prevSavedAt) {
    return {
      id: 'diff',
      title: 'Content drift',
      checks: [{ id: 'snapshot', label: 'Baseline', status: 'pass', detail: 'First snapshot stored — run the same command again any time to see what changed.' }],
    }
  }
  if (!d.changed && !d.titleChanged) {
    return {
      id: 'diff',
      title: 'Content drift',
      checks: [{ id: 'snapshot', label: 'Drift', status: 'pass', detail: `Unchanged since ${prevSavedAt.slice(0, 10)}.` }],
    }
  }
  const checks: Check[] = [
    {
      id: 'snapshot',
      label: 'Drift',
      status: 'fail',
      detail: `Changed since ${prevSavedAt.slice(0, 10)}: ${d.added.length} line${d.added.length === 1 ? '' : 's'} added, ${d.removed.length} removed${d.titleChanged ? ' — TITLE changed' : ''} (${d.wordDelta >= 0 ? '+' : ''}${d.wordDelta} words).`,
    },
  ]
  for (const line of d.removed.slice(0, 10)) {
    checks.push({ id: 'removed', label: '− removed', status: 'fail', detail: line.slice(0, 160) })
  }
  for (const line of d.added.slice(0, 10)) {
    checks.push({ id: 'added', label: '+ added', status: 'fail', detail: line.slice(0, 160) })
  }
  return { id: 'diff', title: 'Content drift', checks }
}

/** ~/.krawlup/snapshots — beside session.json and device-id. */
export function defaultSnapshotDir(): string {
  return path.join(homedir(), '.krawlup', 'snapshots')
}
