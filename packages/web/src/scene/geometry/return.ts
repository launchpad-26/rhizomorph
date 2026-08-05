import { clamp01 } from '../palette.js'
import type { RetireState } from '../retire.js'
import { pointAt, smooth } from './curves.js'
import type { Point, RetireGeometry } from './types.js'

/**
 * …but never more than this much of a short strand. On a cramped panel a lane's
 * whole thread can be shorter than the reach, and a bend that consumed all of it
 * would have lifted the strand off the mass it is threaded into.
 */
const RELAX_MAX_FRACTION = 0.58

/**
 * How long the returning substance is, in px of the thread it is made of
 * (prd6 ruling 2) — measured in px for the same reason the scar is, so a lane at
 * three o'clock does not send home three times as much matter as one at noon.
 */
const HOMEWARD_LENGTH_PX = 30

/** How far the released taper relaxes from root width toward tip width. */
const TAPER_RELAX = 0.5

// ── the return, as shape ────────────────────────────────────────────────────

export interface Release {
  /** The thread's own sideways direction — the axis its bow already runs on. */
  along: Point
  /** Which way that bow leans, so the slack loosens the curve rather than fighting it. */
  side: number
  /** Peak sideways sag, in px. */
  slack: number
  /** The rim's outward normal at this lane's angle. */
  outward: Point
  /** How far the node end is carried toward the rim, in px. */
  drift: number
  /** Where the outward relax begins — the stretch of strand the drift bends. */
  from: number
}

/**
 * The thread with the tension let out of it and its tip drifted. Two
 * displacements, each a different stage's whole contribution:
 *
 * - **slack**, along the thread's *own* lean, peaking about a third of the way
 *   out — sagging the *other* way would read as something pulling on it, not
 *   as the thread going loose.
 * - **drift**, along the rim normal, zero where the relax reach begins and
 *   full at the node — rigid drift would fight the slack instead of easing
 *   past it.
 */
export function released(path: readonly Point[], release: Release): Point[] {
  const last = path.length - 1
  return path.map((point, i) => {
    const t = last <= 0 ? 1 : i / last
    const sag = release.slack * slackHump(t)
    const out = release.drift * driftWeight(t, release.from)
    return {
      x: point.x + release.along.x * release.side * sag + release.outward.x * out,
      y: point.y + release.along.y * release.side * sag + release.outward.y * out,
    }
  })
}

/** Zero at both ends, peak 1 at t ≈ 0.32 — the slack is a root-end fact. */
function slackHump(t: number): number {
  return Math.sin(Math.PI * Math.pow(clamp01(t), 0.6))
}

/** Zero everywhere but the stretch the relax reaches, easing in and out. */
function driftWeight(t: number, from: number): number {
  const span = 1 - from
  if (span <= 0) return clamp01(t) >= 1 ? 1 : 0
  const into = (clamp01(t) - from) / span
  return into <= 0 ? 0 : smooth(into)
}

/**
 * The path parameter `lengthPx` of arc length back from the node — where the
 * outward relax begins. Walked from the tip backwards over the sampled
 * polyline; exact enough since the ribbon is drawn with the same
 * segment-linear approximation anyway.
 */
export function relaxRest(path: readonly Point[], lengthPx: number): number {
  const last = path.length - 1
  if (last < 1) return 0

  let total = 0
  for (let i = last; i > 0; i -= 1) {
    const a = path[i] as Point
    const b = path[i - 1] as Point
    const step = Math.hypot(a.x - b.x, a.y - b.y)
    if (total + step >= lengthPx) {
      const within = step === 0 ? 0 : (lengthPx - total) / step
      return Math.max(1 - RELAX_MAX_FRACTION, (i - within) / last)
    }
    total += step
  }
  // The whole thread is shorter than the mark: keep the tail fraction instead.
  return 1 - RELAX_MAX_FRACTION
}

/**
 * THE WAY HOME (prd6 ruling 2) — where the lane's substance has got to: a
 * stretch of the thread's own centreline, leaving the node when the withdraw
 * begins and gone into the mass when it ends. Not a pulse (light is what a
 * *working* lane spends) — this is matter, which is why the mass is thicker
 * afterwards (`marks/root.ts`).
 *
 * Travels on the withdraw's own clock rather than a new animation budget, so
 * it is null at both ends of that stage: it grows out of the node rather than
 * popping into existence, and is absorbed rather than blinking out.
 */
function homewardFlow(path: readonly Point[], withdraw: number): Point[] | null {
  if (withdraw <= 0 || withdraw >= 1) return null

  // Measured in arc length rather than in path parameter: the samples of a cubic
  // are not evenly spaced along it, so a fixed *parameter* span would send three
  // times as much substance home from one end of the ellipse as from the other.
  const cumulative = arcTable(path)
  const total = cumulative[cumulative.length - 1] ?? 0
  if (total <= 0) return null

  const parcel = Math.min(HOMEWARD_LENGTH_PX, total * 0.5)
  // The leading (rootward) edge, from the node at `total` to one parcel-length
  // past the mass — which is where the last of it disappears under the mass.
  const lead = total - (total + parcel) * withdraw
  const from = Math.max(0, lead)
  const to = Math.min(total, lead + parcel)
  if (to - from < 0.5) return null

  return between(path, paramAtArc(cumulative, from), paramAtArc(cumulative, to), 12)
}

/**
 * THE STRAND A FINISHED LANE KEEPS (prd10 rulings 13–15) — the whole of it,
 * root-mass rim to node, threaded in at both ends; no code path here can
 * shorten or empty it. See docs/decisions/geometry-return-as-shape.md.
 *
 * Keeps the whole thread's taper, so `thread width = work size` survives
 * intact: the *encoding* lives here, the *hierarchy* (how much thinner,
 * `retire.ts`'s {@link PERSIST_WIDTH_SCALE}) lives where the ribbon is built
 * (`marks/thread.ts`) — which keeps a retune of one from silently changing
 * the other. The release changes only the taper's *steepness*, relaxing
 * {@link TAPER_RELAX} of the way toward the tip's width.
 */
export function persistence(
  cut: RetireState,
  path: readonly Point[],
  widthRoot: number,
  widthTip: number,
  hideFinished: boolean,
): RetireGeometry {
  const relaxed = widthRoot + (widthTip - widthRoot) * TAPER_RELAX * cut.tension

  return {
    ...cut,
    // The strand as drawn, at full resolution — the same array the living thread
    // carries, which is what makes "no geometry is ever deleted" a thing a test
    // can assert by comparing two paths rather than by counting marks.
    path: [...path],
    widthRoot: relaxed,
    widthTip,
    homeward: homewardFlow(path, cut.withdraw),
    // Only a lane that has reached `persistent` is hideable. A return in progress
    // is news, and the one thing worse than a finished lane the operator asked not
    // to see is a completion they never saw at all.
    hidden: hideFinished && cut.stage === 'persistent',
  }
}

/** The stretch of a path between two parameters, resampled to `steps` segments. */
function between(path: readonly Point[], from: number, to: number, steps: number): Point[] {
  const start = clamp01(from)
  const end = clamp01(to)
  const out: Point[] = []
  for (let i = 0; i <= steps; i += 1) out.push(pointAt(path, start + (end - start) * (i / steps)))
  return out
}

/** Cumulative arc length at each sample of a path — `[0, …, total]`. */
function arcTable(path: readonly Point[]): number[] {
  const out = [0]
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    out.push((out[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y))
  }
  return out
}

/** The path parameter `s` px along a path, off its own cumulative table. */
function paramAtArc(cumulative: readonly number[], s: number): number {
  const last = cumulative.length - 1
  if (last < 1) return 0
  let i = 1
  while (i < last && (cumulative[i] as number) < s) i += 1
  const before = cumulative[i - 1] as number
  const step = (cumulative[i] as number) - before
  const within = step === 0 ? 0 : (s - before) / step
  return clamp01((i - 1 + within) / last)
}
