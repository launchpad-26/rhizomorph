/**
 * THE SPRING — one step, closed-form, stable at any frame length.
 *
 * Structural motion (a lane appearing, a lane disconnecting, a reflow) is the
 * one class in the budget that is a *spring* rather than a curve, because it is
 * the one class that can be retargeted mid-flight: the set of lanes can change
 * while the last change is still settling, and a spring carries its velocity
 * across that where a timeline restarts from zero.
 *
 * It is hand-rolled, and it is hand-rolled for one measured reason. The obvious
 * implementation — semi-implicit Euler, stepped with the real frame delta —
 * **diverges** on long frames: at dt = 1/10 s the research's k=170 spring
 * reaches −5.2e8 within twenty steps, and long frames are not hypothetical
 * (a backgrounded tab, a GC pause, twenty agents landing at once). What comes
 * back on screen is then geometry flung somewhere off the canvas.
 *
 * So this is the closed form of the critically-damped case instead. For ω = √k
 * and d = x − target:
 *
 *     x' = target + (d + (v + ωd)·dt)·e^(−ω·dt)
 *     v' = (v − (v + ωd)·ω·dt)·e^(−ω·dt)
 *
 * That is the *exact* solution sampled at dt rather than an approximation
 * marched toward it, so it is unconditionally stable: one 2-second step lands
 * where two hundred 10 ms steps land, and neither can overshoot. `spring.test.ts`
 * pins both halves — the divergence we are avoiding, and the stability we get.
 *
 * Critically damped only (ζ = 1). That is not a limitation, it is the ruling:
 * bounce on a structural change reads as recoil — "it failed" rather than "it
 * completed" — so there is deliberately no way to ask this file for any.
 */

export interface SpringState {
  /** Where it is now. */
  x: number
  /** How fast it is going, in units per **second**. */
  v: number
}

/**
 * The damping that makes a spring of this stiffness critically damped: the
 * fastest approach that never crosses its target. Mass is 1 throughout — a
 * separate mass only rescales k and c, and one knob is one fewer thing to get
 * wrong.
 */
export function criticalDamping(stiffness: number): number {
  return 2 * Math.sqrt(stiffness)
}

/**
 * Advance a critically-damped spring by `dtMs`, in one step, at any dt.
 *
 * The step is dt-independent in the strong sense: stepping 500 ms once and
 * stepping it as fifty 10 ms frames agree to floating-point noise, which is why
 * a scene that was in a background tab resumes composed instead of exploded.
 */
export function springStep(
  state: SpringState,
  target: number,
  stiffness: number,
  dtMs: number,
): SpringState {
  if (!(dtMs > 0)) return state

  const dt = dtMs / 1_000
  const omega = Math.sqrt(stiffness)
  const d = state.x - target
  // The velocity the closed form is built around: what the displacement would
  // need to be moving at for the exponential envelope to describe both.
  const c = state.v + omega * d
  const decay = Math.exp(-omega * dt)

  return {
    x: target + (d + c * dt) * decay,
    v: (state.v - c * omega * dt) * decay,
  }
}

/**
 * Rest thresholds, as fractions of the journey rather than absolutes — the same
 * shape Motion's `restDelta`/`restSpeed` take, so a 4-pixel settle and a
 * 400-pixel one are called finished at the same point in their arc.
 */
export const REST_DELTA = 0.01
export const REST_SPEED = 0.1

/**
 * Has it arrived? Both halves matter: a spring passing *through* its target at
 * speed is at the right place and is not at rest, and stopping there would drop
 * the second half of the movement.
 *
 * `distance` is the length of the journey the thresholds are relative to.
 */
export function atRest(state: SpringState, target: number, distance = 1): boolean {
  const scale = Math.max(1e-9, Math.abs(distance))
  return Math.abs(state.x - target) <= REST_DELTA * scale && Math.abs(state.v) <= REST_SPEED * scale
}
