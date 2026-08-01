import type { Fleet, LadderRank } from '../fleet/index.js'
import { rankIndex } from '../fleet/index.js'
import { clamp01, fade, luminance, type Ink } from './palette.js'

/**
 * THE CONTRAST BUDGET — spotlight, not shouting.
 *
 * "Make a needs-you lane the single most salient object" (ruling 21) is settled
 * here, arithmetically, rather than by tuning brightnesses until a screenshot
 * looks right. Three rules, and every mark in the scene passes through them:
 *
 * 1. **Recede, don't shout** (graft g6's other half, A's contrast-spend note).
 *    At NEEDS-YOU and above one lane keeps 100% and every other *lane* drops to
 *    {@link RECEDE}. Salience is a ratio: no amount of amber wins against
 *    nineteen calm threads at full contrast. The root-mass and the scene's own
 *    chrome are not lanes and are exempt — see {@link emphasisOf}.
 * 2. **Alarms are exempt from every fade** (graft g2). Recency dimming and
 *    salience dimming both skip a needs-you/broken mark. Without this, FROZEN —
 *    the one state *defined* by being old — would be the dimmest thing on the
 *    page, and a second summons would be muted by the first.
 * 3. **The top of the luminance range is reserved for the ladder** (graft g6).
 *    Every non-alarm mark is capped at {@link CALM_CEILING}, which sits below
 *    the dimmest alarm ink. So a white-hot EXPENSIVE thread — lawful luminance,
 *    not a fifth hue — structurally cannot out-read a summons, and neither can a
 *    bright pulse, nor the root-mass core. The staged fixture asserts the
 *    comparison; the cap is what makes the assertion hold by construction.
 */

/** What everything the spotlight is not on drops to. */
export const RECEDE = 0.3

/**
 * The ceiling every non-alarm mark is held under, in {@link luminance} units.
 * Chosen just below the amber summons at full strength (~0.80), so the gap is
 * real but the calm world still reaches most of the range it has.
 */
export const CALM_CEILING = 0.7

/** Rungs whose marks are exempt from every fade and own the range above the cap. */
const ALARM_RANKS: readonly LadderRank[] = ['needs-you', 'broken']

export function isAlarmRank(rank: LadderRank): boolean {
  return ALARM_RANKS.includes(rank)
}

export interface Salience {
  /**
   * The one lane the spotlight is on, or null when nothing needs anyone. Taken
   * from the ladder rather than recomputed: the strip, the table and the scene
   * must agree about which lane is worst, and the ladder already decided.
   */
  spotlightId: string | null
  /** Operator intent overrides the spotlight — a hovered lane is never dimmed. */
  hoverId: string | null
}

export interface SalienceInputs {
  fleet: Fleet
  hoverId: string | null
  /** A clicked lane takes the spotlight from the ladder's own pick. */
  selectedId: string | null
}

/**
 * Who gets the light. Nothing is dimmed below NEEDS-YOU: a calm fleet is not a
 * fleet with a winner, and picking one anyway would teach the operator that the
 * spotlight means nothing.
 *
 * A collision never takes the spotlight — it belongs to a pair of branches, so
 * its ladder item carries no lane id and this returns null for it, rather than
 * lighting an arbitrary half of the pair.
 */
export function salienceOf({ fleet, hoverId, selectedId }: SalienceInputs): Salience {
  if (selectedId !== null) return { spotlightId: selectedId, hoverId }
  if (rankIndex(fleet.rank) < rankIndex('needs-you')) return { spotlightId: null, hoverId }

  const worst =
    fleet.ladder.rank === 'calm'
      ? null
      : (fleet.ladder.items.find((item) => item.laneId !== null)?.laneId ?? null)

  return { spotlightId: worst, hoverId }
}

/**
 * How much of its brightness a mark keeps. Alarm marks keep all of it, always
 * (graft g2); a hovered or spotlit lane keeps all of it; everything else recedes
 * once there is something worth receding for.
 */
function emphasisOf(
  salience: Salience,
  laneId: string | null,
  alarm: boolean,
): number {
  if (alarm) return 1
  if (salience.spotlightId === null) return 1
  // The root-mass and the scene's own chrome are not lanes and are never in the
  // running: receding them dims the thing every thread is threaded *into*, so
  // the network stops reading as a network at precisely the moment somebody is
  // looking hard at it. They stay under the calm ceiling like everything else,
  // which is what keeps them out of the summons's way.
  if (laneId === null) return 1
  if (laneId === salience.hoverId) return 1
  return laneId === salience.spotlightId ? 1 : RECEDE
}

/**
 * The budget, applied. An alarm mark is passed through untouched; anything else
 * is faded by its emphasis and then held under the ceiling.
 *
 * Capping by scaling alpha rather than by darkening the colour keeps the hue
 * intact, which matters for the one non-alarm mark that has one: EXPENSIVE's
 * cyan chevrons are a NOTICE and must still read as cyan while receding.
 */
export function spend(
  source: Ink,
  salience: Salience,
  laneId: string | null,
  alarm: boolean,
): Ink {
  if (alarm) return source
  const faded = fade(source, emphasisOf(salience, laneId, alarm))
  return capLuminance(faded, CALM_CEILING)
}

/** Scales alpha down — never up — until the ink is no brighter than `ceiling`. */
function capLuminance(source: Ink, ceiling: number): Ink {
  const bright = luminance(source)
  if (bright <= ceiling) return source
  return { rgb: source.rgb, alpha: clamp01(source.alpha * (ceiling / bright)) }
}
