import type { BeaconAttentionKind } from '../events/index.js'
import { formatSpan } from '../fleet/plumbing.js'
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
/**
 * THE DECLARED JOIN, RESOLVED — the one place `state.declared` becomes a lane's
 * declaration, and the reason it is a function rather than two lookups.
 *
 * `state.declared` is a flat namespace holding two kinds of key. A beacon whose
 * writer named the lane lands under that lane id, as it always has. A hook
 * beacon cannot name one (prd-57 ruling 3), so `beaconReceived` places it under
 * the worktree path its pid resolved to. One lane can therefore have a record
 * under BOTH.
 *
 * **Newest wins, and that is not a taste.** The first draft read the lane id
 * first and fell back — *"an explicit name beats a placement"* — which silently
 * inverted the law every other declaration in this tree is read by: the fold's
 * own `prev.at > event.ts` guard, and `reduce.test.ts`'s *"the latest by writer
 * clock wins"*. A lane instrumented BOTH by `rhizomorph env --hooks` and by the
 * hook runner would have shown an hour-old `working` over a fresh `waiting`,
 * and never raised the summons. Found in adversarial review.
 *
 * Exported and imported rather than re-spelled, because `buildFleet` and
 * `doctor` both answer this question and a lane that reads `waiting` on the
 * card while `doctor` calls it `configured-silent` is two surfaces
 * contradicting each other about one fact — which is the thing prd-27's *"the
 * condition is assembled once"* exists to prevent.
 */
export function resolveDeclared(
  declared: Readonly<Record<string, DeclaredAttention>>,
  laneId: string,
  worktreePath: string | null,
): DeclaredAttention | undefined {
  const byLane = declared[laneId]
  const byPlacement = worktreePath === null || worktreePath === laneId ? undefined : declared[worktreePath]
  if (byLane === undefined) return byPlacement
  if (byPlacement === undefined) return byLane
  return byPlacement.at > byLane.at ? byPlacement : byLane
}

export function attentionReading(
  declared: Readonly<Record<string, DeclaredAttention>>,
  laneId: string,
  now: number,
  lastWorkTs: number | null,
  /**
   * The lane's worktree, so a pid-joined declaration is found here too.
   * Optional so a caller that has no lane in hand keeps working; a caller that
   * HAS one and omits it gets the pre-prd-57 answer, which for a hook-only lane
   * is `configured-silent` — the contradiction this argument exists to close.
   */
  worktreePath: string | null = null,
): AttentionReading {
  const own = resolveDeclared(declared, laneId, worktreePath)
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
