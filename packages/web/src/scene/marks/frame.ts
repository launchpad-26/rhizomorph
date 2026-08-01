import type { Fleet } from '../../fleet/index.js'
import { RECENCY_SPAN_MS, type SceneGeometry, type ThreadGeometry } from '../geometry.js'
import { allowance, type MotionMode } from '../motion.js'
import type { Ink } from '../palette.js'
import type { PulseField } from '../pulses.js'
import { spend, type Salience } from '../salience.js'

/**
 * One frame's worth of inputs, shared by every mark builder.
 *
 * `breath` is the scene's ambient motion (law 10) — ±{@link BREATH_DEPTH} on the
 * root-mass, well inside ruling 4's 3% ceiling, and nothing else in the picture
 * is allowed to move without an event behind it. It is computed once here rather
 * than re-derived by whoever wants it, which is also what makes "the whole scene
 * stopped breathing" a single decision instead of a search.
 *
 * The two motion flags are not the same preference and must not be collapsed:
 * `reducedMotion` is the operating system's standing request, `paused` is the
 * operator's hand on the pause control (WCAG 2.2.2, Level A). Pause is the
 * stricter of the two — see {@link motionMode} — and the scene implements it by
 * holding its clock still, so every mark that reads `now` freezes without having
 * to know the control exists.
 */
export interface SceneFrame {
  fleet: Fleet
  geometry: SceneGeometry
  field: PulseField
  salience: Salience
  now: number
  reducedMotion: boolean
  /** The operator has stopped the scene. Ambient and event motion hold still. */
  paused: boolean
  /** Multiplier around 1. The root-mass's slow inhale. */
  breath: number
}

/** ±1.6% — visible as life, invisible as movement. Ruling 4 allows up to 3%. */
export const BREATH_DEPTH = 0.016
/** Matches `--duration-breath` in the theme, and ruling 4's 4–8 s ambient band. */
export const BREATH_PERIOD_MS = 5_400

/**
 * Which of the three motion regimes this frame is being drawn under. Pause wins
 * over a reduced-motion preference because it is strictly stronger: reduce drops
 * travel and scale, pause stops everything automatic including brightness.
 */
export function motionMode(frame: Pick<SceneFrame, 'reducedMotion' | 'paused'>): MotionMode {
  if (frame.paused) return 'paused'
  return frame.reducedMotion ? 'reduced' : 'full'
}

export function breathOf(now: number, mode: MotionMode): number {
  // The breath is a scale, so it is exactly what both degradations take away.
  if (!allowance('ambient', mode).scale) return 1
  return 1 + BREATH_DEPTH * Math.sin((now / BREATH_PERIOD_MS) * Math.PI * 2)
}

/**
 * How long this lane's summons has gone unanswered, in ms — the age evidence
 * ruling 5's alarm pulse reads.
 *
 * The same quantity the geometry drifts nodes outward on, carried forward from
 * the fleet snapshot to this frame's clock so it advances smoothly between
 * rebuilds. Unclamped, unlike `thread.ageFrac`: the pulse has to keep beating
 * past ten minutes, and an alarm that went still would read as answered.
 */
export function summonsAgeMs(frame: SceneFrame, thread: ThreadGeometry): number {
  const sinceSnapshot = Math.max(0, frame.now - frame.fleet.now)
  const { ageMs } = thread.lane
  // A lane that has never spoken is old, but not *provably* old — the geometry
  // parks it just short of the rim and the pulse agrees with it.
  if (ageMs === null) return 0.98 * RECENCY_SPAN_MS
  return ageMs + sinceSnapshot
}

/**
 * Put an ink through the contrast budget. Every mark builder paints through this
 * rather than reaching for a colour directly, which is how the spotlight, the
 * alarm exemption (g2) and the calm luminance ceiling (g6) apply to the whole
 * picture without any single builder having to remember them.
 */
export function budget(
  frame: SceneFrame,
  laneId: string | null,
  alarm: boolean,
  source: Ink,
): Ink {
  return spend(source, frame.salience, laneId, alarm)
}
