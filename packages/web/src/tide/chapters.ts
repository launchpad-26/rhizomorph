import { compareStrings, type RhizomorphEvent } from '@rhizomorph/core'
import { laneOf } from './laneOf.js'
import { formatClockSeconds } from './duration.js'

/**
 * CHAPTERS OVER THE TIDE (issue #185, prd13 ruling 12 — operator amendment,
 * 2026-08-05; the sole surviving glance layer after ruling 13, issue #194,
 * cut the density band; widened for prd17 ruling 4 by issue #277, once
 * issue #219 landed the event families ruling 4 depends on). This file
 * answers "which instants would I point at first" — pure, single-purpose, no
 * view, no clock, `laneOf` imported rather than re-derived (`laneOf.ts` owns
 * lane identity; copying its switch here would be drift-by-construction, the
 * same warning `laneOf.ts`'s own module note makes about `buildFleet`).
 *
 * Ruling 12 names five candidate moments: lane born, lane landed (gate
 * merge), gate held, attention-summons onset, session boundary. Four have a
 * clean, self-attributing event behind them; the fifth does not, and this
 * file does not invent one for it (the issue's own instruction: "if a moment
 * you need has no event, name it in your summary — do not invent one").
 *
 * - **`lane-born`** — the earliest event `laneOf` attributes to a handle.
 * - **`lane-landed`** — the earliest `agent.status` declaring `done` for a
 *   lane. Workmux's own terminal declaration is the closest existing signal
 *   to "this lane's work landed"; a literal merge-to-main event does not
 *   exist (`commit.landed` is keyed by branch/path, and joining that to a
 *   handle is `buildFleet`'s `resolveLaneId`, not this file's — see
 *   `laneOf.ts`'s module note, restated for marks).
 * - **`gate-held`** — every `trace.span` of kind `tool_blocked`: the CLI's
 *   own permission wait, exported once it resolves (prd9 ruling 6). This is
 *   a literal gate in the log's own vocabulary, not a metaphor borrowed from
 *   `agent.status: 'waiting'` — turning every one of those into a chapter too
 *   would flood the mark lane with a story `Chapter` was never meant to
 *   carry. Ruling 12's five candidate kinds are not reopened by ruling 13's
 *   cut; the mark lane is now the dock's only glance layer, which is a
 *   reason to hold that line more carefully, not less — the same reason
 *   {@link coalesceMarks} exists, restated below for the four kinds this
 *   wave adds.
 * - **`session-boundary`** — every `session.started` event, only.
 *   `session.closed` exists now (prd17 ruling 1, landed before #219, as
 *   `packages/core/src/events/system.ts` shows) — the file's old claim that
 *   there was "no `session.ended` type" is false and this paragraph is its
 *   correction. That is not, on its own, a reason to draw a closing mark:
 *   prd17 ruling 4 — the ruling this file now implements — names exactly
 *   three things that become chapter marks ("gate holds and merges",
 *   "summonses... with their clearances", "the operator's verdicts"), and a
 *   session's close is not among them. Ruling 12's own single "session
 *   boundary" candidate has always meant the session's start (the same left
 *   edge {@link ChapterMarks} anchors live and replay tracks to); ruling 4
 *   does not reopen it. So the event this file lacked before is a fact now
 *   on the record, and the file still does not turn it into a mark — because
 *   no ruling asks it to, not because the fact does not exist.
 *
 * **`attention-summons onset` has no event, still.** The ladder's rank (prd3
 * ruling 18's pathologies) is `buildFleet`'s own judgement, folded from
 * multiple signal kinds against a clock (FROZEN needs "now") and the fence
 * manifest (`OFF-FENCE` needs `.swarm/lanes.json`) — reproducing it here
 * would mean either reaching for the wall clock (which `purity.test.ts`
 * forbids outright) or re-deriving `buildFleet`'s fold beside it, the exact
 * drift `laneOf.ts` already warns against. `summons.raised` (below) is a
 * different, narrower fact — the instrument observed one alarm condition
 * begin — not the ladder's synthesised rank, so its arrival does not close
 * this gap; no mark kind stands in for the ladder itself.
 *
 * **`summons-raised` / `summons-cleared`** — every `summons.raised` /
 * `summons.cleared` event, one chapter per event (prd17 ruling 1's alarm
 * pair, ruling 4's "summonses become marks with their clearances"). The two
 * schemas deliberately do not reference each other (`events/summons.ts`'s
 * own note: "a session can end mid-alarm"), and this file honours that at
 * the mark layer too — a raise with no later clear is a mark, not an error,
 * and nothing here waits for or assumes a pairing. `lane` is read straight
 * from each payload's own `lane` field rather than through `laneOf`: the
 * question `laneOf` answers is which lane a *self-attributing telemetry or
 * trace* event belongs to, over a fixed switch of five event types it
 * already knows; a summons naming its own lane in its own payload is a
 * different question with an obviously different, and already correct,
 * answer — reaching for `laneOf` here would silently return `null` for
 * every one of these marks (it has no case for `summons.raised` or
 * `summons.cleared` and never should — see `laneOf.ts`'s fence), which is
 * the miss a copy-pasted `const lane = laneOf(event)` would make.
 * - **`gate-verdict`** — every `gate.verdict` event, one chapter per event
 *   (ruling 4's "gate holds and merges"). `lane` is `event.payload.handle`
 *   for the same reason as above — `laneOf` has no `gate.verdict` case, on
 *   purpose, since a landing-gate verdict is not one of the telemetry/trace
 *   events it resolves. The verdict's own `held` flag decides the label:
 *   `held` reads "held", released reads "merged" — the two real outcomes
 *   ruling 4 names side by side, so nothing here may collapse them into one
 *   fixed verb the way `gate-held` gets to.
 * - **`operator-verdict`** — every `operator.verdict` event, one chapter per
 *   event (ruling 4's "the operator's verdicts appear where they
 *   happened"). `lane` is `event.payload.subject`, which `operator.ts`'s own
 *   comment says may be "a lane handle, an issue number as a string, a PR
 *   handle" — not always a lane in the sense `laneOf` resolves, which is
 *   exactly why this file reads it directly instead of asking `laneOf` a
 *   question it was never built to answer. The label carries the operator's
 *   own `verdict` word verbatim (`chapterLabel` shows it as the "what",
 *   unparaphrased) rather than a fixed verb like "decided" — the operator's
 *   own word is the fact ruling 4 wants on the record, not a gloss on it.
 *
 * **A flood of any of the above still reads as one mark, not a wall of
 * ticks.** {@link coalesceMarks} clusters `Chapter[]` by proximity alone —
 * it has no per-kind exemption and does not know these four kinds exist any
 * more than it knew about the original four — so a burst of `summons.raised`
 * (a flapping alarm, say) coalesces exactly like a burst of `lane-born`
 * already did, into one counted `×N` tick. `chapters.test.ts` and
 * `ChapterMarks.test.tsx` each pin a flood of summonses collapsing under the
 * hover threshold, the same law already proven for the original four kinds.
 *
 * Laws, each restated as a test in `chapters.test.ts`, and now fuzzed over
 * logs containing every kind below, old and new alike:
 *
 * 1. **Deterministic.** Same events in, byte-equal chapters out; no clock, no
 *    unseeded random.
 * 2. **Prefix-consistent.** `chaptersFor` over a time-prefix of the log
 *    equals `chaptersFor` over the whole log, filtered to that same prefix.
 * 3. **One row per real fact.** `gate-held`, `session-boundary`,
 *    `summons-raised`, `summons-cleared`, `gate-verdict` and
 *    `operator-verdict` are each emitted once per matching event;
 *    `lane-born`/`lane-landed` are emitted once per lane, at that lane's
 *    earliest matching event — never revised by a later one.
 */

export const CHAPTER_KINDS = [
  'lane-born',
  'lane-landed',
  'gate-held',
  'session-boundary',
  'summons-raised',
  'summons-cleared',
  'gate-verdict',
  'operator-verdict',
] as const
export type ChapterKind = (typeof CHAPTER_KINDS)[number]

/** One glance-layer instant. `lane` is `null` only for `session-boundary`, which names no lane. */
export interface Chapter {
  kind: ChapterKind
  /** The seek target — always the triggering event's own `ts`, never approximated. */
  ts: number
  lane: string | null
  /** `gate-held` only, when the span said which tool was waiting on a human. */
  toolName: string | null
  /** `gate-verdict` only: `true` if the landing gate held (blocked), `false` if it released (merged). */
  held: boolean | null
  /** `operator-verdict` only: the operator's own word for the decision, carried verbatim. */
  verdict: string | null
}

const CHAPTER_VERB: Partial<Record<ChapterKind, string>> = {
  'lane-born': 'born',
  'lane-landed': 'landed',
  'session-boundary': 'started',
  'summons-raised': 'raised',
  'summons-cleared': 'cleared',
}

/** The "what" half of {@link chapterLabel} — one fixed verb per kind, except the three whose real fact varies. */
function describeWhat(chapter: Chapter): string {
  switch (chapter.kind) {
    case 'gate-held':
      return chapter.toolName !== null ? `held on ${chapter.toolName}` : 'held'
    case 'gate-verdict':
      return chapter.held === true ? 'held' : 'merged'
    case 'operator-verdict':
      return chapter.verdict ?? 'decided'
    default:
      return CHAPTER_VERB[chapter.kind] as string
  }
}

/**
 * The hover's who/what/when, in the ruling-6 voice, for an instant rather
 * than a span: `163 landed · 14:32:07`. `gate-verdict` and `operator-verdict`
 * follow the same shape — no new sentence form, just a different word in the
 * same slot (`held`/`merged`, or the operator's own verdict text).
 */
export function chapterLabel(chapter: Chapter): string {
  const who = chapter.lane ?? 'session'
  return `${who} ${describeWhat(chapter)} · ${formatClockSeconds(chapter.ts)}`
}

/**
 * Every chapter mark the log attests, in one forward pass gathering the
 * per-lane earliest-sighting facts (`lane-born`/`lane-landed` need "the
 * earliest", so they resolve after the pass, from a `Map` each) plus every
 * other kind's own instant, pushed as seen — no waiting to resolve, and no
 * pairing across events of any kind.
 *
 * The log is expected in non-decreasing `ts` order; the final sort by
 * `(ts, kind, lane)` makes the output well-ordered and deterministic
 * regardless, the same defensive stance `markCoalesce.ts` takes.
 */
export function chaptersFor(events: readonly RhizomorphEvent[]): readonly Chapter[] {
  const bornAt = new Map<string, number>()
  const landedAt = new Map<string, number>()
  const chapters: Chapter[] = []

  for (const event of events) {
    const lane = laneOf(event)

    if (lane !== null) {
      const seen = bornAt.get(lane)
      if (seen === undefined || event.ts < seen) bornAt.set(lane, event.ts)
    }

    if (event.type === 'session.started') {
      chapters.push({ kind: 'session-boundary', ts: event.ts, lane: null, toolName: null, held: null, verdict: null })
    }

    if (lane !== null && event.type === 'agent.status' && event.payload.status === 'done') {
      const seen = landedAt.get(lane)
      if (seen === undefined || event.ts < seen) landedAt.set(lane, event.ts)
    }

    if (lane !== null && event.type === 'trace.span' && event.payload.kind === 'tool_blocked') {
      chapters.push({
        kind: 'gate-held',
        ts: event.ts,
        lane,
        toolName: event.payload.toolName ?? null,
        held: null,
        verdict: null,
      })
    }

    if (event.type === 'summons.raised') {
      chapters.push({
        kind: 'summons-raised',
        ts: event.ts,
        lane: event.payload.lane,
        toolName: null,
        held: null,
        verdict: null,
      })
    }

    if (event.type === 'summons.cleared') {
      chapters.push({
        kind: 'summons-cleared',
        ts: event.ts,
        lane: event.payload.lane,
        toolName: null,
        held: null,
        verdict: null,
      })
    }

    if (event.type === 'gate.verdict') {
      chapters.push({
        kind: 'gate-verdict',
        ts: event.ts,
        lane: event.payload.handle,
        toolName: null,
        held: event.payload.held,
        verdict: null,
      })
    }

    if (event.type === 'operator.verdict') {
      chapters.push({
        kind: 'operator-verdict',
        ts: event.ts,
        lane: event.payload.subject,
        toolName: null,
        held: null,
        verdict: event.payload.verdict,
      })
    }
  }

  for (const [lane, ts] of bornAt) {
    chapters.push({ kind: 'lane-born', ts, lane, toolName: null, held: null, verdict: null })
  }
  for (const [lane, ts] of landedAt) {
    chapters.push({ kind: 'lane-landed', ts, lane, toolName: null, held: null, verdict: null })
  }

  return chapters.sort(
    (a, b) => a.ts - b.ts || compareStrings(a.kind, b.kind) || compareStrings(a.lane ?? '', b.lane ?? ''),
  )
}
