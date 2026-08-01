import { RECENCY_SPAN_MS } from './geometry.js'
import { clamp01 } from './palette.js'
import { criticalDamping } from './spring.js'

/**
 * THE MOTION BUDGET (prd5 ruling 4, adopted as law).
 *
 * The scene was granted "a little more animation", and this file is the whole
 * of what that grant means. Three classes, hard-separated; **nothing in the
 * picture may move outside one of them**, and every number below is a ruling
 * rather than a taste, so `motion.test.ts` reads them the way `salience.test.ts`
 * reads `CALM_FLOOR`.
 *
 * | class          | what moves                                  | budget                                  |
 * | -------------- | ------------------------------------------- | --------------------------------------- |
 * | **ambient**    | the root-mass breath, any idle life         | 4–8 s period, ≤3% amplitude, unlimited  |
 * | **event**      | pulse travel, arrival flare, alarm throb    | 400–600 ms; flare 150 in / 500 out; ≤5  |
 * | **structural** | a lane appearing, reflowing, disconnecting  | ~800 ms critically damped; ≤2, staggered |
 *
 * Two of those caps are load-bearing rather than decorative:
 *
 * - **Ambient must be sub-threshold.** Calm technology's whole claim is that a
 *   display earns the periphery only if it can be *ignored*; the moment a viewer
 *   has to consciously suppress the movement, the ambient layer has failed and
 *   is costing attention rather than reporting. ≤3% at 4–8 s is life you notice
 *   only when it stops.
 * - **Five is the human tracking limit.** Pylyshyn & Storm measured people
 *   following ~4–5 independent moving targets among identical distractors and
 *   failing beyond that. A scene that fires twelve simultaneous pulses conveys
 *   "lots happening" and nothing else — so above the cap the field coalesces
 *   into one aggregate pulse **carrying a count** (`pulses.ts`), which is the
 *   existing law "traffic is coalesced, never invented" extended to motion.
 *
 * The three modes are the accessibility half, and they are not the same thing:
 *
 * - `reduced` is `prefers-reduced-motion` — WCAG 2.3.3 excludes colour, blur and
 *   opacity from "motion animation", and that exclusion *is* the degradation
 *   map: keep colour and opacity, drop travel and scale.
 * - `paused` is the operator pressing the pause control — WCAG 2.2.2 is Level A
 *   and an always-breathing canvas trips it, so this one stops *everything*
 *   automatic, brightness included. Structural motion is the exception: it is a
 *   one-shot that ends in a new resting state, and freezing it half-way would
 *   leave the picture showing a topology that does not exist. It settles, then
 *   it stops.
 */

export type MotionClass = 'ambient' | 'event' | 'structural'

export type MotionMode = 'full' | 'reduced' | 'paused'

/** Always on, always ignorable. */
export const AMBIENT = {
  minPeriodMs: 4_000,
  maxPeriodMs: 8_000,
  /** As a fraction of the thing that moves. ±3% is the ceiling, not the target. */
  maxAmplitude: 0.03,
} as const

/** Real data arriving. Bounded by what a person can actually follow. */
export const EVENT = {
  minPulseMs: 400,
  maxPulseMs: 600,
  /** Fast in, slow out: a flare is struck, not faded up. */
  flareInMs: 150,
  flareOutMs: 500,
  /** The tracking limit. Past it, one aggregate pulse with a count. */
  maxConcurrent: 5,
} as const

/** Topology changing. The one expressive class, and the one that uses a spring. */
export const STRUCTURAL = {
  /** Perceptual duration, not settling time — 800 ms is what it reads as. */
  durationMs: 800,
  /** k = 170, c = 2√170 ≈ 26: the measured pair that lands on 800 ms flat. */
  stiffness: 170,
  maxConcurrent: 2,
  /** Between one pair of lanes and the next, when several reflow together. */
  staggerMs: 75,
  /**
   * …and no further. A wave that takes longer than the change it is explaining
   * has stopped explaining it, so past this the rest of the fleet moves together.
   */
  maxStaggerMs: 450,
} as const

/** c ≈ 26. Exported so the number in the ruling is checkable, not just claimed. */
export const STRUCTURAL_DAMPING = criticalDamping(STRUCTURAL.stiffness)

/**
 * What a class may animate in a given mode.
 *
 * Every field is about *change over time* — `colour: false` does not mean a mark
 * is drawn colourless, it means its colour may not oscillate. The travel/scale
 * pair is exactly WCAG 2.3.3's "motion animation"; the colour/opacity pair is
 * exactly what that success criterion excludes.
 */
export interface MotionAllowance {
  /** Position: anything that crosses the picture. */
  travel: boolean
  /** Size: breathing, throbbing, growing. */
  scale: boolean
  colour: boolean
  opacity: boolean
}

const FULL: MotionAllowance = { travel: true, scale: true, colour: true, opacity: true }
const NO_MOVEMENT: MotionAllowance = { travel: false, scale: false, colour: true, opacity: true }
const FROZEN: MotionAllowance = { travel: false, scale: false, colour: false, opacity: false }

export function allowance(motionClass: MotionClass, mode: MotionMode): MotionAllowance {
  if (mode === 'full') return FULL
  if (mode === 'reduced') return NO_MOVEMENT
  // Paused. Structural is allowed to finish what it started; nothing else is.
  return motionClass === 'structural' ? FULL : FROZEN
}

/**
 * When lane `index` of a reflow may start moving, in ms after the change.
 *
 * Two constraints, and only one reading satisfies both: no more than
 * {@link STRUCTURAL.maxConcurrent} lanes may *set off* together, and the ones
 * behind them follow a stagger in the 60–90 ms band. So lanes leave in pairs,
 * 75 ms apart, until the ramp hits its ceiling and the remainder go as one.
 *
 * Staggering is what makes several lanes reflowing read as one wave through a
 * structure rather than as everything jumping at once — the thing Heer &
 * Robertson found staged transitions beat single-shot ones at.
 */
export function reflowDelayMs(index: number): number {
  if (index <= 0) return 0
  const group = Math.floor(index / STRUCTURAL.maxConcurrent)
  return Math.min(STRUCTURAL.maxStaggerMs, group * STRUCTURAL.staggerMs)
}

/** The same schedule for a whole reflow, in lane order. */
export function reflowSchedule(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_unused, i) => reflowDelayMs(i))
}

/**
 * THE ALARM PULSE (prd5 ruling 5, the scene's half).
 *
 * A summons may intensify with its own age: the older an unanswered alarm gets,
 * the **slower and brighter** it pulses. Slower, never faster — a fleet that has
 * been waiting twenty minutes for a human should read as insistent, not as
 * panicking, and a rate that climbs with age would turn a neglected scene into a
 * strobe. The brightness climbs to a ceiling and stays there for the same
 * reason: past `maxIntensity` there is nothing left to say and the ladder still
 * rules who is brightest.
 *
 * The age evidence is the lane's own — the recency the geometry already drifts
 * nodes outward on — so nothing new is measured and nothing is invented.
 */
export const ALARM = {
  /** A fresh summons, at twice the event-pulse budget: one cycle, out and back. */
  freshPeriodMs: 2 * EVENT.maxPulseMs,
  /** A summons aged the full recency span. Slower — and this is the floor rate. */
  agedPeriodMs: 2_600,
  /** How loud a fresh summons throbs, against the aged ceiling. */
  freshIntensity: 0.62,
  /** The cap. An old alarm cannot keep getting louder for ever. */
  maxIntensity: 1,
  /** What the throb is pinned at when it may not oscillate. Bright, and still. */
  restThrob: 0.75,
} as const

export interface AlarmPulse {
  /** How long one cycle takes at this age. Never below {@link ALARM.freshPeriodMs}. */
  periodMs: number
  /** 0–1, monotone in age, capped. How much of the mark's headroom it may spend. */
  intensity: number
  /** 0–1 oscillation, or {@link ALARM.restThrob} when the mode forbids movement. */
  throb: number
}

/**
 * The pulse an alarm mark of this age should be drawn at. `ageMs` is the lane's
 * own unclamped age — how long the summons has gone unanswered.
 *
 * The phase is integrated over that age rather than sampled from wall time,
 * which is the only way a lengthening period stays continuous: the naive
 * `sin(now / period)` jumps by hundreds of cycles the instant the period changes
 * by a hair, because `now` is an epoch and the phase scales with it. For a
 * period that ramps linearly, `∫ dτ/(P₀ + kτ)` is a logarithm, so the exact
 * phase is one closed form — and past the recency span, where the period has
 * stopped changing, it continues at the flat aged rate rather than standing
 * still. An alarm that stopped throbbing after ten minutes would read as
 * answered.
 */
export function alarmPulse(ageMs: number, mode: MotionMode): AlarmPulse {
  const age = Math.max(0, ageMs)
  const ramped = Math.min(age, RECENCY_SPAN_MS)
  const { freshPeriodMs: p0, agedPeriodMs: p1 } = ALARM
  const k = (p1 - p0) / RECENCY_SPAN_MS

  const periodMs = p0 + k * ramped
  const intensity = Math.min(
    ALARM.maxIntensity,
    ALARM.freshIntensity +
      (ALARM.maxIntensity - ALARM.freshIntensity) * clamp01(age / RECENCY_SPAN_MS),
  )

  // Scale is the channel a throb spends, so reduced motion and pause both hold
  // it still — the summons stays bright and stops moving, which is ruling 32's
  // existing degradation for the waiting lane, now stated once for every alarm.
  if (!allowance('event', mode).scale) {
    return { periodMs, intensity, throb: ALARM.restThrob }
  }

  const ramp = k === 0 ? ramped / p0 : Math.log(1 + (k * ramped) / p0) / k
  const cycles = ramp + (age - ramped) / p1
  return { periodMs, intensity, throb: 0.5 + 0.5 * Math.sin(cycles * Math.PI * 2) }
}
