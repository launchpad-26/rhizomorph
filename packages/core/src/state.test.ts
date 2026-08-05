import { describe, expect, it } from 'vitest'
import { reduce, reduceAll } from './reduce.js'
import { fx } from './fixtures.js'
import {
  basename,
  initialSessionState,
  initialTelemetryState,
  type SessionState,
} from './state.js'

/**
 * The state *contract* — the shape itself, as opposed to what the fold puts in
 * it (`reduce.test.ts`) or what surfaces read out of it (`selectors/`).
 *
 * #179 reshaped how the telemetry fold finds things without reshaping what the
 * telemetry slice holds, and that "without" is load-bearing: it is what let a
 * quadratic scan become an O(1) lookup with no wire format, no stored file, and
 * no selector touched. The laws below are the two halves of that promise.
 */

describe('TelemetryState — the slice holds recorded fact, and nothing else', () => {
  /**
   * The fold's lookup tables are derived, so they live beside the reducer, not
   * here (see `UsageIndex` in `reduce.ts`). This test is the tripwire: adding a
   * `byRequest` — or any other accelerator — to the slice fails here first,
   * where the argument is written down, rather than in the additivity oracle in
   * `reduce.telemetry.test.ts`, which pins the same key set from the far end
   * and would otherwise be the only thing to say no.
   */
  it('is exactly six keys, empty and folded alike', () => {
    const keys = ['usage', 'costs', 'tools', 'activeTime', 'lanes', 'sessions']
    expect(Object.keys(initialTelemetryState()).sort()).toEqual([...keys].sort())

    const folded = reduceAll([
      fx.llmUsage({ lane: 'a', requestId: 'req_1', sessionId: 'sess-a' }),
      fx.llmCost({ lane: 'a', sessionId: 'sess-a' }),
      fx.toolActivity({ lane: 'a', tool: 'Bash', sessionId: 'sess-a' }),
      fx.agentActiveTime({ lane: 'a', sessionId: 'sess-a' }),
    ])
    expect(Object.keys(folded.telemetry).sort()).toEqual([...keys].sort())
  })

  /**
   * Every value in the slice survives `JSON.stringify` — no `Map`, no `Set`, no
   * class instance anywhere in it. `SessionState` never crosses a wire or a
   * disk today (the recorder persists *events*; `/api/stream` serialises
   * events; the web folds its own copy), so this is not a compatibility
   * requirement — it is the cheapest available proof that nothing which cannot
   * be a recorded fact has crept into the slice.
   */
  it('round-trips through JSON unchanged — no Map, no Set, no instance', () => {
    const folded = reduceAll([
      fx.llmUsage({ lane: 'a', requestId: 'req_2', sessionId: 'sess-a' }),
      fx.llmCost({ lane: 'a', sessionId: 'sess-a' }),
    ])
    expect(JSON.parse(JSON.stringify(folded.telemetry))).toEqual(folded.telemetry)
  })
})

describe('initialSessionState — fresh containers, never shared ones', () => {
  /**
   * The reason this matters is not tidiness. The telemetry fold's lookup tables
   * are keyed by the *identity* of the array they describe (#179), so an
   * `initialTelemetryState` that handed every caller one shared `[]` would hand
   * every independent fold the same key — one session's table answering another
   * session's questions. Freshness is what makes identity-keying sound.
   */
  it('hands out a new object graph on every call', () => {
    const a = initialSessionState()
    const b = initialSessionState()

    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.telemetry).not.toBe(b.telemetry)
    expect(a.telemetry.usage).not.toBe(b.telemetry.usage)
    expect(a.telemetry.costs).not.toBe(b.telemetry.costs)
    expect(a.telemetry.tools).not.toBe(b.telemetry.tools)
    expect(a.telemetry.activeTime).not.toBe(b.telemetry.activeTime)
    expect(a.telemetry.lanes).not.toBe(b.telemetry.lanes)
    expect(a.telemetry.sessions).not.toBe(b.telemetry.sessions)
    expect(a.traces.spans).not.toBe(b.traces.spans)
    expect(a.commitOrder).not.toBe(b.commitOrder)
    expect(a.errors).not.toBe(b.errors)
  })

  /**
   * The same freshness from the other direction: two folds started from two
   * initial states cannot leak into each other, however alike their events are.
   */
  it('keeps two independently started folds apart', () => {
    const one = reduce(initialSessionState(), fx.llmUsage({ lane: 'a', requestId: 'req_same', sessionId: 'sess-a' }))
    const two = reduce(initialSessionState(), fx.llmUsage({ lane: 'a', requestId: 'req_same', sessionId: 'sess-a' }))

    expect(one.telemetry.usage).toHaveLength(1)
    expect(two.telemetry.usage).toHaveLength(1)
    expect(one.telemetry.usage).not.toBe(two.telemetry.usage)
  })

  /**
   * The fold never writes back into the state it was handed — the law every
   * surface holding a previous frame depends on, and the one an index kept as
   * a mutable field would have broken. `reduce.telemetry.test.ts` states it for
   * the telemetry records; this is it for the state object as a whole.
   */
  it('leaves the state it folded from untouched', () => {
    const before: SessionState = reduceAll([
      fx.llmUsage({ lane: 'a', requestId: 'req_3', sessionId: 'sess-a' }),
      fx.llmCost({ lane: 'a', sessionId: 'sess-a' }),
    ])
    const snapshot = JSON.stringify(before)
    reduce(before, fx.llmUsage({ lane: 'a', requestId: 'req_4', sessionId: 'sess-a' }))
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('basename — the browser-safe path tail', () => {
  it('takes the last segment, trailing slashes and all', () => {
    expect(basename('/repo/rhizomorph-wt/feature')).toBe('feature')
    expect(basename('/repo/rhizomorph-wt/feature/')).toBe('feature')
    expect(basename('feature')).toBe('feature')
  })

  it('hands back what it was given when there is no segment to take', () => {
    expect(basename('/')).toBe('/')
    expect(basename('')).toBe('')
  })
})
