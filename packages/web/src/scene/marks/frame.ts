import type { Fleet } from '../../fleet/index.js'
import type { SceneGeometry } from '../geometry.js'
import type { Ink } from '../palette.js'
import type { PulseField } from '../pulses.js'
import { spend, type Salience } from '../salience.js'

/**
 * One frame's worth of inputs, shared by every mark builder.
 *
 * `breath` is the scene's single ambient motion (law 10) — ±{@link BREATH_DEPTH}
 * on the root-mass, and nothing else in the picture is allowed to move without an
 * event behind it. Under `prefers-reduced-motion` it is pinned at 1, which is why
 * it is computed once here rather than re-derived by whoever wants it.
 */
export interface SceneFrame {
  fleet: Fleet
  geometry: SceneGeometry
  field: PulseField
  salience: Salience
  now: number
  reducedMotion: boolean
  /** Multiplier around 1. The root-mass's slow inhale. */
  breath: number
}

/** ±1.6% — visible as life, invisible as movement. */
export const BREATH_DEPTH = 0.016
/** Matches `--duration-breath` in the theme. */
export const BREATH_PERIOD_MS = 5_400

export function breathOf(now: number, reducedMotion: boolean): number {
  if (reducedMotion) return 1
  return 1 + BREATH_DEPTH * Math.sin((now / BREATH_PERIOD_MS) * Math.PI * 2)
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
