import { describe, expect, it } from 'vitest'
import { RECENCY_SPAN_MS } from './geometry.js'
import { RETURN } from './retire.js'
import {
  ALARM,
  AMBIENT,
  DISSOLUTION,
  DISSOLUTION_CAUSES,
  EVENT,
  STRUCTURAL,
  STRUCTURAL_DAMPING,
  alarmPulse,
  allowance,
  reflowDelayMs,
  reflowSchedule,
  type MotionClass,
  type MotionMode,
} from './motion.js'
import { BREATH_DEPTH, BREATH_PERIOD_MS, breathOf } from './marks/frame.js'

/**
 * THE MOTION BUDGET, AS LAW.
 *
 * Ruling 4 pinned three classes and a set of numbers. This file is where those
 * numbers stop being a document: every claim below is one a future tuning pass
 * has to argue with rather than quietly break, in the same way `CALM_FLOOR` is.
 *
 * The two that matter most are the two that fail invisibly. An ambient layer
 * that creeps above 3% stops being ignorable and starts costing the attention it
 * was supposed to save; a scene that animates every event at once looks *busier*
 * and reports less, and nobody watching it can tell which of the two it is
 * doing.
 */

const CLASSES: MotionClass[] = ['ambient', 'event', 'structural', 'dissolution']
/** The three prd5 ruling 4 pinned. The fourth is prd10 ruling 10's, below. */
const ORIGINAL: MotionClass[] = ['ambient', 'event', 'structural']

describe('the ambient class — sub-threshold or nothing', () => {
  it('breathes inside the amplitude ceiling', () => {
    expect(BREATH_DEPTH).toBeLessThanOrEqual(AMBIENT.maxAmplitude)

    // …and the drawn amplitude, not just the constant: whatever the phase, the
    // root-mass is within 3% of its resting size.
    for (let t = 0; t < BREATH_PERIOD_MS; t += 37) {
      expect(Math.abs(breathOf(t, 'full') - 1)).toBeLessThanOrEqual(AMBIENT.maxAmplitude)
    }
  })

  it('breathes inside the period band, and actually completes a cycle', () => {
    expect(BREATH_PERIOD_MS).toBeGreaterThanOrEqual(AMBIENT.minPeriodMs)
    expect(BREATH_PERIOD_MS).toBeLessThanOrEqual(AMBIENT.maxPeriodMs)

    // A period is only a period if the wave comes back to where it started.
    expect(breathOf(BREATH_PERIOD_MS, 'full')).toBeCloseTo(breathOf(0, 'full'), 9)
    expect(breathOf(BREATH_PERIOD_MS / 4, 'full')).toBeGreaterThan(1)
    expect(breathOf((BREATH_PERIOD_MS * 3) / 4, 'full')).toBeLessThan(1)
  })

  it('holds still under reduced motion and under pause', () => {
    for (const mode of ['reduced', 'paused'] as MotionMode[]) {
      for (let t = 0; t < BREATH_PERIOD_MS; t += 211) {
        expect(breathOf(t, mode), `breathing while ${mode}`).toBe(1)
      }
    }
  })
})

describe('the event class — five is the tracking limit', () => {
  it('caps concurrency where people stop being able to follow', () => {
    // Pylyshyn & Storm: ~4–5 independent targets. The enforcement is in
    // `pulses.ts`; this is the number it enforces.
    expect(EVENT.maxConcurrent).toBe(5)
  })

  it('keeps a pulse inside the 400–600 ms band', () => {
    expect(EVENT.minPulseMs).toBe(400)
    expect(EVENT.maxPulseMs).toBe(600)
    expect(EVENT.minPulseMs).toBeLessThan(EVENT.maxPulseMs)
  })

  it('strikes a flare fast and lets it fall slowly', () => {
    // Asymmetric on purpose: the arrival is the moment, the decay is the memory
    // of it. A symmetric flare reads as a light being turned on rather than as
    // something landing.
    expect(EVENT.flareInMs).toBe(150)
    expect(EVENT.flareOutMs).toBe(500)
    expect(EVENT.flareInMs).toBeLessThan(EVENT.flareOutMs)
  })
})

describe('the structural class — 800 ms, damped, staggered', () => {
  it('carries the measured spring pair', () => {
    expect(STRUCTURAL.durationMs).toBe(800)
    expect(STRUCTURAL.stiffness).toBe(170)
    expect(STRUCTURAL_DAMPING).toBeCloseTo(26.08, 2)
  })

  it('never sets more than two lanes off at once', () => {
    const schedule = reflowSchedule(24)
    const together = new Map<number, number>()
    for (const delay of schedule) together.set(delay, (together.get(delay) ?? 0) + 1)

    for (const [delay, count] of together) {
      // The tail is the one exception, and it is a deliberate one: past the
      // ceiling the wave has stopped explaining the change it is describing.
      if (delay === STRUCTURAL.maxStaggerMs) continue
      expect(count, `${count} lanes left together at ${delay}ms`).toBeLessThanOrEqual(
        STRUCTURAL.maxConcurrent,
      )
    }
  })

  it('staggers the pairs inside the 60–90 ms band', () => {
    const steps = [...new Set(reflowSchedule(12))].sort((a, b) => a - b)
    expect(steps.length).toBeGreaterThan(1)

    for (let i = 1; i < steps.length; i += 1) {
      const gap = (steps[i] as number) - (steps[i - 1] as number)
      expect(gap).toBeGreaterThanOrEqual(60)
      expect(gap).toBeLessThanOrEqual(90)
    }
  })

  it('starts the first lane immediately and never runs the ramp away', () => {
    expect(reflowDelayMs(0)).toBe(0)
    expect(reflowDelayMs(1)).toBe(0)
    expect(reflowDelayMs(2)).toBe(STRUCTURAL.staggerMs)
    // A thirty-lane fleet: the last lane still moves inside half a second.
    expect(reflowDelayMs(29)).toBe(STRUCTURAL.maxStaggerMs)
    expect(reflowDelayMs(3_000)).toBe(STRUCTURAL.maxStaggerMs)
  })

  it('is monotone — a later lane never sets off before an earlier one', () => {
    const schedule = reflowSchedule(40)
    for (let i = 1; i < schedule.length; i += 1) {
      expect(schedule[i] as number).toBeGreaterThanOrEqual(schedule[i - 1] as number)
    }
  })
})

/**
 * THE FOURTH CLASS (prd10 ruling 10) — its bounds, as the ruling asked for them:
 * "the class ships with its bounds as tests".
 *
 * Four of the five clauses below are about what the class may **not** do, which is
 * the shape a new motion class has to be pinned in. A budget's failure mode is not
 * that a number is wrong; it is that the number quietly stops applying — so the
 * assertions are the cap, the per-lane share, the luminance-only rule in *every*
 * mode, and the exhaustive list of things allowed to spawn one.
 */
describe('the dissolution class — matter returning, and nothing else', () => {
  it('caps the pool where a frame can still hold it', () => {
    // 240, measured against the existing scene in `perf.test.ts` — a sprite blit
    // at this count is 0.017 ms/frame of a 16.67 ms budget, alongside a 30-lane
    // picture that costs about five.
    expect(DISSOLUTION.maxLive).toBe(240)
    // …and no single lane may take more than a sixth of it, so a huge landing
    // cannot starve the two cords beside it (the structural cap allows two at
    // once, and the queue means more than two can be composting).
    expect(DISSOLUTION.maxPerLane).toBeLessThanOrEqual(DISSOLUTION.maxLive / 6)
  })

  it('fades in luminance only — in every mode, including full', () => {
    // The rule the class exists to enforce, and the one place a "within reason"
    // reading would have quietly killed it: `scale` is refused even when nothing
    // else is. A mote that grew as it dimmed would read as coming toward the
    // viewer, and nothing in this picture has a Z axis.
    for (const mode of ['full', 'reduced', 'paused'] as MotionMode[]) {
      expect(allowance('dissolution', mode).scale, `scaling while ${mode}`).toBe(false)
    }
    // It does travel, though — a return that stayed put would not be a return.
    expect(allowance('dissolution', 'full').travel).toBe(true)
    expect(allowance('dissolution', 'full').opacity).toBe(true)
  })

  it('holds still under pause, unlike the structural act that caused it', () => {
    // A cut is allowed to finish through a pause because a half-cut cord is a
    // picture of a topology that does not exist. A half-composted one is not: the
    // topology is settled either way, so the drift freezes with everything else
    // the operator asked to stop.
    expect(allowance('dissolution', 'paused')).toEqual(allowance('ambient', 'paused'))
    expect(allowance('dissolution', 'paused')).not.toEqual(allowance('structural', 'paused'))
  })

  it('may only ever be spawned by a severance or an absorption', () => {
    // Exhaustive, and a *type* rather than a convention: `DissolutionCause` makes
    // "some idle lane started emitting motes because it looked nice" unwriteable.
    // The runtime list is what makes the exhaustiveness checkable — a third member
    // added to the union without a reason would fail here.
    expect([...DISSOLUTION_CAUSES].sort()).toEqual(['absorption', 'severance'])
  })

  it('ends the moment its last mote lands, and not before', () => {
    // The two spans have to agree or the act reads wrong at one end: too short and
    // the last mote is cut off in flight (an amputation, which is the one thing
    // ruling 1 forbids a return to look like); too long and the dissolve sits
    // finished with nothing on screen. One mote's life inside one cord's span.
    expect(DISSOLUTION.moteLifeMs).toBeLessThan(DISSOLUTION.spanMs)
    // …and the drift outlives the settle it came from, which is what makes "the
    // matter is home" a later instant than "the strand has gone still". Ruling 13
    // took the erasure off the later instant; the two clocks are unchanged.
    expect(DISSOLUTION.spanMs).toBeGreaterThan(RETURN.totalMs)
    expect(RETURN.dissolvedMs).toBeGreaterThan(RETURN.totalMs)
  })

  it('moves none of the three caps that were already law', () => {
    // The cheapest way to smuggle a sixth simultaneous pulse into this scene would
    // be to widen the event cap while adding a class nobody was watching.
    expect(AMBIENT.maxAmplitude).toBe(0.03)
    expect(EVENT.maxConcurrent).toBe(5)
    expect(STRUCTURAL.maxConcurrent).toBe(2)
    expect(STRUCTURAL.durationMs).toBe(800)
    // …and the older three still degrade exactly as they did.
    for (const motionClass of ORIGINAL) {
      expect(allowance(motionClass, 'full').scale, `${motionClass} lost its scale`).toBe(true)
    }
  })
})

describe('the degradation table', () => {
  it('keeps colour and opacity and drops travel and scale, under reduced motion', () => {
    // WCAG 2.3.3 excludes colour, blur and opacity from "motion animation".
    // That exclusion is the whole map, and it applies to every class — the fourth
    // included, which is why a reduced-motion cut composts nothing: it never
    // travelled, so there was no journey to come apart along.
    for (const motionClass of CLASSES) {
      expect(allowance(motionClass, 'reduced')).toEqual({
        travel: false,
        scale: false,
        colour: true,
        opacity: true,
      })
    }
  })

  it('freezes ambient and event outright when the operator pauses', () => {
    // WCAG 2.2.2 is Level A and covers blinking as well as moving, so pause is
    // stricter than reduce: nothing automatic changes at all.
    for (const motionClass of ['ambient', 'event'] as MotionClass[]) {
      expect(allowance(motionClass, 'paused')).toEqual({
        travel: false,
        scale: false,
        colour: false,
        opacity: false,
      })
    }
  })

  it('lets structural motion settle through a pause rather than freezing half-way', () => {
    // A thread caught mid-grow is a picture of a topology that does not exist.
    expect(allowance('structural', 'paused')).toEqual(allowance('structural', 'full'))
  })

  it('allows everything at full', () => {
    // The three prd5 pinned. The fourth is luminance-only by construction and has
    // its own clause above — a class that fades rather than scales is the whole of
    // what ruling 10 added, so it is deliberately not in this loop.
    for (const motionClass of ORIGINAL) {
      expect(allowance(motionClass, 'full')).toEqual({
        travel: true,
        scale: true,
        colour: true,
        opacity: true,
      })
    }
  })
})

describe('the alarm pulse ages (ruling 5)', () => {
  const ages = Array.from({ length: 41 }, (_unused, i) => (i / 20) * RECENCY_SPAN_MS)

  it('slows as the summons ages, and never speeds up', () => {
    let previous = 0
    for (const age of ages) {
      const { periodMs } = alarmPulse(age, 'full')
      expect(periodMs, `period fell at age ${age}ms`).toBeGreaterThanOrEqual(previous)
      previous = periodMs
    }

    expect(alarmPulse(0, 'full').periodMs).toBe(ALARM.freshPeriodMs)
    expect(alarmPulse(RECENCY_SPAN_MS, 'full').periodMs).toBeCloseTo(ALARM.agedPeriodMs, 9)
    // Never frantic: an hour-old alarm pulses at the floor rate, not faster.
    expect(alarmPulse(60 * 60_000, 'full').periodMs).toBe(ALARM.agedPeriodMs)
  })

  it('brightens monotonically to a cap and stops there', () => {
    let previous = 0
    for (const age of ages) {
      const { intensity } = alarmPulse(age, 'full')
      expect(intensity).toBeGreaterThanOrEqual(previous)
      expect(intensity).toBeLessThanOrEqual(ALARM.maxIntensity)
      previous = intensity
    }

    expect(alarmPulse(0, 'full').intensity).toBe(ALARM.freshIntensity)
    expect(alarmPulse(RECENCY_SPAN_MS, 'full').intensity).toBe(ALARM.maxIntensity)
    expect(alarmPulse(10 * RECENCY_SPAN_MS, 'full').intensity).toBe(ALARM.maxIntensity)
  })

  it('keeps throbbing past the recency span', () => {
    // The phase is integrated over the lane's own age, and the age does not stop
    // at ten minutes. An alarm that went still would read as answered.
    const late = Array.from({ length: 200 }, (_unused, i) =>
      alarmPulse(RECENCY_SPAN_MS * 2 + i * 60, 'full').throb,
    )
    expect(Math.max(...late) - Math.min(...late)).toBeGreaterThan(0.9)
  })

  it('slows smoothly — no hitch anywhere along the ramp', () => {
    // The naive `sin(now / period)` jumps by hundreds of cycles the moment the
    // period moves, because `now` is an epoch. This is the assertion that
    // catches anyone who reintroduces it.
    let previous = alarmPulse(0, 'full').throb
    let maxJump = 0
    let maxJumpAge = 0
    for (let age = 8; age <= RECENCY_SPAN_MS * 1.5; age += 8) {
      const { throb } = alarmPulse(age, 'full')
      const jump = Math.abs(throb - previous)
      if (jump > maxJump) {
        maxJump = jump
        maxJumpAge = age
      }
      previous = throb
    }
    expect(maxJump, `throb jumped at age ${maxJumpAge}ms`).toBeLessThan(0.05)
  })

  it('stays inside its band and completes real cycles', () => {
    const sampled = Array.from({ length: 400 }, (_unused, i) => alarmPulse(i * 12, 'full').throb)
    expect(Math.min(...sampled)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...sampled)).toBeLessThanOrEqual(1)
    expect(Math.max(...sampled)).toBeGreaterThan(0.98)
    expect(Math.min(...sampled)).toBeLessThan(0.02)
  })

  it('holds still — but stays bright — when motion is reduced or paused', () => {
    for (const mode of ['reduced', 'paused'] as MotionMode[]) {
      const early = alarmPulse(1_000, mode)
      const later = alarmPulse(1_300, mode)
      expect(early.throb).toBe(ALARM.restThrob)
      expect(later.throb).toBe(ALARM.restThrob)
      // Colour and opacity survive the degradation; only the movement goes.
      expect(alarmPulse(RECENCY_SPAN_MS, mode).intensity).toBe(ALARM.maxIntensity)
    }
  })
})
