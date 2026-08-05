import { createEventFactory, type EventFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { IDLE_AFTER_MS } from '../fleet/buildFleet.js'

/**
 * Generated logs for the TIDE's property-style laws (#167).
 *
 * The band laws are claims about *every* event sequence, not about three
 * fixtures, so they are checked against sequences a seeded generator builds.
 * The generator takes its randomness from an LCG rather than `Math.random`, so
 * a failure is reproducible from its seed alone and the suite is hermetic under
 * concurrency — the same rule the scene's variation tests already follow.
 */

export const TIDE_START_TS = Date.UTC(2026, 7, 4, 14, 0, 0)

/** Four handles, so ordering and `+N` coalescing have something to chew on. */
export const TIDE_LANES = ['ke5', 'm2', 'q9', 'w1'] as const

/**
 * Steps straddling {@link IDLE_AFTER_MS} on purpose: the short ones keep a
 * witnessed band alive, the long ones let coverage lapse into a gap, and the
 * zero-length one lands two facts on the same millisecond — the case that
 * produces a band with nothing to cover.
 */
const STEPS_MS = [0, 1_000, 30_000, IDLE_AFTER_MS - 1_000, IDLE_AFTER_MS + 1_000, 7 * 60_000]

type Emit = (fx: EventFactory, lane: string) => RhizomorphEvent

/**
 * Every shape of fact a lane can produce, in the proportions that matter here:
 * declarations (a level), work witnesses (edges), a metrics POST that proves
 * the lane exists without attesting work, and two facts that name no handle at
 * all and must therefore never create a lane.
 */
const EMITTERS: readonly Emit[] = [
  (fx, lane) => fx.agentStatus({ handle: lane, status: 'working' }),
  (fx, lane) => fx.agentStatus({ handle: lane, status: 'waiting' }),
  (fx, lane) => fx.agentStatus({ handle: lane, status: 'done' }),
  (fx, lane) => fx.llmUsage({ lane }),
  (fx, lane) => fx.llmCost({ lane }),
  (fx, lane) => fx.toolActivity({ lane }),
  (fx, lane) => fx.traceSpan({ lane }),
  (fx, lane) => fx.agentActiveTime({ lane }),
  (fx) => fx.paneActivity(),
  (fx) => fx.commitLanded(),
]

/** A 32-bit LCG — Numerical Recipes' constants. Deterministic, seed-reproducible. */
function lcg(seed: number): () => number {
  let state = (seed >>> 0) || 1
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state
  }
}

function pick<T>(items: readonly T[], next: () => number): T {
  return items[next() % items.length] as T
}

/**
 * `count` events over {@link TIDE_LANES}, in non-decreasing `ts` order — the
 * order `jsonl` appends and every law here is stated against.
 */
export function generateEventLog(seed: number, count: number): RhizomorphEvent[] {
  const next = lcg(seed)
  const fx = createEventFactory({ startTs: TIDE_START_TS, stepMs: 0, idPrefix: `gen${seed}` })

  let clock = TIDE_START_TS
  const events: RhizomorphEvent[] = []
  for (let i = 0; i < count; i += 1) {
    clock += pick(STEPS_MS, next)
    fx.at(clock)
    events.push(pick(EMITTERS, next)(fx, pick(TIDE_LANES, next)))
  }
  return events
}
