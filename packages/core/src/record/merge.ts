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
   * Lines this era could not fold (prd17 ruling 3, item 1) — actor `a`'s in
   * body order, then actor `b`'s. Deduped on the chain link exactly as events
   * are (#173): an unknown line at a chain position already merged is that
   * same line seen twice, not a second one.
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
 *
 * **Dedup is by `(link.hash, actor.instance)` — the record's own chain link,
 * never a field inside the event (#173).** `(actor.instance, event.id)` looked
 * like an identity and was not: an event id comes from a per-run counter that
 * RESTARTS when a session resumes, so a single actor's own log repeats
 * `evt-000001` — 15 times in the ledger prd-48's S2 spike measured — and the
 * old key threw away 74.5% of it as duplicates. A chain link cannot collide
 * that way: its hash covers the line's content *and* its position in the chain,
 * so two distinct events are two distinct links even when every field matches.
 *
 * This also settles the unknown lines, which used to be exempt because they had
 * no parsed id to key on. A chain link is available whether or not this era can
 * read the line, and it is not the raw-line-text rule that exemption was
 * refusing: two newer-era events that serialise identically sit at different
 * chain positions and so keep different hashes. They now dedup exactly as
 * events do.
 *
 * The cost, named because it is real: two exports of the same actor that begin
 * at DIFFERENT first events are different chains from their genesis on, so
 * their overlap no longer dedups. The re-export this serves is the ordinary one
 * — a later export of the same log from the same start — and there the shared
 * prefix hashes identically, link for link. An export that begins mid-log is
 * honestly a different artifact; treating its events as the same ones is the
 * guess the old key was making.
 *
 * `seen` is shared across both records, so a cross-record match (two records
 * for the very same actor) is caught, not just repeats within one.
 */
function extractEvents(record: SessionRecord, seen: Set<string>): ExtractResult {
  const actorInstance = record.manifest.actor.instance
  const read = readRecord(record)
  if (read.malformed !== null) {
    return {
      ok: false,
      reason: `actor ${actorInstance}, line ${read.malformed.lineNumber} is not an event at all: ${read.malformed.detail}`,
    }
  }

  // One pass over the chain marks the duplicate POSITIONS rather than filtering
  // the body. `unknown[].lineNumber` and the `malformed` report above are both
  // 1-based within this actor's own body, and dropping links before reading
  // would renumber them — a merge that said "line 1" about line 2 would be
  // lying about the record on disk to save one array copy.
  const duplicate = new Set<number>()
  for (let index = 0; index < record.body.length; index += 1) {
    // Hash first, so the two halves are unsplittable: a chain hash is a
    // schema-validated 64-char digest, which makes it a fixed-length prefix.
    // The old key joined actor and id with nothing between them, where
    // ('ab','c') and ('a','bc') were one string — a second latent collision
    // sitting underneath the one this issue is about.
    const key = `${record.body[index]!.hash}:${actorInstance}`
    if (seen.has(key)) duplicate.add(index + 1)
    else seen.add(key)
  }

  // With `malformed` null every body line is either an event or an unknown, and
  // both arrays are in body order — so walking the body alongside them recovers
  // which line each event came from without parsing anything a second time.
  //
  // `UnknownEventLine.lineNumber` is nullable because a live-stream caller may
  // not know one; `readRecordBody` always supplies it, reading a body by index,
  // which is what makes this walk exact. A positionless unknown is therefore
  // unreachable here — and if one ever arrives it is kept rather than matched
  // to a link it cannot be shown to occupy.
  const unknownAt = new Set(
    read.unknown
      .map((entry) => entry.lineNumber)
      .filter((lineNumber): lineNumber is number => lineNumber !== null),
  )
  const events: TaggedEvent[] = []
  let next = 0
  for (let index = 0; index < record.body.length; index += 1) {
    const lineNumber = index + 1
    if (unknownAt.has(lineNumber)) continue
    const event = read.events[next]
    next += 1
    if (event !== undefined && !duplicate.has(lineNumber)) events.push({ actorInstance, event })
  }

  return {
    ok: true,
    events,
    unknown: read.unknown
      .filter((entry) => entry.lineNumber === null || !duplicate.has(entry.lineNumber))
      .map((entry) => ({ ...entry, actorInstance })),
  }
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

  // `seen` spans both records and both kinds of line, so `a` is read first and
  // `b` dedups against what `a` already contributed.
  const seen = new Set<string>()
  const extractedA = extractEvents(a, seen)
  if (!extractedA.ok) return extractedA
  const extractedB = extractEvents(b, seen)
  if (!extractedB.ok) return extractedB

  const unknown = [...extractedA.unknown, ...extractedB.unknown]

  return {
    ok: true,
    merged: {
      repoSlug: a.manifest.repoSlug,
      actors: [a.manifest.actor, b.manifest.actor],
      events: interleave(extractedA.events, extractedB.events),
      unknown,
      unknownVoice: voiceUnknownEvents(unknown),
    },
  }
}
