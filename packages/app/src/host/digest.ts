import type { Fleet, LadderRank } from '@rhizomorph/core'

/**
 * THE FLEET, AS MUCH OF IT AS THE DESKTOP CAN CARRY (#564, ruling 8).
 *
 * A tray icon and a notification are a few bytes each; the fleet is hundreds of
 * fields. This is the projection between them — and it is a *projection*, never
 * a second derivation: every field below is read straight off the `Fleet` the
 * window is reading, and nothing here recomputes a rung, a pathology or a
 * total.
 *
 * The projection is also what makes the notifier honest across ticks. The fleet
 * is rebuilt every second, so "a lane needs a human" cannot mean "the fleet
 * currently has a needs-you item" — that would notify once a second for as long
 * as the lane sat waiting. It means "an item is here that was not here before",
 * which needs stable identity, which is what `AttentionRef.id` is: the ladder's
 * own `${kind}:${laneId}` key.
 */

/** One ladder item, reduced to what a notification and a menu line need. */
export interface AttentionRef {
  /** The ladder's own id — `waiting:lane-07`, `collision`, `collector:git`. Stable across ticks. */
  id: string
  label: string
  kind: string
}

export interface FleetDigest {
  /** The ladder's rung, verbatim. The badge reads this and nothing else. */
  rank: LadderRank
  /** Everything at the `needs-you` rung — the ladder's own answer to "does this need a human". */
  needsYou: AttentionRef[]
  /** Everything at the `broken` rung. Today that is a frozen lane: dead air. */
  broken: AttentionRef[]
  /** Worktrees that have gone away — `root.landings`, the instrument's own count of lanes that landed and folded. */
  landings: number
  /** Session cost so far. */
  costUsd: number
  /** Null when no cost event was counted at all: unknown, never free. A spend threshold may not fire on an unknown. */
  costIsAuthoritative: boolean | null
  laneCount: number
}

/**
 * **Why the two lists are rungs, not hand-picked pathologies.** ruling 8 names
 * four conditions, and the tempting reading of "a lane needs a human" is the
 * `waiting` pathology alone. That reading would have the tray stay quiet for a
 * lane stuck in a loop and for a lane writing outside its fence — both of which
 * the instrument itself escalates to `needs-you`, and both of which are exactly
 * the thing a person walked away from the screen not knowing. Taking the rung
 * instead means the desktop and the instrument cannot disagree about what needs
 * a human, because it is the same question asked once.
 *
 * A collision has no lane (`laneId: null` — it belongs to a pair of branches),
 * and it is included for the same reason: it is on the rung.
 */
export function digestOf(fleet: Fleet): FleetDigest {
  const refs = fleet.ladder.items.map((item) => ({ id: item.id, label: item.label, kind: item.kind }))
  return {
    rank: fleet.rank,
    needsYou: refs.filter((_, index) => fleet.ladder.items[index]?.rank === 'needs-you'),
    broken: refs.filter((_, index) => fleet.ladder.items[index]?.rank === 'broken'),
    landings: fleet.root.landings,
    costUsd: fleet.burn.costUsd,
    costIsAuthoritative: fleet.burn.costIsAuthoritative,
    laneCount: fleet.lanes.length,
  }
}

/** The digest of a fleet nobody has seen yet — what the shell holds before the first event lands. */
export function emptyDigest(): FleetDigest {
  return {
    rank: 'calm',
    needsYou: [],
    broken: [],
    landings: 0,
    costUsd: 0,
    costIsAuthoritative: null,
    laneCount: 0,
  }
}
