import { compareStrings, type RhizomorphEvent } from '@rhizomorph/core'
import { laneOf } from './bands.js'
import { formatClockSeconds } from './duration.js'

/**
 * CHAPTERS OVER THE TIDE (issue #185, prd13 ruling 12 — operator amendment,
 * 2026-08-05). `bandsFor` answers "what was this lane doing"; this file
 * answers a sparser question — "which instants would I point at first" — and
 * sits beside it under the same discipline: pure, single-purpose, no view, no
 * clock, `laneOf` imported rather than re-derived (`bands.ts` owns lane
 * identity; copying its switch here would be drift-by-construction, the same
 * warning `bands.ts`'s own module note makes about `buildFleet`).
 *
 * Ruling 12 names five candidate moments: lane born, lane landed (gate
 * merge), gate held, attention-summons onset, session boundary. Four have a
 * clean, self-attributing event behind them; the fifth does not, and this
 * file does not invent one for it (the issue's own instruction: "if a moment
 * you need has no event, name it in your summary — do not invent one").
 *
 * - **`lane-born`** — the earliest event `laneOf` attributes to a handle,
 *   exactly the fact `bandsFor`'s own `firstSeenTs` already is.
 * - **`lane-landed`** — the earliest `agent.status` declaring `done` for a
 *   lane. Workmux's own terminal declaration is the closest existing signal
 *   to "this lane's work landed"; a literal merge-to-main event does not
 *   exist (`commit.landed` is keyed by branch/path, and joining that to a
 *   handle is `buildFleet`'s `resolveLaneId`, not this file's — see
 *   `bands.ts`'s module note, restated for marks).
 * - **`gate-held`** — every `trace.span` of kind `tool_blocked`: the CLI's
 *   own permission wait, exported once it resolves (prd9 ruling 6). This is
 *   a literal gate in the log's own vocabulary, not a metaphor borrowed from
 *   `agent.status: 'waiting'` (which `bandsFor` already renders as a WAITING
 *   band — turning every one of those into a chapter too would flood the
 *   mark lane with the same story the band row already tells).
 * - **`session-boundary`** — every `session.started` event. There is no
 *   `session.ended` type, so this file draws no closing boundary — the log's
 *   own edge is `lastSeenTs`/the caller's `end`, not a fact this selector
 *   can `push`.
 *
 * **`attention-summons onset` has no event.** The ladder's rank (prd3 ruling
 * 18's pathologies) is `buildFleet`'s own judgement, folded from multiple
 * signal kinds against a clock (FROZEN needs "now") and the fence manifest
 * (`OFF-FENCE` needs `.swarm/lanes.json`) — reproducing it here would mean
 * either reaching for the wall clock (which `purity.test.ts` forbids outright)
 * or re-deriving `buildFleet`'s fold beside it, the exact drift `bands.ts`
 * already warns against. No mark kind is emitted for it.
 *
 * Laws, each restated as a test in `chapters.test.ts` — the keystone's own
 * laws, for marks instead of bands:
 *
 * 1. **Deterministic.** Same events in, byte-equal chapters out; no clock, no
 *    unseeded random.
 * 2. **Prefix-consistent.** `chaptersFor` over a time-prefix of the log
 *    equals `chaptersFor` over the whole log, filtered to that same prefix.
 * 3. **One row per real fact.** `gate-held` and `session-boundary` are
 *    emitted once per matching event; `lane-born`/`lane-landed` are emitted
 *    once per lane, at that lane's earliest matching event — never revised
 *    by a later one, the same "never rewind" discipline `bandsFor` applies
 *    to its cursors.
 */

export const CHAPTER_KINDS = ['lane-born', 'lane-landed', 'gate-held', 'session-boundary'] as const
export type ChapterKind = (typeof CHAPTER_KINDS)[number]

/** One glance-layer instant. `lane` is `null` only for `session-boundary`, which names no lane. */
export interface Chapter {
  kind: ChapterKind
  /** The seek target — always the triggering event's own `ts`, never approximated. */
  ts: number
  lane: string | null
  /** `gate-held` only, when the span said which tool was waiting on a human. */
  toolName: string | null
}

const CHAPTER_VERB: Record<ChapterKind, string> = {
  'lane-born': 'born',
  'lane-landed': 'landed',
  'gate-held': 'held',
  'session-boundary': 'started',
}

/**
 * The hover's who/what/when, in the ruling-6 voice — `formatRange`/
 * `formatDuration`'s sibling for an instant rather than a span:
 * `163 landed · 14:32:07`.
 */
export function chapterLabel(chapter: Chapter): string {
  const who = chapter.lane ?? 'session'
  const what =
    chapter.kind === 'gate-held' && chapter.toolName !== null
      ? `${CHAPTER_VERB[chapter.kind]} on ${chapter.toolName}`
      : CHAPTER_VERB[chapter.kind]
  return `${who} ${what} · ${formatClockSeconds(chapter.ts)}`
}

/**
 * Every chapter mark the log attests, in one forward pass gathering the
 * per-lane earliest-sighting facts (`lane-born`/`lane-landed` need "the
 * earliest", so they resolve after the pass, from a `Map` each) plus every
 * `gate-held`/`session-boundary` instant (each is its own fact, pushed as
 * seen — no waiting to resolve).
 *
 * The log is expected in non-decreasing `ts` order, same as `bandsFor`; the
 * final sort by `(ts, kind, lane)` makes the output well-ordered and
 * deterministic regardless, the same defensive stance `coalesce.ts` takes.
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
      chapters.push({ kind: 'session-boundary', ts: event.ts, lane: null, toolName: null })
    }

    if (lane !== null && event.type === 'agent.status' && event.payload.status === 'done') {
      const seen = landedAt.get(lane)
      if (seen === undefined || event.ts < seen) landedAt.set(lane, event.ts)
    }

    if (lane !== null && event.type === 'trace.span' && event.payload.kind === 'tool_blocked') {
      chapters.push({ kind: 'gate-held', ts: event.ts, lane, toolName: event.payload.toolName ?? null })
    }
  }

  for (const [lane, ts] of bornAt) chapters.push({ kind: 'lane-born', ts, lane, toolName: null })
  for (const [lane, ts] of landedAt) chapters.push({ kind: 'lane-landed', ts, lane, toolName: null })

  return chapters.sort(
    (a, b) => a.ts - b.ts || compareStrings(a.kind, b.kind) || compareStrings(a.lane ?? '', b.lane ?? ''),
  )
}
