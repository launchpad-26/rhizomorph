import { formatSpan } from '../fleet/plumbing.js'
import type { BeaconAttentionKind } from '../events/index.js'
import type { DeclaredAttention } from '../state.js'

/**
 * prd-27 ruling 6 (#218): how long a declaration stands before its silence
 * contradicts it. MEASURED, not guessed — `docs/design-notes/beacon-lapse-interval.md`
 * records the sessions, the longest gap between beacons inside an active
 * turn, and the derivation (3× that gap, floored at 2× TURN_SETTLE_MS, rounded
 * up to the minute). A test reads the note and fails if this number and the
 * note's disagree.
 */
export const BEACON_LAPSE_MS = 180_000

export type DeclarationStatus = 'live' | 'lapsed'

/**
 * Whether a declaration still stands. Age alone contradicts `working` and
 * `stopped` (a working harness fires on every prompt and tool result); only
 * work *after* it contradicts `waiting` (a lane waiting on a human is silent
 * for as long as the human takes). `null` when nothing was declared. Presence
 * is the caller's: a landed lane has not lapsed, it has finished.
 */
export function declarationStatus(
  declared: { kind: BeaconAttentionKind; at: number } | null,
  now: number,
  lastWorkTs: number | null,
): DeclarationStatus | null {
  if (declared === null) return null
  const age = now - declared.at
  if (age <= BEACON_LAPSE_MS) return 'live'
  if (declared.kind === 'waiting') return lastWorkTs !== null && lastWorkTs > declared.at ? 'lapsed' : 'live'
  return 'lapsed'
}

/** How long ago a lapsed declaration lapsed — the `<span>` the voice reads. */
export function lapsedForMs(declared: { at: number }, now: number): number {
  return Math.max(0, now - declared.at - BEACON_LAPSE_MS)
}

export type AttentionReading =
  | { kind: 'never-declared' }
  | { kind: 'configured-silent' }
  | { kind: 'live'; declared: DeclaredAttention }
  | { kind: 'lapsed'; declared: DeclaredAttention; lapsedForMs: number }

/**
 * prd-27 ruling 3's three readings for one lane. "Configured" is the only
 * fact the fold can know without a new slice: some lane in this session has
 * been declared for. A beacon directory holding only foreign kinds reads as
 * never-declared here — known limit, stated in the design note.
 */
export function attentionReading(
  declared: Readonly<Record<string, DeclaredAttention>>,
  laneId: string,
  now: number,
  lastWorkTs: number | null,
): AttentionReading {
  const own = declared[laneId]
  if (own === undefined) {
    return Object.keys(declared).length === 0 ? { kind: 'never-declared' } : { kind: 'configured-silent' }
  }
  return declarationStatus(own, now, lastWorkTs) === 'lapsed'
    ? { kind: 'lapsed', declared: own, lapsedForMs: lapsedForMs(own, now) }
    : { kind: 'live', declared: own }
}

/** The reason a configured-but-silent beacon organ reads `partial` (prd-27 ruling 3's carve-out). */
export const CONFIGURED_SILENT_REASON = 'hooks configured; no beacon for this lane yet'

/** What would strengthen it — the reading names the first hook that speaks. */
export const CONFIGURED_SILENT_REMEDY =
  "the first hook that fires — UserPromptSubmit on the lane's next prompt — declares it"

/**
 * The one sentence a lapsed declaration speaks (prd-27 ruling 6's own words):
 * the card carries it in place of the declared clause, `detectWaiting` appends
 * it to whatever inference then stands, and `doctor` prints it per lane.
 */
export function lapsedVoice(lapsedFor: number): string {
  return `declared attention lapsed ${formatSpan(lapsedFor)} ago; reading turn shape`
}
