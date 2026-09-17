import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STREAM_SOURCE_KEYS, type StreamSource } from '../app/StreamContext.js'
import {
  type Behaviour,
  buildFleet,
  type FixtureSpec,
  type Fleet,
  fixtureHistory,
  fleet20Spec,
  type LaneSpec,
  manifestFor,
  pathologySpec,
  reduceAll,
} from '../fleet/index.js'
import { layoutScene } from './geometry.js'

// @gate-timing — invalidated by contention, not a wall-clock assertion (#593,
// prd-59 ruling 1). scripts/gate.sh greps for this exact marker to route the
// file into its serial, alone timing pass instead of the 4x load batches.
// Carry this comment with the file if you rename or move it; a file without
// it is invisible to that pass (#209).
//
// The two "law bites" cases below run a synthetic fixture through
// reduceAll -> buildFleet -> layoutScene to get a thread count — real work,
// not a stopwatch. The first builds a fixture past TRIPWIRE_THREADS; the
// second builds one exactly at it, the boundary case. That crosses vitest's
// default 5000ms per-test timeout under the gate's load probe (4 concurrent
// suites at --maxWorkers=5, ~1.7x oversubscription on a 12-core box):
// reproduced on `main` at `a53f7dd8` failing 3 of 4 runs, cases at
// 5270-6403ms. Measured alone, serially — the condition this marker routes
// it into — on the same tree, even under this box's own ambient contention
// from other lanes: 2295-3161ms, comfortably inside the 5000ms default with
// no per-test timeout declared (prd-59 ruling 2: a default is not a budget,
// but nothing here calls for raising it). Re-derive rather than trust these
// numbers; they move with the machine.
//
// Mutation proof (reverted before commit): `oversizedSpec(TRIPWIRE_THREADS +
// 1)` in the first "law bites" case changed to `oversizedSpec(1)` reddened
// it at `expect(count).toBeGreaterThan(TRIPWIRE_THREADS)` — the case still
// exercises the real count, it is not passing vacuously once excluded from
// the load batches.

/**
 * THE TRIPWIRE, MADE MECHANICAL (prd-49 ruling 3, 2026-09-12) — issue #452.
 *
 * prd-47 ruling 4 answered NO-GO on the display-list free-list, conditional on
 * *the scale the instrument renders*. prd-49 carried that condition forward as
 * two clauses; ruling 3 retired clause 2 (a wall-clock percentage nobody ever
 * recorded — see the doc's own audit) and made clause 1 — the pure count — the
 * whole trigger: **no selectable stream source composes more than
 * `TRIPWIRE_THREADS` threads.** This file is that assertion, drawn once around
 * every source the operator can actually select, the way `geometry.test.ts`'s
 * *"threads all twenty lanes"* draws it around one.
 *
 * A count, never a clock: everything below is built from a fixed `NOW` and a
 * synthetic event log, so a loaded box and a quiet one answer identically —
 * that is the whole reason ruling 3 retired the wall-clock half and kept this
 * one.
 *
 * **Derived, not retyped — and shown to fail on drift.** The sources a reader
 * can select are `STREAM_SOURCE_KEYS` in `app/StreamContext.tsx`, not a list
 * copied out of it by hand. `FIXTURE_SPEC_FOR` below is typed
 * `Record<StreamSource, …>`, so TypeScript itself refuses to compile this file
 * the day a fourth `StreamSource` lands without a line added here — and
 * `uncoveredSources` (below, with its own bite proven inline) is the runtime
 * half of the same guarantee: it catches a fourth *value* appearing in
 * `STREAM_SOURCE_KEYS` even in the case TypeScript's structural check cannot
 * see, which is that `STREAM_SOURCE_KEYS` itself stops using a source this
 * file still lists. A law that silently skipped either direction of that drift
 * is the exact failure mode ruling 3 exists to close.
 *
 * **`live` is named, not skipped.** It has no shipped fixture to lay out —
 * `useFrameLoop.ts` composes exactly one colony
 * (`layoutWorld([{ id: LOCAL_COLONY, fleet: current.fleet }], …)`, prd-52
 * ruling 1), so a live session's thread count is one repo's lanes and is
 * nobody's fixture to assert here. The law says that plainly, in its own
 * `describe` block below, and asserts the one fact about `live` that *is*
 * checkable from a fixed source tree: the call site still composes exactly
 * one colony.
 *
 * **Shown to bite, never by editing a shipped fixture.** `oversizedSpec`
 * builds a fixture inline, past the threshold, and the same
 * `expectUnderTripwire` the real sources are checked with is run against it —
 * proving the assertion can fail at all, not just that it currently passes.
 * `fleet20Spec()` and `pathologySpec()` are read, never mutated.
 *
 * The failure message names prd-49, ruling 3 and the tripwire's own ticket —
 * [#190](https://github.com/launchpad-26/rhizomorph/issues/190) — because
 * that issue is where ruling 2 lives, and ruling 2 is what tripping this law
 * actually orders: **re-measure first, against a production build; the
 * pooling is not groomed and this law is not evidence that it should be.**
 */

/** prd-49 ruling 3's whole trigger. Appears as a literal exactly once — every
 * other reference below reads it back off this constant. */
export const TRIPWIRE_THREADS = 90

const NOW = Date.UTC(2026, 8, 12, 0, 0, 0)
const SIZE = { width: 800, height: 400 }

const HERE = path.dirname(fileURLToPath(import.meta.url))

function fleetFor(spec: FixtureSpec): Fleet {
  const state = reduceAll(fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, manifest: manifestFor(spec) })
}

function threadCountFor(spec: FixtureSpec): number {
  return layoutScene(fleetFor(spec), { ...SIZE, now: NOW }).threads.length
}

function tripwireMessage(source: StreamSource, count: number): string {
  return (
    `${source} composes ${count} threads, over prd-49 ruling 3's tripwire of ` +
    `${TRIPWIRE_THREADS} (the whole trigger; https://github.com/launchpad-26/rhizomorph/issues/190). ` +
    `Ruling 2 binds: re-measure first, against a production build — this law is not ` +
    `evidence that the free-list pooling should be built.`
  )
}

function expectUnderTripwire(source: StreamSource, count: number): void {
  expect(count, tripwireMessage(source, count)).toBeLessThanOrEqual(TRIPWIRE_THREADS)
}

/**
 * THE ONE MAP THIS LAW READS EVERY SOURCE THROUGH. `Record<StreamSource, …>`
 * means TypeScript itself demands a line here for every member of the type —
 * a fourth `StreamSource` with no entry added is a compile error, not a
 * silently-skipped branch. `live` maps to `null` on purpose: it is named, not
 * omitted, and the `describe` block below explains why null is the honest
 * value rather than a fixture.
 */
const FIXTURE_SPEC_FOR: Readonly<Record<StreamSource, FixtureSpec | null>> = {
  live: null,
  fleet20: fleet20Spec(),
  pathology: pathologySpec(),
}

/** Derived from the map above, not a second hand-typed list. */
const KNOWN_SOURCES = Object.keys(FIXTURE_SPEC_FOR) as StreamSource[]

/**
 * The values of a key map that this law's `KNOWN_SOURCES` does not cover —
 * empty is the only passing answer. Reusable so the "bites" test below can
 * run it against a probe rather than against the real, un-editable
 * `STREAM_SOURCE_KEYS`.
 */
function uncoveredSources(
  keys: Readonly<Record<string, string>>,
  covered: readonly string[],
): string[] {
  return [...new Set(Object.values(keys))].filter((source) => !covered.includes(source))
}

/**
 * A fixture built ONLY to cross the tripwire — never one of the shipped specs
 * `fixtures.ts` exports, which stay read-only here. One steady lane repeated
 * past the threshold: the count is what this test is about, not the shape,
 * and `fleet20Spec`'s own `AREAS`/`FLEET20_NAMES` machinery is not needed to
 * prove a count can cross a count.
 */
function oversizedSpec(laneCount: number): FixtureSpec {
  return {
    id: 'fleet20',
    label: 'OVER THE TRIPWIRE (test-only)',
    provenance: 'synthetic · test-only · built to prove the tripwire law bites · never shipped',
    lanes: Array.from({ length: laneCount }, (_unused, i): LaneSpec => ({
      name: `oversized-lane-${i}`,
      behaviour: 'steady' as Behaviour,
      weight: 1,
      subagentShare: 0,
      fence: [`test-only/tripwire-law/oversized/${i}/**`],
      touches: [`test-only/tripwire-law/oversized/${i}/file.ts`],
    })),
  }
}

describe('no selectable stream source composes more threads than the tripwire (prd-49 ruling 3, #190)', () => {
  it('covers exactly the sources STREAM_SOURCE_KEYS can select today — a source added there and not here fails LOUDLY', () => {
    expect(
      uncoveredSources(STREAM_SOURCE_KEYS, KNOWN_SOURCES),
      'STREAM_SOURCE_KEYS names a source this law does not check — see FIXTURE_SPEC_FOR',
    ).toEqual([])
    // The other direction: this law does not claim a source the operator can
    // no longer actually select.
    expect(
      [...new Set(Object.values(STREAM_SOURCE_KEYS))].sort(),
      'this law checks a source STREAM_SOURCE_KEYS no longer offers',
    ).toEqual([...KNOWN_SOURCES].sort())
  })

  it('bites — a fourth key this law does not know about is named, not silently skipped (probe only; STREAM_SOURCE_KEYS itself is untouched)', () => {
    const withAFourthSource: Record<string, string> = { ...STREAM_SOURCE_KEYS, '4': 'chaos' }
    expect(uncoveredSources(withAFourthSource, KNOWN_SOURCES)).toEqual(['chaos'])
    // And the real key map still reports clean, proving the probe — not a
    // stale assumption — produced the miss above.
    expect(uncoveredSources(STREAM_SOURCE_KEYS, KNOWN_SOURCES)).toEqual([])
  })

  for (const source of KNOWN_SOURCES) {
    const spec = FIXTURE_SPEC_FOR[source]
    if (spec === null) continue // 'live' — handled in its own describe block below.
    it(`${source} composes no more than ${TRIPWIRE_THREADS} threads`, () => {
      expectUnderTripwire(source, threadCountFor(spec))
    })
  }

  describe('the law bites — a fixture grown past the threshold reddens it (a spec built for this test, never a shipped fixture)', () => {
    it('an over-sized synthetic spec really is over the tripwire, and the same check the real sources use catches it', () => {
      const overSized = oversizedSpec(TRIPWIRE_THREADS + 1)
      const count = threadCountFor(overSized)
      // Proves the fixture is genuinely oversized, not a vacuous claim.
      expect(count).toBeGreaterThan(TRIPWIRE_THREADS)
      expect(() => expectUnderTripwire('fleet20', count)).toThrowError(/ruling 3/)
    })

    it('and a fixture one under the threshold does not trip it — the law has a real edge, not a fence around everything', () => {
      const atFloor = oversizedSpec(TRIPWIRE_THREADS)
      const count = threadCountFor(atFloor)
      expect(count).toBe(TRIPWIRE_THREADS)
      expect(() => expectUnderTripwire('fleet20', count)).not.toThrow()
    })
  })
})

describe('`live` has no shipped fixture — this law says so, and checks what is true of it instead (prd-49 ruling 3)', () => {
  const FRAME_LOOP_SOURCE = readFileSync(path.join(HERE, 'view', 'useFrameLoop.ts'), 'utf8')

  /**
   * The literal call `useFrameLoop.ts` makes: one colony, named `LOCAL_COLONY`,
   * and the array closes immediately after it — no second entry. This is the
   * fact that makes `live`'s thread count "one repo's lanes" rather than
   * something this fixed-source-tree law could assert a number for.
   */
  const ONE_COLONY_CALL =
    /layoutWorld\(\s*\[\s*\{\s*id:\s*LOCAL_COLONY\s*,\s*fleet:\s*current\.fleet\s*\}\s*\]\s*,/

  it('the frame loop composes exactly one colony, so a live session threads one repo\'s lanes — not knowable from a fixed source tree', () => {
    expect(
      FRAME_LOOP_SOURCE,
      'useFrameLoop.ts no longer composes exactly one colony for layoutWorld — live may no longer be one repo\'s lanes, and this law\'s reason for skipping it needs re-deriving',
    ).toMatch(ONE_COLONY_CALL)
  })

  it('bites — a second colony in that same call is a shape this check would not wave through', () => {
    const twoColonies =
      "const world = layoutWorld([{ id: LOCAL_COLONY, fleet: current.fleet }, { id: OTHER_COLONY, fleet: other.fleet }], {"
    expect(twoColonies).not.toMatch(ONE_COLONY_CALL)
    // …and the real source is confirmed to still take the one-colony shape,
    // so the probe above is exercising the same pattern, not a stricter one.
    expect(FRAME_LOOP_SOURCE).toMatch(ONE_COLONY_CALL)
  })
})
