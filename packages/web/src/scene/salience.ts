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
 * 3. **The top of the luminance range is reserved for the alarms** (graft g6,
 *    law 9b). Every non-alarm mark is capped at {@link CALM_CEILING} and every
 *    needs-you lane's brightest mark reaches {@link ALARM_FLOOR} above it. Since
 *    prd4 dropped hue exclusivity, this band *is* the salience mechanism: a
 *    green fleet and an amber summons no longer differ by "colour vs no colour",
 *    they differ by which side of the band they are on. So a white-hot EXPENSIVE
 *    thread — lawful luminance, not a hue — structurally cannot out-read a
 *    summons, and neither can a bright pulse, nor the root-mass core.
 *
 * The four numbers below are the whole budget, and all four are pinned by tests
 * against real fixtures rather than left as tuning knobs. That is deliberate:
 * prd4's opening complaint was that the scene had drifted dark and pale, and a
 * brightness you can only re-find by looking at it is a brightness that drifts
 * again.
 */

/** What everything the spotlight is not on drops to. */
export const RECEDE = 0.3

/**
 * The ceiling every non-alarm mark is held under, in {@link luminance} units.
 * Raised from prd3's 0.70 by ruling 3: the calm world now carries hue as well as
 * lightness, and the old ceiling left a working fleet visibly murky. It still
 * sits below {@link ALARM_FLOOR}, which is the only thing it has to do.
 */
export const CALM_CEILING = 0.78

/**
 * The floor every needs-you lane's *brightest* mark must reach — the bottom of
 * the band the alarms own. `marks.test.ts` walks the staged fixture and holds
 * each amber lane to it, so "the summons is the brightest thing on the page"
 * survives any future retune of the calm world underneath it.
 *
 * BROKEN IS EXEMPT, and on purpose. `#ff3d68` is a dark hue — pushing it to 0.84
 * means mixing it two-thirds of the way to white, at which point it is pink and
 * has stopped meaning "dead". A frozen lane instead buys its supremacy the three
 * other ways the grammar allows: it takes the **spotlight** (it is the worst
 * rung, so every other lane recedes to {@link RECEDE} around it), it is the only
 * thing on screen wearing a **cartouche**, and it is **exempt from every fade**
 * while the calm world it sits in is not. `marks.test.ts` pins that as
 * dominance-under-recession rather than as a brightness.
 */
export const ALARM_FLOOR = 0.84

/**
 * THE 9b AMENDMENT'S CEILING (prd10 ruling 4) — the one door in the band, and
 * how narrow it is.
 *
 * Ruling 4 grants a **working lane's tip, and only while it is working**, a small
 * steady glow above {@link CALM_CEILING}. That is a real amendment to law 9b and
 * worth being precise about, because the band *is* the salience mechanism since
 * prd4 dropped hue exclusivity: anything allowed past the ceiling is spending
 * attention the alarms were promised.
 *
 * So the amendment ships with four bounds, and every one of them is enforced
 * somewhere a test can read rather than trusted to a mark builder:
 *
 * 1. **It stays below {@link ALARM_FLOOR}.** This constant, and it is closer to
 *    the calm ceiling than to the alarm floor on purpose — the tip is a little
 *    brighter than the fleet, not nearly as bright as a summons.
 * 2. **It is a small radius.** {@link TIP_GLOW_RADIUS} — a few pixels at the very
 *    end of one thread. An alarm's own halo is twenty, and there is one summons
 *    against thirty tips.
 * 3. **It wears none of the alarm grammar's other instruments.** No cartouche
 *    (`rank-enclosure` is still alarm-only), and — the important one — **no fade
 *    exemption**: it passes through {@link emphasisOf} like every other calm
 *    mark, so the instant something needs a human every tip in the fleet recedes
 *    to {@link RECEDE} and the summons is alone above the band. That is what
 *    makes "an alarm anywhere on screen must still dominate at a glance" true by
 *    arithmetic rather than by taste.
 * 4. **Only a working tip.** Not a waiting one, not a landed one, not a finished one —
 *    `marks/node.ts` is the only caller and `marks.test.ts` walks the fixture to
 *    prove no other lane has one.
 *
 * The amended law is therefore *stricter* than the one it replaces in three
 * places (a stated ceiling, a stated radius, a stated eligibility) and laxer in
 * exactly one number, which is the trade the ruling makes.
 */
export const TIP_CEILING = 0.81
/** …and the radius, in px. Small enough that the band it enters is a hairline's worth. */
export const TIP_GLOW_RADIUS = 6.5

/**
 * The floor under a living lane's thread on a calm fleet — the "too dark to
 * read" regression, pinned so it cannot come back. Nothing enforces this in
 * code; it is a claim about `activityInk`'s alpha ramp that `marks.test.ts`
 * checks against the twenty-lane fixture at every freshness it produces.
 *
 * A frozen lane's thread is deliberately *below* it: absence of light is that
 * lane's encoding, which is why the pin names the calm fixture.
 */
export const CALM_FLOOR = 0.15

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
 *
 * Exported for the one caller that cannot use {@link spend}: a drift of two
 * hundred motes whose colours are a *gradient* (ruling 12), where spending the
 * budget per mote would be two hundred cap calculations for a set of inks that is
 * already built under the ceiling by construction. The recession still applies —
 * it is applied once, to the drift's peak — which is what keeps a composting cord
 * out of a summons's way like everything else calm.
 */
export function emphasisOf(
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

/**
 * The budget as a **working tip** spends it (prd10 ruling 4's amendment).
 *
 * The same two steps `spend` takes — recede, then cap — with one number changed
 * and nothing else. Written as its own function rather than as a flag on `spend`
 * so that the amendment has exactly one door and `marks.test.ts` can name every
 * caller of it: a tip glow is the only mark in the instrument that reaches this,
 * and a future hand that wanted a second one would have to write it down here.
 */
export function spendTip(source: Ink, salience: Salience, laneId: string | null): Ink {
  // Not exempt from the fade, and that is the load-bearing half: a summons
  // arrives and every tip in the fleet gets out of its way.
  return capLuminance(fade(source, emphasisOf(salience, laneId, false)), TIP_CEILING)
}

/** Scales alpha down — never up — until the ink is no brighter than `ceiling`. */
function capLuminance(source: Ink, ceiling: number): Ink {
  const bright = luminance(source)
  if (bright <= ceiling) return source
  return { rgb: source.rgb, alpha: clamp01(source.alpha * (ceiling / bright)) }
}
