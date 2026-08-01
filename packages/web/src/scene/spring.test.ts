import { describe, expect, it } from 'vitest'
import { STRUCTURAL, STRUCTURAL_DAMPING } from './motion.js'
import { atRest, criticalDamping, springStep, type SpringState } from './spring.js'

/**
 * THE SPRING'S TWO LAWS.
 *
 * Both were measured before they were adopted (the prd5 motion research ran
 * them in Node), and both fail in ways that are invisible until they are not:
 *
 * 1. **Stability at any dt.** The naive spring is correct at 60 fps and
 *    catastrophic at 10 — and 10 fps happens to every tab that goes to the
 *    background. The first suite here reproduces the divergence we are avoiding
 *    and then shows the closed form standing still next to it, because a
 *    stability claim with nothing to fail against is a comment, not a test.
 * 2. **Zero overshoot, ~800 ms settle at k=170.** Overshoot on a *structural*
 *    change reads as recoil — "it failed" rather than "it completed" — so the
 *    absence of bounce is part of the encoding rather than a matter of taste.
 */

const START: SpringState = { x: 0, v: 0 }
const TARGET = 1

/** A frame at 60 fps, in ms — what these springs are normally stepped with. */
const FRAME_MS = 1_000 / 60

/**
 * The trap, in nine lines: semi-implicit Euler, the way everyone writes a spring
 * the first time. Correct at short dt, unbounded at long dt.
 */
function naiveEuler(state: SpringState, target: number, k: number, dtMs: number): SpringState {
  const dt = dtMs / 1_000
  const c = criticalDamping(k)
  const acceleration = -k * (state.x - target) - c * state.v
  const v = state.v + acceleration * dt
  return { x: state.x + v * dt, v }
}

function run(
  step: (state: SpringState, dtMs: number) => SpringState,
  dtMs: number,
  steps: number,
  from: SpringState = START,
): SpringState {
  let state = from
  for (let i = 0; i < steps; i += 1) state = step(state, dtMs)
  return state
}

const closed = (state: SpringState, dtMs: number) =>
  springStep(state, TARGET, STRUCTURAL.stiffness, dtMs)

describe('stability — the reason this is not semi-implicit Euler', () => {
  it('reproduces the divergence the research measured at dt = 1/10 s', () => {
    // The measured figure was −5.2e8 after twenty steps. What matters is the
    // magnitude, not the digits: it left the canvas and kept going.
    const blown = run((state, dt) => naiveEuler(state, TARGET, STRUCTURAL.stiffness, dt), 100, 20)
    expect(Math.abs(blown.x)).toBeGreaterThan(1e8)
  })

  it('stays composed through the same twenty long frames', () => {
    const held = run(closed, 100, 20)
    expect(held.x).toBeCloseTo(TARGET, 6)
    expect(atRest(held, TARGET)).toBe(true)
  })

  it('survives a two-second step — a tab coming back from the background', () => {
    const woken = springStep(START, TARGET, STRUCTURAL.stiffness, 2_000)
    expect(woken.x).toBeCloseTo(TARGET, 9)
    expect(woken.v).toBeCloseTo(0, 8)
    // Not merely finite: the whole point is that it resumes *composed*, at the
    // position two hundred short frames would have brought it to.
    expect(Math.abs(woken.x - run(closed, 10, 200).x)).toBeLessThan(1e-6)
  })

  it('is dt-independent: one long step lands where many short ones do', () => {
    const once = springStep(START, TARGET, STRUCTURAL.stiffness, 500)
    const many = run(closed, 5, 100)
    expect(once.x).toBeCloseTo(many.x, 9)
    expect(once.v).toBeCloseTo(many.v, 6)
  })

  it('does nothing at all for a zero or backwards frame', () => {
    expect(springStep(START, TARGET, STRUCTURAL.stiffness, 0)).toBe(START)
    expect(springStep(START, TARGET, STRUCTURAL.stiffness, -16)).toBe(START)
  })
})

describe('the structural spring — k = 170, critically damped', () => {
  it('is damped exactly critically, c = 2√k ≈ 26', () => {
    expect(STRUCTURAL_DAMPING).toBeCloseTo(26.08, 2)
    expect(STRUCTURAL_DAMPING).toBe(2 * Math.sqrt(STRUCTURAL.stiffness))
  })

  it('settles inside the structural budget', () => {
    // 833 ms is the figure the research measured for this pair. The budget the
    // ruling wrote down is ~800 ms, and this settles comfortably inside both.
    let state = START
    let settledAt: number | null = null
    for (let t = FRAME_MS; t <= 2_000; t += FRAME_MS) {
      state = closed(state, FRAME_MS)
      if (settledAt === null && atRest(state, TARGET)) settledAt = t
    }

    expect(settledAt).not.toBeNull()
    expect(settledAt as number).toBeLessThanOrEqual(833)
  })

  it('is still visibly moving early on — 800 ms is a duration, not a snap', () => {
    // The other side of the budget. A spring that arrived in 100 ms would pass
    // the settle assertion and would not be structural motion at all.
    const early = run(closed, FRAME_MS, 6) // ~100 ms
    expect(early.x).toBeLessThan(0.75)
    expect(atRest(early, TARGET)).toBe(false)
  })

  it('never overshoots, at any frame length', () => {
    for (const dt of [4, FRAME_MS, 50, 250, 1_000]) {
      let state = START
      for (let i = 0; i < 200; i += 1) {
        state = closed(state, dt)
        expect(state.x, `overshot at dt=${dt}ms`).toBeLessThanOrEqual(TARGET + 1e-12)
      }
    }
  })

  it('carries its velocity when the target moves mid-flight', () => {
    // The whole reason structural motion is a spring rather than a curve: the
    // set of lanes can change while the last change is still settling.
    const flying = run(closed, FRAME_MS, 8)
    expect(flying.v).toBeGreaterThan(0)

    const retargeted = springStep(flying, 2, STRUCTURAL.stiffness, FRAME_MS)
    // It keeps going the way it was going rather than restarting from rest.
    expect(retargeted.x).toBeGreaterThan(flying.x)
    expect(retargeted.v).toBeGreaterThan(0)
  })
})

describe('rest', () => {
  it('is not satisfied by passing through the target at speed', () => {
    expect(atRest({ x: TARGET, v: 4 }, TARGET)).toBe(false)
    expect(atRest({ x: TARGET, v: 0 }, TARGET)).toBe(true)
  })

  it('scales its thresholds to the length of the journey', () => {
    // 2 px out of 400 is arrived; 2 px out of 4 is not.
    expect(atRest({ x: 398, v: 0 }, 400, 400)).toBe(true)
    expect(atRest({ x: 2, v: 0 }, 4, 4)).toBe(false)
  })
})
