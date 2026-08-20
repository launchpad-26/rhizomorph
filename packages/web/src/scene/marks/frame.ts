import type { Fleet } from '../../fleet/index.js'
import { RECENCY_SPAN_MS, type SceneGeometry, type ThreadGeometry } from '../geometry.js'
import { allowance, type MotionMode } from '../motion.js'
import { capPresence, fade, REPLAY_VIBRANCY, type Ink, type ScenePalette } from '../palette.js'
import type { PulseField } from '../pulses.js'
import { emphasisOf, spend, spendTip, type Salience } from '../salience.js'

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
  /**
   * THE ANIMATION CLOCK — real wall time, in replay as much as live (#157's
   * clock audit).
   *
   * Everything that *moves* is a function of this: a pulse's travel, the grain's
   * crawl, a thread's shimmer, the breath. All of them are 400–900 ms envelopes
   * a person watches with their eyes, and an eye does not scrub — a replay
   * running at 8× must not run its pulses at 8× or the whole event class leaves
   * the motion budget's 400–600 ms band the moment somebody drags the speed
   * control. Held still by the pause control, which is the one thing that stops
   * it (`SceneView`).
   */
  now: number
  /**
   * THE STATE CLOCK — the instant the picture is judging the fleet *as of*.
   *
   * Everything that reads an **age** is a function of this instead: how long a
   * summons has gone unanswered, how far a node has drifted out on its recency,
   * how stale a subagent's last reading is. Live the two clocks are the same
   * number. In a replay they are not, and the difference is the whole of why
   * they had to be split: wall time says a recorded session is three days old
   * and greys the entire fleet, while the scrub position says what was actually
   * true at that moment of the performance. A replay is a performance of
   * history, so history's clock is the one that judges its states.
   */
  asOf: number
  /**
   * AMBIENT VIBRANCY — 1 live, {@link REPLAY_VIBRANCY} in a replay (#157).
   *
   * One number, and it reaches exactly one layer: the ambient substrate's
   * luminance and saturation (`marks/ambient.ts`). Never a status hue's meaning,
   * never the alarm grammar, never the ladder — see {@link REPLAY_VIBRANCY} for
   * why the ambient layer is the only thing a mode is allowed to touch.
   */
  vibrancy: number
  reducedMotion: boolean
  /** The operator has stopped the scene. Ambient and event motion hold still. */
  paused: boolean
  /** Multiplier around 1. The root-mass's slow inhale. */
  breath: number
  /**
   * THE THEME'S TABLE (#551's "pointing the marks at it" wave) — which world
   * this frame is drawn in: the void or the page. Like `vibrancy`, a mode
   * becomes a value on the frame exactly once, here, and every mark builder
   * reads it rather than importing a world of its own. `budget()` below is
   * where the palette's band actually bites; the colours themselves come from
   * `palette.register`/`status`/`tissue` as each builder converts.
   */
  palette: ScenePalette
}

/**
 * The vibrancy this frame is drawn at. The only place the mode becomes a number,
 * and the only number a mode is ever allowed to become.
 */
export function vibrancyOf(replaying: boolean): number {
  return replaying ? REPLAY_VIBRANCY : 1
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
  // The STATE clock (#157): "how long has this gone unanswered" is an age, and an
  // age read off wall time in a replay would report the distance to today rather
  // than the distance the operator is watching.
  const sinceSnapshot = Math.max(0, frame.asOf - frame.fleet.now)
  const { ageMs } = thread.lane
  // A lane that has never spoken is old, but not *provably* old — the geometry
  // parks it just short of the rim and the pulse agrees with it.
  if (ageMs === null) return 0.98 * RECENCY_SPAN_MS
  return ageMs + sinceSnapshot
}

/**
 * Put an ink through the contrast budget. Every mark builder paints through this
 * rather than reaching for a colour directly, which is how the spotlight, the
 * alarm exemption (g2) and the calm ceiling (g6) apply to the whole picture
 * without any single builder having to remember them.
 *
 * The budget dispatches on the palette's own carrier, because the two worlds
 * denominate salience in different quantities (prd-32 ruling 7): on the void a
 * calm mark is capped in LUMINANCE — brightness is what draws the eye against
 * black — and that path is `salience.ts`'s `spend`, verbatim, so dark output is
 * byte-identical to what it was before the palette existed. On paper the same
 * cap would be meaningless (the page itself is the brightest thing in sight),
 * so a calm mark is capped in PRESENCE — departure from the ground — using the
 * same recession ratio (`emphasisOf`; a ratio is the one part of the budget not
 * denominated in light at all) and the light band's own ceiling. Alarms pass
 * untouched on both paths: graft g2 is carrier-independent.
 */
export function budget(
  frame: SceneFrame,
  laneId: string | null,
  alarm: boolean,
  source: Ink,
): Ink {
  if (frame.palette.band.carrier === 'luminance') {
    return spend(source, frame.salience, laneId, alarm)
  }
  if (alarm) return source
  const faded = fade(source, emphasisOf(frame.salience, laneId, alarm))
  return capPresence(faded, frame.palette.ground, frame.palette.band.calmCeiling)
}

/**
 * The budget as a **working tip** spends it (prd10 ruling 4's amendment),
 * dispatched like {@link budget}: dark takes `salience.ts`'s `spendTip`
 * verbatim; paper takes the presence twin at the light band's own tip ceiling.
 * Still not exempt from the fade on either path — a summons arrives and every
 * tip in the fleet gets out of its way, whichever world it is drawn in.
 */
export function budgetTip(frame: SceneFrame, laneId: string | null, source: Ink): Ink {
  if (frame.palette.band.carrier === 'luminance') {
    return spendTip(source, frame.salience, laneId)
  }
  const faded = fade(source, emphasisOf(frame.salience, laneId, false))
  return capPresence(faded, frame.palette.ground, frame.palette.band.tipCeiling)
}
