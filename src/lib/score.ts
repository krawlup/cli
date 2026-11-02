/** Score semantics shared by every renderer — thresholds and tones only;
 *  Ink components apply the actual colors. */

export type ScoreTone = 'good' | 'mid' | 'bad' | 'none'

export function scoreTone(score: number | null | undefined): ScoreTone {
  if (score == null || Number.isNaN(score)) return 'none'
  if (score >= 80) return 'good'
  if (score >= 50) return 'mid'
  return 'bad'
}

/** Which hex-ish color name an Ink `color` prop accepts. */
export function scoreColor(score: number | null | undefined): string {
  switch (scoreTone(score)) {
    case 'good':
      return 'green'
    case 'mid':
      return 'yellow'
    case 'bad':
      return 'red'
    default:
      return 'gray'
  }
}

export function scoreText(score: number | null | undefined): string {
  return score == null || Number.isNaN(score) ? '—' : `${score}`
}

export function severityTone(severity: string | null | undefined): string {
  switch (severity) {
    case 'critical':
      return 'red'
    case 'high':
      return 'red'
    case 'medium':
      return 'yellow'
    case 'low':
      return 'blue'
    default:
      return 'gray'
  }
}
