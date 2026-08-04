/**
 * THE SPARKLINE (issue #159, Grafana's legend-as-table pattern) — a tiny
 * inline history beside a headline number. Pure SVG, no charting dependency:
 * a fleet row or a ledger row already says the truth in figures (`412k`,
 * `$4.20`), and this is texture beside it, not a second source of it — so it
 * is always `aria-hidden`, and a caller must keep the real number in the DOM
 * next to it.
 *
 * **The honest gap**: fewer than three points draws nothing at all, ever.
 * Two points would still be a real line, but a one- or zero-point "line" is
 * either a dot or a flat stroke standing in for data that was never
 * measured — indistinguishable, at a glance, from a genuinely flat series.
 * Padding a young lane's history with invented zeros to reach three points is
 * exactly the shape of lie this threshold exists to refuse; supplying an
 * honestly short series is the caller's job (see `bucketize.ts`), and this
 * component's only job is to refuse to draw when that series is too short to
 * mean anything.
 *
 * Strokes in `currentColor` so it inherits whatever ink the cell around it
 * already wears — the same convention `fleet/strokes.ts` uses for the scene's
 * own glyphs — rather than carrying a hardcoded hue of its own.
 */
export interface SparklineProps {
  /** Oldest first. Fewer than three points renders nothing. */
  values: readonly number[]
  width?: number
  height?: number
  className?: string
}

const DEFAULT_WIDTH = 60
const DEFAULT_HEIGHT = 14
const MIN_POINTS = 3
/** Keeps a flat series' line inside the stroke's own height rather than pinned to an edge. */
const PADDING = 1.5

export function Sparkline({
  values,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  className,
}: SparklineProps) {
  if (values.length < MIN_POINTS) return null

  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min
  const usableHeight = height - PADDING * 2

  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width
    const y = range === 0 ? height / 2 : PADDING + (1 - (value - min) / range) * usableHeight
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <svg
      aria-hidden="true"
      data-testid="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
    >
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
