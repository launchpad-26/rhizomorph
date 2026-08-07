import { describe, expect, it } from 'vitest'
import { reduce, reduceAll } from './reduce.js'
import { fx } from './fixtures.js'
import {
  MAX_REFUSALS,
  basename,
  initialRefusalState,
  initialSessionState,
  initialTelemetryState,
  initialTraceState,
  refusalIndexOf,
  refusalStateWith,
  traceStateOf,
  type RefusalRecord,
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

/**
 * prd9's slice, under the same contract and by #184 the same discipline. The
 * fold stopped *accumulating* `byTrace`/`bySession` — an immutable Record
 * insert per span event, which copies every key the session has — and now
 * hands out the spans array with the two indexes derived from it on demand.
 *
 * That is a change of arithmetic, not of contract, and these laws are what
 * says so: the slice is the same three keys, holding the same values, writing
 * the same bytes. The key set is pinned here *and* by the additivity oracle in
 * `reduce.telemetry.test.ts`; this is the end where the argument is written
 * down.
 */
describe('TraceState — the slice is its spans, and two projections of them', () => {
  const spanned = (): SessionState =>
    reduceAll([
      fx.traceSpan({ traceId: 'trace-a', spanId: 'span-1', parentSpanId: null, sessionId: 'sess-a' }),
      fx.traceSpan({ traceId: 'trace-a', spanId: 'span-2', parentSpanId: null, sessionId: 'sess-a' }),
      fx.traceSpan({ traceId: 'trace-b', spanId: 'span-3', parentSpanId: null, sessionId: null }),
    ])

  it('is exactly three keys, empty and folded alike', () => {
    const keys = ['spans', 'byTrace', 'bySession']
    expect(Object.keys(initialTraceState()).sort()).toEqual([...keys].sort())
    expect(Object.keys(spanned().traces).sort()).toEqual([...keys].sort())
  })

  /**
   * The same proof `TelemetryState` gets, and #184 needs it more: a derived
   * index is exactly the kind of thing that wants to be a `Map`, and a `Map`
   * in the slice would serialise to `{}` while every `toEqual` in the suite
   * went on passing. `SessionState` still crosses no wire and no disk — the
   * recorder persists *events* — so this is not compatibility, it is the
   * cheapest available proof that the slice is still plain recorded shape.
   */
  it('round-trips through JSON unchanged — no Map, no Set, no instance', () => {
    const traces = spanned().traces
    expect(JSON.parse(JSON.stringify(traces))).toEqual(traces)
    expect(JSON.parse(JSON.stringify(traces)).byTrace).toEqual({ 'trace-a': [0, 1], 'trace-b': [2] })
    expect(JSON.parse(JSON.stringify(traces)).bySession).toEqual({ 'sess-a': [0, 1] })
  })

  /**
   * The mechanism, stated so a future reader cannot mistake the indexes for
   * stored fields and go back to copying them: they are accessors, computed
   * the first time somebody asks and then remembered against the array they
   * describe — which is why two slices over one spans array hand back the very
   * same projection, and why the fold can build a slice without touching one.
   */
  it('materialises each index on demand, once per spans array', () => {
    const traces = spanned().traces
    expect(Object.getOwnPropertyDescriptor(traces, 'byTrace')?.get).toBeTypeOf('function')
    expect(Object.getOwnPropertyDescriptor(traces, 'bySession')?.get).toBeTypeOf('function')
    expect(traces.byTrace).toBe(traces.byTrace)

    const again = traceStateOf(traces.spans)
    expect(again).not.toBe(traces)
    expect(again.byTrace).toBe(traces.byTrace)
    expect(again.bySession).toBe(traces.bySession)

    // A different array is a different projection, however alike it looks.
    const copied = traceStateOf([...traces.spans])
    expect(copied.byTrace).not.toBe(traces.byTrace)
    expect(copied.byTrace).toEqual(traces.byTrace)
  })
})

/**
 * prd19 ruling 2's slice, under the same contract as the two above: recorded
 * fact, arranged for lookup, and nothing else. Where the telemetry slice's law
 * is "six keys and no accelerator", this slice's is "two keys, and one of them
 * is positions" — the shape prd12's `CheckpointState` set and this mirrors.
 *
 * The fold's own half of it (what a `telemetry.refused` becomes, and that
 * `TelemetryState` does not move when one folds) is in `reduce.test.ts` and
 * `reduce.telemetry.test.ts`. This is the end where the shape is written down.
 */
/** One record built by hand, for the paths that take a record rather than an event. */
const plainRefusal = (instance: string | null): RefusalRecord => ({
  eventId: 'evt-0',
  ts: 1_000,
  instance,
  expectedInstance: 'ours',
  count: 1,
})

describe('RefusalState — records whole, plus positions into them', () => {
  const refused = (instance: string | null, count = 1) =>
    fx.make('telemetry.refused', { instance, expectedInstance: 'ours', count })

  it('is exactly two keys, empty and folded alike', () => {
    const keys = ['records', 'byInstance']
    expect(Object.keys(initialRefusalState()).sort()).toEqual([...keys].sort())

    const folded = reduceAll([refused('theirs'), refused(null), refused('theirs', 4)])
    expect(Object.keys(folded.refusals).sort()).toEqual([...keys].sort())
  })

  /**
   * The same proof the other two slices get, and for the same reason: a
   * positions index is exactly the kind of thing that wants to be a `Map`, and
   * a `Map` here would serialise to `{}` while every `toEqual` in the suite
   * went on passing.
   */
  it('round-trips through JSON unchanged — no Map, no Set, no instance', () => {
    const refusals = reduceAll([refused('theirs'), refused('other')]).refusals
    expect(JSON.parse(JSON.stringify(refusals))).toEqual(refusals)
    expect(JSON.parse(JSON.stringify(refusals)).byInstance).toEqual({ theirs: [0], other: [1] })
  })

  /**
   * `byInstance` is accumulated by the fold one position at a time and derived
   * from scratch by {@link refusalIndexOf} — the retention seam's rebuild path
   * (see `MAX_REFUSALS`). The two spellings must not be able to drift: this is
   * what says the accumulated index is exactly the index of its own records.
   */
  it('accumulates the index the derivation would have built, key order and all', () => {
    const refusals = reduceAll([
      refused('theirs'),
      refused(null),
      refused('other'),
      refused('theirs', 3),
    ]).refusals

    expect(refusals.byInstance).toEqual(refusalIndexOf(refusals.records))
    expect(JSON.stringify(refusals.byInstance)).toBe(JSON.stringify(refusalIndexOf(refusals.records)))
    expect(refusals.byInstance).toEqual({ theirs: [0, 3], other: [2] })
  })

  /**
   * An export that declared no instance at all is the commonest
   * misconfiguration there is, and it is kept WHOLE — only unindexed, because
   * no sentinel key can be proved distinct from a real instance id. A reader
   * finds it by asking the record, which is the point of keeping records whole.
   */
  it('keeps a refusal that declared no instance, and gives it no key of its own', () => {
    const refusals = reduceAll([refused(null), refused(null, 7)]).refusals
    expect(refusals.records.map((record) => [record.instance, record.count])).toEqual([
      [null, 1],
      [null, 7],
    ])
    expect(refusals.byInstance).toEqual({})
  })

  it('builds nothing from no records, and skips the unindexable ones', () => {
    expect(refusalIndexOf([])).toEqual({})
    const records: RefusalRecord[] = [
      { eventId: 'a', ts: 1, instance: null, expectedInstance: 'ours', count: 1 },
      { eventId: 'b', ts: 2, instance: 'theirs', expectedInstance: 'ours', count: 1 },
    ]
    expect(refusalIndexOf(records)).toEqual({ theirs: [1] })
  })

  /**
   * THE RETENTION SEAM, stated so it cannot be changed by accident. prd-19
   * leaves a cap for this slice an open question, so `null` — every refusal,
   * forever — is the recorded decision *not* to decide, and a future number
   * here has to come with a change to this line saying why.
   */
  it('names its retention seam rather than deciding it: unbounded, on purpose', () => {
    expect(MAX_REFUSALS).toBeNull()
    const many = reduceAll(Array.from({ length: 250 }, () => refused('theirs')))
    expect(many.refusals.records).toHaveLength(250)
    expect(many.refusals.byInstance.theirs).toHaveLength(250)
  })

  /**
   * The seam's DROP branch, driven at its own scale. While `MAX_REFUSALS` is
   * `null` this branch is unreachable through `reduce`, so a test claiming the
   * rebuild was "pinned" would be overclaiming — which is why the cap is a
   * parameter on {@link refusalStateWith}: the branch can be run without anybody
   * deciding the number.
   *
   * What it has to get right is what `slice(-N)` on a positions-indexed slice
   * gets wrong for free: every surviving position RENUMBERS, and an instance
   * whose every sighting fell off the front must lose its key altogether rather
   * than keep a stale position into a record that is gone.
   */
  it('drops the oldest records and rebuilds the index when a cap is driven through the seam', () => {
    const record = (instance: string | null, at: number): RefusalRecord => ({
      eventId: `evt-${at}`,
      ts: 1_000 * (at + 1),
      instance,
      expectedInstance: 'ours',
      count: 1,
    })

    let slice = initialRefusalState()
    // `b` is seen once, early — the offender that must disappear entirely.
    for (const [at, instance] of ['a', 'b', 'a', null, 'a'].entries()) {
      slice = refusalStateWith(slice, record(instance, at), 3)
    }

    expect(slice.records.map((held) => held.eventId)).toEqual(['evt-2', 'evt-3', 'evt-4'])
    expect(slice.byInstance).toEqual({ a: [0, 2] })
    expect(Object.hasOwn(slice.byInstance, 'b')).toBe(false)
    // The rebuild IS the derivation, not an approximation of it.
    expect(slice.byInstance).toEqual(refusalIndexOf(slice.records))
    expect(JSON.stringify(slice.byInstance)).toBe(JSON.stringify(refusalIndexOf(slice.records)))
  })

  it('keeps nothing under a cap of zero — `slice(-0)` would have kept everything', () => {
    expect(refusalStateWith(initialRefusalState(), plainRefusal('theirs'), 0)).toEqual({
      records: [],
      byInstance: {},
    })
  })

  it('folds unbounded by default, so the shipped reducer is exactly MAX_REFUSALS', () => {
    expect(refusalStateWith(initialRefusalState(), plainRefusal('theirs'))).toEqual(
      refusalStateWith(initialRefusalState(), plainRefusal('theirs'), MAX_REFUSALS),
    )
  })
})

/**
 * THE HOSTILE-INSTANCE LAW (PR #283's review, confirmed blocking).
 *
 * `instance` is the one string in this slice that no part of this repo chose: it
 * arrives in an OTLP export from another process, and our receiver records it in
 * a `telemetry.refused` precisely BECAUSE it was foreign (`api/otel.ts`). So
 * `'__proto__'`, `'constructor'`, `'hasOwnProperty'` and every other
 * `Object.prototype` member reaches the positions index as a key.
 *
 * The bug this pins was not theoretical. `[...(byInstance[instance] ?? []), at]`
 * reads an INHERITED value for those keys, so `??` never fires and the spread of
 * a non-iterable throws — `TypeError` for all four, in the incremental path and
 * the rebuild alike. And because the refusal stays in the recording, the crash
 * is permanent: every replay of that log would die in the same place forever.
 *
 * What these tests demand is not merely "no throw" — it is that a hostile id is
 * treated as an ORDINARY offender, because naming who is mis-exporting is
 * exactly what prd-19 is for. It gets a key, its positions accumulate, the
 * prototype is untouched, and the money layer still does not move.
 */
describe('RefusalState — an attacker-chosen instance id is an ordinary key', () => {
  const HOSTILE = ['__proto__', 'constructor', 'hasOwnProperty', 'toString'] as const

  const hostile = (instance: string, count = 1) =>
    fx.make('telemetry.refused', { instance, expectedInstance: 'ours', count })

  for (const instance of HOSTILE) {
    it(`folds a refusal declaring '${instance}' without throwing, and indexes it`, () => {
      const state = reduceAll([hostile(instance), hostile('ordinary'), hostile(instance, 6)])

      expect(state.refusals.records.map((record) => record.instance)).toEqual([
        instance,
        'ordinary',
        instance,
      ])
      // An OWN key — not a mutated prototype, and not a swallowed record.
      expect(Object.hasOwn(state.refusals.byInstance, instance)).toBe(true)
      expect(state.refusals.byInstance[instance]).toEqual([0, 2])
      expect(state.refusals.byInstance.ordinary).toEqual([1])
      expect(Object.getPrototypeOf(state.refusals.byInstance)).toBe(Object.prototype)
      expect(Object.keys(state.refusals.byInstance).sort()).toEqual([instance, 'ordinary'].sort())
    })

    it(`derives the same index for '${instance}' as the fold accumulated`, () => {
      const records = reduceAll([hostile(instance), hostile(instance, 2)]).refusals.records
      const derived = refusalIndexOf(records)
      expect(Object.hasOwn(derived, instance)).toBe(true)
      expect(derived[instance]).toEqual([0, 1])
      expect(Object.getPrototypeOf(derived)).toBe(Object.prototype)
      expect(JSON.parse(JSON.stringify(derived))).toEqual({ [instance]: [0, 1] })
    })
  }

  it('survives every hostile id in one fold, alongside an ordinary one', () => {
    const state = reduceAll([...HOSTILE.map((instance) => hostile(instance)), hostile('ordinary')])
    expect(state.refusals.records).toHaveLength(HOSTILE.length + 1)
    expect(Object.keys(state.refusals.byInstance).sort()).toEqual([...HOSTILE, 'ordinary'].sort())
    expect(state.refusals.byInstance).toEqual(refusalIndexOf(state.refusals.records))
    expect(Object.getPrototypeOf(state.refusals.byInstance)).toBe(Object.prototype)
    expect(JSON.parse(JSON.stringify(state.refusals)).records).toHaveLength(HOSTILE.length + 1)
  })

  /**
   * The money layer's law, restated for the hostile case specifically: the
   * six-key slice is byte-identical whether the refusal that folded was benign
   * or an attempt at the fold's own machinery.
   */
  it('leaves TelemetryState byte-identical for a hostile refusal, same as any other', () => {
    const empty = JSON.stringify(initialSessionState().telemetry)
    for (const instance of HOSTILE) {
      expect(JSON.stringify(reduceAll([hostile(instance), hostile(instance, 3)]).telemetry), instance)
        .toBe(empty)
    }
  })

  it('drops a hostile key cleanly when a cap retires its every position', () => {
    let slice = initialRefusalState()
    for (const [at, instance] of ['__proto__', 'ordinary', 'ordinary'].entries()) {
      slice = refusalStateWith(
        slice,
        { ...plainRefusal(instance), eventId: `evt-${at}`, ts: 1_000 * (at + 1) },
        2,
      )
    }
    expect(slice.records.map((held) => held.eventId)).toEqual(['evt-1', 'evt-2'])
    expect(Object.hasOwn(slice.byInstance, '__proto__')).toBe(false)
    expect(slice.byInstance).toEqual({ ordinary: [0, 1] })
    expect(Object.getPrototypeOf(slice.byInstance)).toBe(Object.prototype)
  })
})

describe('initialSessionState — fresh containers, never shared ones', () => {
  /**
   * The reason this matters is not tidiness. The telemetry fold's lookup tables
   * are keyed by the *identity* of the array they describe (#179), so an
   * `initialTelemetryState` that handed every caller one shared `[]` would hand
   * every independent fold the same key — one session's table answering another
   * session's questions. Freshness is what makes identity-keying sound.
   *
   * #184 put the trace slice under the same rule, twice over: its spans array
   * keys both the fold's own table and the projection memo behind
   * `byTrace`/`bySession`, so a shared `[]` would leak an index *and* an
   * answer.
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
    expect(a.traces).not.toBe(b.traces)
    expect(a.traces.spans).not.toBe(b.traces.spans)
    expect(a.traces.byTrace).not.toBe(b.traces.byTrace)
    expect(a.traces.bySession).not.toBe(b.traces.bySession)
    expect(a.refusals).not.toBe(b.refusals)
    expect(a.refusals.records).not.toBe(b.refusals.records)
    expect(a.refusals.byInstance).not.toBe(b.refusals.byInstance)
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
