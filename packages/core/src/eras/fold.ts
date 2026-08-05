import {
  readEventLineLenient,
  type RhizomorphEvent,
  type UnknownEventLine,
} from '../events/index.js'
import { reduceAll } from '../reduce.js'
import type { SessionState } from '../state.js'

/**
 * THE GOLDEN ERA CORPUS — prd17 ruling 3, item 2. "The one event-sourcing
 * orthodoxy the repo had skipped."
 *
 * One small REAL recording per era, folded in CI by whatever the reducer has
 * become. If a future change alters the fold of a past era, the build fails.
 * That is the whole mechanism: not a schema, not a version negotiation, but a
 * committed answer to "what did this log mean?" that cannot drift without
 * somebody noticing.
 *
 * **Real, not synthesised.** `fixtures.ts` already covers what the reducer does
 * with events we *constructed*, which is a test of our own reading of the
 * contract. An era recording is a slice of a log the instrument actually wrote,
 * with all the shapes we would never have thought to write down — timestamps
 * that go backwards inside one file, a lane reporting a relative worktree path,
 * a git poll that lands eight commits at one timestamp. Those are the details a
 * hand-written fixture smooths away and a reducer change breaks.
 *
 * **Deliberately pure — no file access, no `node:*`, nothing ambient.** Two
 * reasons, and the first is not stylistic: `@rhizomorph/core` has no Node type
 * definitions in scope at all (`packages/core/tsconfig.json` pulls none, and
 * unlike `@rhizomorph/server` it has no dependency that drags `@types/node` in
 * transitively), so a `readFileSync` here would not typecheck. The second is
 * the standing rule this package already follows — `state.ts` writes its own
 * `basename` and `record/hash.ts` its own SHA-256 rather than assume an
 * ambient — because core is bundled into the browser. `corpus.ts` beside this
 * file binds the recordings' bytes in, statically; the blessing procedure in
 * `CAPTURE.md` does the one write, from outside the test suite entirely.
 *
 * **Not exported from the package barrel** (`../index.ts`), and it never should
 * be: a corpus is test scaffolding, and the barrel is what the web bundle
 * imports. Import `./eras/fold.js` and `./eras/corpus.js` from a test.
 *
 * See `CAPTURE.md` in this directory for each recording's provenance, the
 * redaction applied, and the rule for re-blessing a snapshot.
 */

/** One era's committed recording and the fold it is owed. Paths are relative to this directory. */
export interface EraRecording {
  /** 1-based era number. Era N is "the shape the log had when era N was current". */
  era: number
  /** Directory name under `eras/`, and the era's identity in test output. */
  name: string
  /** The recording itself: one event per line, exactly as the log held it (post-redaction). */
  recordingFile: string
  /** The committed fold of {@link recordingFile}, as {@link canonicalStateJson} renders it. */
  snapshotFile: string
  /** One line on where this slice came from and what it is good for. */
  provenance: string
}

export const ERAS: readonly EraRecording[] = [
  {
    era: 1,
    name: 'era-1',
    recordingFile: 'era-1/recording.jsonl',
    snapshotFile: 'era-1/session-state.snapshot.json',
    provenance:
      "a 100-line contiguous slice of a real 2026-08-06 session log, mid-flight across four lanes: 15 event families (of the 16 that log ever emitted, and of the 25 this era declares), timestamps that are not monotonic in the log's own order, a worktree and a branch disappearing together, eight commits landing on one git poll.",
  },
]

/**
 * The result of folding one era recording: the state, and an honest account of
 * anything the current era could not read in it.
 *
 * `unknown` should be empty for every era captured so far — each was written by
 * the instrument of its own day, and this era understands all of them. It is
 * carried anyway, and asserted empty by the corpus test, because the day it is
 * *not* empty is the day a past era's event family was removed from the union,
 * and "the era corpus quietly folded 96 of 100 lines" must not be a thing that
 * can happen silently (prd17 ruling 3, item 1 — the same law, pointed at our
 * own history rather than a stranger's).
 */
export interface EraFold {
  events: RhizomorphEvent[]
  unknown: UnknownEventLine[]
  state: SessionState
}

/**
 * Folds one era recording's text in the order the log holds it.
 *
 * **Log order, not timestamp order, and that is the point.** A recording is an
 * append-only artifact; its own order is the only order that is a recorded fact
 * about it. Sorting it by `ts` before folding would bake one of the two
 * candidate answers to prd17 ruling 3's item-4 question into the very snapshot
 * that is supposed to be neutral evidence about it — and this recording is
 * genuinely non-monotonic, so the two answers differ (see the fold-order law in
 * `../reduce.test.ts`). The corpus pins the log's own order and leaves the
 * ruling to the conductor.
 */
export function foldEraRecording(text: string): EraFold {
  const events: RhizomorphEvent[] = []
  const unknown: UnknownEventLine[] = []

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (line.trim().length === 0) continue
    const parsed = readEventLineLenient(line, i + 1)
    if (parsed.kind === 'event') events.push(parsed.event)
    else if (parsed.kind === 'unknown') unknown.push(parsed.unknown)
    else throw new Error(`era recording line ${i + 1} is not an event at all: ${parsed.error}`)
  }

  return { events, unknown, state: reduceAll(events) }
}

/**
 * A `SessionState` as committed bytes: JSON with every object's keys sorted,
 * two-space indent, one trailing newline.
 *
 * **Why keys are sorted rather than left in construction order.** The law is
 * about the fold's *content* — which worktrees, which commits, whose tokens.
 * Plain `JSON.stringify` also encodes the order the reducer happened to write
 * an object literal's fields in, so reordering two lines inside a record
 * constructor would fail the build having changed nothing anybody can observe.
 * That is a false alarm, and a corpus that cries wolf gets re-blessed
 * reflexively, which is exactly how a golden snapshot stops guarding anything.
 * Array order is untouched — `commitOrder`, `usage`, `spans` and every index's
 * positions are recorded facts about sequence, and a change to any of them
 * SHOULD fail.
 *
 * `traces.byTrace`/`bySession` are getters on the state object; `Object.keys`
 * sees them (they are enumerable own properties) and reading them materialises
 * the projection, so the snapshot covers them like any other key.
 */
export function canonicalStateJson(state: SessionState): string {
  return `${JSON.stringify(withSortedKeys(state), null, 2)}\n`
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) sorted[key] = withSortedKeys(source[key])
  return sorted
}
