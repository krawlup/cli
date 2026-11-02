/**
 * `krawlup text <url>` — "what the LLM sees": the page fetched, stripped to
 * the plain text an extractor (or assistant) can actually read, with the
 * heading outline and an extractability verdict. The strip is derived from
 * the server's rule (scripts/styles/comments out, whitespace collapsed), so
 * this reads the page the way krawlup's own scanner does.
 */
import type { Check, Section } from './verdict.js'
import { stripHtmlToText, extractHeadings, extractTitle } from './html.js'

export interface TextFacts {
  title: string | null
  wordCount: number
  charCount: number
  htmlCharCount: number
  headings: Array<{ level: number; text: string }>
  excerpt: string
}

export function textFacts(html: string): TextFacts {
  const text = stripHtmlToText(html)
  return {
    title: extractTitle(html),
    wordCount: text ? text.split(/\s+/).length : 0,
    charCount: text.length,
    htmlCharCount: html.length,
    headings: extractHeadings(html),
    excerpt: text.slice(0, 1200),
  }
}

export function judgeText(f: TextFacts): Section {
  const checks: Check[] = []

  if (f.wordCount < 50) {
    checks.push({
      id: 'extractable',
      label: 'Extractable text',
      status: 'fail',
      detail: `${f.wordCount} word${f.wordCount === 1 ? '' : 's'} in ${f.htmlCharCount.toLocaleString()} chars of HTML — a non-rendering fetcher sees almost nothing: the page is JS-only or the copy is inside scripts.`,
    })
  } else if (f.wordCount < 150) {
    checks.push({
      id: 'extractable',
      label: 'Extractable text',
      status: 'warn',
      detail: `${f.wordCount} words — thin for an assistant to quote with confidence.`,
    })
  } else {
    checks.push({ id: 'extractable', label: 'Extractable text', status: 'pass', detail: `${f.wordCount.toLocaleString()} words, ${f.charCount.toLocaleString()} chars of readable text.` })
  }

  const h1 = f.headings.filter((h) => h.level === 1)
  if (h1.length === 0) {
    checks.push({ id: 'outline', label: 'Outline', status: 'warn', detail: `No <h1>; ${f.headings.length} h1–h3 heading${f.headings.length === 1 ? '' : 's'} total. Headings are the spine an answer engine quotes.` })
  } else if (h1.length > 1) {
    checks.push({ id: 'outline', label: 'Outline', status: 'warn', detail: `${h1.length} <h1> elements — one page, one topic: assistants split multipolar documents.` })
  } else {
    checks.push({ id: 'outline', label: 'Outline', status: 'pass', detail: `1 <h1> ("${h1[0]!.text.slice(0, 60)}") + ${f.headings.length - 1} subheading${f.headings.length - 1 === 1 ? '' : 's'}.` })
  }

  return {
    id: 'text',
    title: 'What an LLM sees',
    checks,
    note: f.excerpt ? `First ${f.excerpt.length} chars of extractable text:\n  ${f.excerpt.replace(/\n/g, ' ').slice(0, 1196)}` : 'No extractable text at all.',
  }
}
