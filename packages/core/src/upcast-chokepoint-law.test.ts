import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVENT_TYPES, type RhizomorphEvent } from './events/index.js'
import { createEventFactory, type EventFactory } from './fixtures.js'
import { reduce, reduceAll } from './reduce.js'
import { upcast } from './events/upcast.js'
import { initialSessionState } from './state.js'

/**
 * THE UPCAST CHOKEPOINT LAW — prd17 ruling 3, item 3 (#62).
 *
 * Four things asserted independently, each able to fail on its own:
 *
 * (a) an event folded through `reduce`, and an event folded through
 *     `reduceAll`, each actually reach `upcast` — observed by counting the
 *     call, not by grepping for the import.
 * (b) `upcast` is the identity today, across every family in the union.
 * (c) `upcast.ts` carries the sentence ADR-0011 blockquotes as coming from its
 *     own comment — and ADR-0011 still blockquotes it.
 * (d) `upcast` runs BEFORE anything else in `reduce()` reads the event.
 *
 * **(d) exists because (a) cannot do its job.** A call counter proves the call
 * happens; it cannot prove it happened first, and the ordering is what the
 * issue's Definition of done actually requires — `opensNewSession` reads the
 * event before `applyEvent` does, so upcasting only for `applyEvent` would
 * leave a reader looking at a pre-migration value. That is unobservable while
 * `upcast` is `return event`: the same reference goes in and comes out, so
 * moving the call below `opensNewSession` is a bit-identical program and every
 * assertion over the real function stays green. Verified: with (d) removed,
 * that mutation leaves this file 6/6 green and all of `packages/core`
 * 1025/1025 green. (d) closes it by making the double return something
 * *different*, which is the only thing an identity function's ordering is
 * visible against.
 */

/**
 * `import.meta.glob` is Vite's build-time directory read, which is how
 * assertion (c) reads source text without `@rhizomorph/core` growing a
 * `node:fs` dependency it does not otherwise have (see
 * `events/no-open-payload-law.test.ts`, which reads this same package the same
 * way, for the constraint this declaration exists to satisfy). Declared
 * locally rather than adding `vite/client` to this package's tsconfig, which
 * is not this issue's fence — so this is the SECOND identical declaration in
 * the package; TypeScript merges the two into an overload set. If a third is
 * ever wanted, that is the signal to add the lib and delete all of them.
 */
declare global {
  interface ImportMeta {
    glob(
      pattern: string,
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Readonly<Record<string, string>>
  }
}

/**
 * Counts real calls to the real `upcast`, wrapped rather than replaced —
 * `vi.mock`'s factory is hoisted above the imports above, so this lives in
 * `vi.hoisted` and every module (this file's own top-level imports included)
 * sees the same wrapped function. `reduce.ts` imports `upcast` from this exact
 * specifier, so its call is what increments this counter — deleting the
 * `upcast(event)` call from `reduce()` leaves it at zero.
 *
 * `transform` is null for every assertion except (d): it makes the chokepoint
 * return something *other* than its input, which is the only way an identity
 * function's position in `reduce()` becomes observable at all. Tests that set
 * it clear it in `afterEach`, so (a) and (b) always see the pass-through.
 */
const calls = vi.hoisted(() => ({
  upcast: 0,
  transform: null as null | ((event: RhizomorphEvent) => RhizomorphEvent),
}))

vi.mock('./events/upcast.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events/upcast.js')>()
  return {
    ...actual,
    upcast: (...args: Parameters<typeof actual.upcast>) => {
      calls.upcast++
      const out = actual.upcast(...args)
      return calls.transform === null ? out : calls.transform(out)
    },
  }
})

describe('assertion (a): every fold path reaches upcast', () => {
  it('reduce() passes its event through upcast', () => {
    const before = calls.upcast
    const f = createEventFactory()
    reduce(initialSessionState(), f.worktreeDiscovered())
    expect(calls.upcast).toBe(before + 1)
  })

  it('reduceAll() passes every event through upcast — inherited via reduce, no second hook', () => {
    const before = calls.upcast
    const f = createEventFactory()
    const events = [f.worktreeDiscovered(), f.branchUpdated(), f.commitLanded()]
    reduceAll(events)
    expect(calls.upcast).toBe(before + events.length)
  })
})

/** One of every event type `createEventFactory` knows how to build, real schemas, real defaults. */
function allFamilies(f: EventFactory) {
  return [
    f.sessionStarted(),
    f.sessionClosed(),
    f.collectorError(),
    f.collectorDisabled(),
    f.collectorDegraded(),
    f.collectorRecovered(),
    f.worktreeDiscovered(),
    f.worktreeRemoved(),
    f.worktreeDirty(),
    f.worktreeDirtyStatusFailed(),
    f.worktreeDirtyStatusRecovered(),
    f.branchUpdated(),
    f.branchRemoved(),
    f.commitLanded(),
    f.paneDiscovered(),
    f.paneClosed(),
    f.paneActivity(),
    f.agentStatus(),
    f.agentRemoved(),
    f.llmUsage(),
    f.llmCost(),
    f.toolActivity(),
    f.agentActiveTime(),
    f.traceSpan(),
    f.forkCheckpoint(),
    f.forkDispatched(),
    f.forkMeasured(),
    f.judgeFinding(),
    // prd-27 wave 1's family (#217). The same law caught it: this branch added
    // `beacon.received` to the union while #219 was adding its eight, and the
    // set-equality below reddened on the merge rather than after it.
    f.beaconReceived(),
    // prd17 ruling 1's families (#219), added under that issue's recorded fence
    // widening. This law set-equates against EVENT_TYPES precisely so a new
    // family cannot evade the identity check — so eight new families reddening
    // it was the law working, not a defect in it.
    f.summonsRaised(),
    f.summonsCleared(),
    f.gateVerdict(),
    f.dispatchBrief(),
    f.fenceDeclared(),
    f.operatorAck(),
    f.operatorVerdict(),
    f.operatorNote(),
    f.make('telemetry.refused', {
      instance: 'other-rhizomorph',
      expectedInstance: 'fixture-instance',
      count: 1,
    }),
  ]
}

describe('assertion (b): upcast is the identity today', () => {
  /**
   * Set equality against the union itself, not a floor. A `length > 20` floor
   * passes with a family missing — measured: dropping `judge.finding` left it
   * green at 27 — so the family added tomorrow would silently never be checked
   * for identity. This reddens on the 29th type, naming it.
   */
  it('covers every family in the union — no family can evade the identity check', () => {
    const covered = [...new Set(allFamilies(createEventFactory()).map((e) => e.type))].sort()
    expect(covered).toEqual([...EVENT_TYPES].sort())
  })

  it('returns every real event family deep-equal to the input, unchanged', () => {
    for (const event of allFamilies(createEventFactory())) {
      expect(upcast(event)).toEqual(event)
    }
  })
})

/**
 * Source text with line-leading wrap furniture (a comment's `*`, a markdown
 * blockquote's `>`) removed and every run of whitespace collapsed to one
 * space — so the same sentence reads identically whether a file holds it on
 * one line or wrapped across five.
 *
 * **What this deliberately does NOT do is tell a comment from a string, and
 * that limit is the ruling here rather than an oversight.** Two detectors tried
 * and each was defeated twice in review: a whole-file comment scraper admitted
 * string literals carrying comment delimiters, and its replacement — reading
 * the JSDoc attached to `export function upcast` — admitted a forged
 * comment-plus-export inside a string placed BEFORE the real one, because
 * `String.match` takes the leftmost match and a regex has no notion of lexical
 * position. Separating the two honestly needs a lexer (`typescript` is a root
 * devDependency, so `ts.createSourceFile` would do it), and that was judged not
 * worth it for a citation check whose worst failure is a law less thorough than
 * advertised.
 *
 * So the CLAIM moved to what the code can actually establish: the sentence is
 * present in `upcast.ts`, however that file wraps it. That is bounded, true,
 * and cannot be defeated by a spelling — the property this repo's own budget
 * rule prescribes when findings arrive one counter-example per round. The
 * residual hole is named rather than hidden: moving the sentence out of the
 * comment into a string literal would satisfy this and should not. It is an
 * adversarial edit, not drift, and it is what a reviewer reading `upcast.ts`
 * would see immediately.
 *
 * Whitespace collapsing is the part that earns its keep: the sentence lives in
 * a comment wrapped at the file's own ~76 columns, and a raw substring match
 * against one 300-character line reddened on a reflow that changed nothing.
 */
function collapsed(source: string): string {
  return source
    .replace(/^[ \t]*[*>]/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

describe('assertion (c): the file and the ADR carry the same sentence', () => {
  const UPCAST_SOURCE = Object.values(
    import.meta.glob('./events/upcast.ts', { query: '?raw', import: 'default', eager: true }),
  )[0]

  const ADR_SOURCE = Object.values(
    import.meta.glob('../../../docs/adr/0011-recordings-never-rot.md', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  )[0]

  /**
   * The sentence ADR-0011 attributes to `upcast.ts`'s own comment. Written
   * here unwrapped and compared against both sides after whitespace
   * collapsing, so neither file has to keep it on one line.
   */
  const ADR_QUOTED_SENTENCE =
    'Retrofitting a chokepoint is the expensive half: by then there are folds in the live stream, in replay, in the record reader, in the era corpus, and in a hundred tests, and the migration has to find all of them.'

  it('really read both files — not vacuously true', () => {
    expect(UPCAST_SOURCE).toBeDefined()
    expect(UPCAST_SOURCE!.length).toBeGreaterThan(0)
    expect(ADR_SOURCE).toBeDefined()
    expect(ADR_SOURCE!.length).toBeGreaterThan(0)
  })

  it('upcast.ts carries the sentence, however the file wraps it', () => {
    expect(collapsed(UPCAST_SOURCE!)).toContain(ADR_QUOTED_SENTENCE)
  })

  it('and would notice its removal — the assertion is not satisfied by the file merely existing', () => {
    const withoutIt = UPCAST_SOURCE!.replace(/Retrofitting a chokepoint[\s\S]*?find all of them\./, 'GONE.')
    expect(collapsed(withoutIt)).not.toContain(ADR_QUOTED_SENTENCE)
  })

  /**
   * The other side of the citation. ADR-0011 quotes this sentence as coming
   * from `upcast.ts`; pinning only the file lets the ADR be reworded out from
   * under it and the law stay green — measured on the previous version.
   */
  it('ADR-0011 still blockquotes the sentence it attributes to that comment', () => {
    expect(collapsed(ADR_SOURCE!)).toContain(ADR_QUOTED_SENTENCE)
  })
})

describe('assertion (d): upcast runs before anything else in reduce() reads the event', () => {
  afterEach(() => {
    calls.transform = null
  })

  /**
   * `opensNewSession` is the FIRST read in `reduce()`, before the envelope and
   * before `applyEvent`. Here the chokepoint canonicalises every
   * `session.started` to one `sessionId`, so two starts that differ in the raw
   * log are the same session after upcast: no reset fires and both events
   * count. Read the RAW event instead and the two ids differ, the reset fires,
   * and the count comes back 1.
   */
  it('opensNewSession sees the upcast event, not the raw one', () => {
    calls.transform = (event) =>
      event.type === 'session.started'
        ? { ...event, payload: { ...event.payload, sessionId: 'canonical' } }
        : event
    const f = createEventFactory()
    const state = reduceAll([
      f.sessionStarted({ sessionId: 'raw-a' }),
      f.sessionStarted({ sessionId: 'raw-b' }),
    ])
    expect(state.eventCount).toBe(2)
  })

  /** `withEnvelope` is the second read — it takes `ts` off the event. */
  it('withEnvelope sees the upcast event, not the raw one', () => {
    calls.transform = (event) => ({ ...event, ts: 4_242 })
    const f = createEventFactory()
    const state = reduce(initialSessionState(), f.worktreeDiscovered({}, { ts: 1_000 }))
    expect(state.lastEventTs).toBe(4_242)
  })

  /** `applyEvent` is the third, and the one a careless fix would cover alone. */
  it('applyEvent sees the upcast event, not the raw one', () => {
    calls.transform = (event) =>
      event.type === 'branch.updated'
        ? { ...event, payload: { ...event.payload, branch: 'canonical-branch' } }
        : event
    const f = createEventFactory()
    const state = reduceAll([f.branchUpdated({ branch: 'raw-branch' })])
    expect(Object.keys(state.branches)).toEqual(['canonical-branch'])
  })
})
