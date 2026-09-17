import type { Fleet, Lane } from './types.js'

/**
 * WHAT NEEDS A HUMAN IN A COLONY NOBODY IS LOOKING AT — prd-58 ruling 5.
 *
 * > This is what makes ruling 1 safe. Rendering one colony is only acceptable
 * > if **not** rendering the others hides nothing that needs you.
 *
 * Ruling 1 lets the scene compose exactly one colony, which is the whole reason
 * Success 2 can stay green and prd-52's supported-size question can stay
 * closed. That trade is only honest if the colonies off-screen can still shout.
 *
 * **A count, not a rung.** The selector shows how many lanes in each colony
 * need a person; it does not rank the colonies against each other, because
 * ADR-0010 asks for the gap named rather than scored and "which of my repos is
 * worst" is a question with no honest answer. Two colonies with one waiting
 * lane each are two colonies with one waiting lane each.
 */
export interface ColonyAttention {
  readonly colonyId: string
  /** Lanes the harness says have stopped for a human. */
  readonly waiting: number
  /** Lanes whose agent vanished — `crashed`, reached from a process fact and never from silence. */
  readonly crashed: number
  /**
   * Lanes that have gone quiet past the flatline threshold.
   *
   * The pathology is spelled `frozen` — ruling 5 says "flatlined", and
   * `FROZEN_AFTER_MS` is the flatline detector's own threshold. Named for the
   * kind rather than the ruling's word, so a reader grepping the vocabulary
   * finds it.
   */
  readonly frozen: number
  /**
   * The one number a badge or a tab title shows.
   *
   * A sum rather than a max: three lanes needing a human is three things to do,
   * and a reader who sees `1` because the worst kind happened once has been
   * told something false about their own morning.
   */
  readonly needsYou: number
}

/** The three pathology kinds ruling 5 names, and nothing else. */
const NEEDS_YOU_KINDS = ['waiting', 'crashed', 'frozen'] as const

/**
 * Count one colony's lanes that need a person.
 *
 * Reads the FLEET rather than the fold, so it counts exactly what the fleet
 * list would show — a count derived from a different reading than the list
 * beside it is how two surfaces come to disagree about one repo, which is the
 * defect prd-27's "assembled once" exists to prevent and which this PRD's
 * predecessor shipped between a card and `doctor`.
 */
export function colonyAttention(colonyId: string, fleet: Fleet): ColonyAttention {
  let waiting = 0
  let crashed = 0
  let frozen = 0

  for (const lane of fleet.lanes) {
    // A lane nobody is in cannot need anyone. `present` is the fleet's own word
    // for "this lane still exists", and counting a removed worktree's last
    // known state would be a summons to a place the operator cannot go.
    if (!lane.present) continue
    for (const pathology of lane.pathologies) {
      if (pathology.kind === 'waiting') waiting += 1
      else if (pathology.kind === 'crashed') crashed += 1
      else if (pathology.kind === 'frozen') frozen += 1
    }
  }

  return { colonyId, waiting, crashed, frozen, needsYou: waiting + crashed + frozen }
}

/**
 * Every colony's count, in the order the colonies were given.
 *
 * Order is the caller's — discovery returns the pinned colony first and then by
 * id, and re-sorting here by count would make the selector's rows jump every
 * time a lane changed state. A selector nobody can click is worse than one that
 * needs reading.
 */
export function colonyAttentionAll(fleets: readonly { colonyId: string; fleet: Fleet }[]): ColonyAttention[] {
  return fleets.map((entry) => colonyAttention(entry.colonyId, entry.fleet))
}

/**
 * Every lane across every colony, labelled by the colony it belongs to —
 * ruling 5's fleet list.
 *
 * The list is a **table, not a scene**, so it composes freely and shows every
 * colony at once without touching Success 2's one-colony question at all. That
 * separation is the whole reason ruling 1 could choose one colony for the scene
 * without hiding anything.
 */
export interface LabelledLane {
  readonly colonyId: string
  readonly lane: Lane
}

export function lanesAcrossColonies(fleets: readonly { colonyId: string; fleet: Fleet }[]): LabelledLane[] {
  return fleets.flatMap((entry) => entry.fleet.lanes.map((lane) => ({ colonyId: entry.colonyId, lane })))
}

/** The kinds this module counts, exported so a law can assert it covers them. */
export const COLONY_NEEDS_YOU_KINDS = NEEDS_YOU_KINDS
