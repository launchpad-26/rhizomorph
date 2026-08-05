import {
  voiceUnknownEvents,
  type RhizomorphEvent,
  type UnknownEventLine,
} from '../events/index.js'
import { readRecord } from './read.js'
import type { Actor, SessionRecord } from './schema.js'

/**
 * An unknown line, tagged with whose record it came from — prd17 ruling 3,
 * item 1 in the merge's shape. `lineNumber` is 1-based within *that actor's own*
 * body, which is only meaningful alongside the actor, hence the pairing.
 */
export interface MergedUnknownLine extends UnknownEventLine {
  actorInstance: string
}

/**
 * Two (or more) actors' records for one repo, folded into a single coherent
 * event stream — prd11 ruling 3's "mergeable by construction". Not a new
 * signed `SessionRecord`: a hash chain is one actor's own artifact, so a
 * merge keeps both source manifests for provenance instead of minting a
 * chain neither actor actually produced.
 */
export interface MergedRecord {
  repoSlug: string
  actors: Actor[]
  /** Deduped, per-actor-append-only, cross-actor-by-timestamp-with-actor-tiebreak ordered. */
  events: RhizomorphEvent[]
  /**
   * Lines neither this era could fold nor this merge would drop (prd17 ruling
   * 3, item 1) — actor `a`'s in body order, then actor `b`'s.
   *
   * They are *not* interleaved into `events` and cannot be: an event this era
   * cannot parse has no `RhizomorphEvent` to place, and inventing one would be
   * the guess this whole ruling forbids. They are carried beside the stream,
   * counted, byte-for-byte, so the merged fold can say what it did not
   * understand instead of quietly folding a smaller history — which is exactly
   * what a federated merge of a newer actor's record used to do, before it
   * refused the whole record instead.
   *
   * Always present, empty when there is nothing to report — unlike
   * `VerifySuccess`, which keeps these two absent for a record from this era.
   * The difference is deliberate and is about *what the value is*: a
   * `SessionRecord` is an artifact already exported and read by tooling outside
   * this repo, so its verification result may not grow a key for the common
   * case; a `MergedRecord` is a value this function mints in-process for its own
   * caller, so the plainer always-there shape wins.
   */
  unknown: MergedUnknownLine[]
  /** {@link voiceUnknownEvents} over `unknown`, or `null` when there is nothing to say. */
  unknownVoice: string | null
}

export type MergeResult = { ok: true; merged: MergedRecord } | { ok: false; reason: string }

interface TaggedEvent {
  actorInstance: string
  event: RhizomorphEvent
}

type ExtractResult =
  | { ok: true; events: TaggedEvent[]; unknown: MergedUnknownLine[] }
  | { ok: false; reason: string }

/**
 * One record's body → its events, tagged with their actor, plus its unknowns.
 *
 * Lenient (prd17 ruling 3, item 1): a line from a newer era is counted and
 * preserved rather than sinking the merge. A line that is not an event at all
 * still refuses — a merge that quietly ate a broken emitter's garbage would be
 * inventing history, which is precisely what {@link mergeRecords} refuses to do
 * across repos too.
 */
function extractEvents(record: SessionRecord): ExtractResult {
  const actorInstance = record.manifest.actor.instance
  const read = readRecord(record)
  if (read.malformed !== null) {
    return {
      ok: false,
      reason: `actor ${actorInstance}, line ${read.malformed.lineNumber} is not an event at all: ${read.malformed.detail}`,
    }
  }
  return {
    ok: true,
    events: read.events.map((event) => ({ actorInstance, event })),
    unknown: read.unknown.map((entry) => ({ ...entry, actorInstance })),
  }
}

/**
 * Union by `(actor.instance, event id)`, so an event id minted independently
 * by two actors' own counters (e.g. both sessions' first event is `evt-1`)
 * never collides, while the same actor's record merged against itself (an
 * overlapping re-export) still dedupes correctly. `seen` is shared across
 * both calls below, so a cross-stream match (two records for the very same
 * actor) is caught too, not just within-stream repeats.
 */
function dedupe(events: readonly TaggedEvent[], seen: Set<string>): TaggedEvent[] {
  return events.filter((tagged) => {
    const key = `${tagged.actorInstance}${tagged.event.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Stably interleaves two per-actor streams: at each step, takes whichever
 * head has the earlier timestamp (actor instance breaking a tie), never
 * reordering *within* a stream. That is what "per-actor append-only,
 * cross-actor by timestamp" means — a stream whose own timestamps aren't
 * perfectly monotonic (the tail-ordering quirk `session-log.ts` documents)
 * still never has its own events reordered relative to each other.
 */
function interleave(a: readonly TaggedEvent[], b: readonly TaggedEvent[]): RhizomorphEvent[] {
  const merged: RhizomorphEvent[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const left = a[i]!
    const right = b[j]!
    const takeLeft =
      left.event.ts < right.event.ts ||
      (left.event.ts === right.event.ts && left.actorInstance <= right.actorInstance)
    if (takeLeft) {
      merged.push(left.event)
      i += 1
    } else {
      merged.push(right.event)
      j += 1
    }
  }
  while (i < a.length) {
    merged.push(a[i]!.event)
    i += 1
  }
  while (j < b.length) {
    merged.push(b[j]!.event)
    j += 1
  }
  return merged
}

/**
 * Merges two records from the same repo into one coherent fold. Two records
 * from different repos refuse to merge — an honest error, not a best-effort
 * guess at reconciling unrelated histories.
 */
export function mergeRecords(a: SessionRecord, b: SessionRecord): MergeResult {
  if (a.manifest.repoSlug !== b.manifest.repoSlug) {
    return {
      ok: false,
      reason: `cannot merge records from different repos: "${a.manifest.repoSlug}" vs "${b.manifest.repoSlug}"`,
    }
  }

  const extractedA = extractEvents(a)
  if (!extractedA.ok) return extractedA
  const extractedB = extractEvents(b)
  if (!extractedB.ok) return extractedB

  const seen = new Set<string>()
  const streamA = dedupe(extractedA.events, seen)
  const streamB = dedupe(extractedB.events, seen)

  // Unknowns are NOT deduped: the dedup key is `(actor.instance, event.id)` and
  // an unknown line has no parsed event to take an id from. Deduping on the raw
  // line text instead would be a different rule wearing the same name, and it
  // would quietly collapse two genuinely distinct events from a newer era that
  // happened to serialise identically. Counting both is the honest answer.
  const unknown = [...extractedA.unknown, ...extractedB.unknown]

  return {
    ok: true,
    merged: {
      repoSlug: a.manifest.repoSlug,
      actors: [a.manifest.actor, b.manifest.actor],
      events: interleave(streamA, streamB),
      unknown,
      unknownVoice: voiceUnknownEvents(unknown),
    },
  }
}
