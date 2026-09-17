import { LADDER_WORD, type LadderRank } from '@rhizomorph/core'
import { type IconShape, RANK_SHAPE } from './tray-icon.js'

/**
 * THE LADDER, PROMOTED TO THE OPERATING SYSTEM (#564; ruling 8's "the tray
 * badge carries the fleet's own attention state at OS level").
 *
 * **This function takes a rank. That is the whole design.** Ruling 8 says a
 * muted notification still moves the badge — muting is about interruption,
 * never about hiding — and the way this package keeps that promise is that
 * there is no parameter through which a preference could reach here. Not a
 * convention, not a review note: {@link badgeFor} has one argument and it is
 * the instrument's own rung. `badge-law.test.ts` asserts the badge is
 * byte-identical with every notification silenced, which is a test that would
 * be impossible to write if the signature were any wider.
 *
 * The four rungs and their marks are the instrument's own vocabulary
 * (`LADDER_WORD` in core), not a second alphabet invented for the desktop: a
 * person who reads NEEDS YOU in the attention strip reads NEEDS YOU in the
 * tooltip.
 *
 * **Why a glyph and a tooltip rather than a colour.** A tray icon is 16px and
 * renders monochrome-templated on macOS, arbitrary-themed on Linux, and over
 * whatever the taskbar colour happens to be on Windows. Hue is the one channel
 * that is not ours on any of the three, so the rung is carried by shape and by
 * words — which is also the instrument's own posture (`sigils.tsx`: form says
 * which, hue says how bad).
 */

export interface TrayBadge {
  /** The rung, carried through unchanged so a reader can assert against `fleet.rank`. */
  rank: LadderRank
  /** The instrument's own word: ALL CLEAR / NOTICE / NEEDS YOU / BROKEN. */
  word: string
  /** The mark drawn over the tray icon, and on macOS the tray title beside it. */
  mark: string
  /** The icon's own form. Form says which, hue says how bad (`sigils.tsx`). */
  shape: IconShape
  /** The tooltip, one line. */
  tooltip: string
  /** True for the two rungs that want a person — what a platform's own "attention" affordance keys off. */
  wantsAttention: boolean
  /**
   * How many lanes across EVERY watched colony need a person — prd-58 ruling 5.
   *
   * `undefined` when the shell is talking to a server that does not report
   * colonies (one that predates prd-58, or a replay server), which is a
   * different fact from zero and is rendered as no count rather than as "0".
   *
   * **This is where ruling 5 matters most.** The tray is visible when the app
   * is not, so a badge counting only the RENDERED colony would make ruling 1
   * unsafe in exactly the way ruling 5 exists to prevent: the operator sees
   * calm and has three lanes waiting in a repo they are not looking at.
   */
  needsYouAcrossColonies?: number
}

/** Shape, not hue: a rising ladder, and nothing at rest. */
const MARK: Record<LadderRank, string> = {
  calm: '',
  notice: '·',
  'needs-you': '▲',
  broken: '■',
}

export function badgeFor(rank: LadderRank, needsYouAcrossColonies?: number): TrayBadge {
  const across = needsYouAcrossColonies
  // The count joins the tooltip only when there is something to say AND more
  // than the rendered colony could account for it. A tooltip that repeated the
  // rung as a number would be two spellings of one fact, which is the shape
  // this repo already refuses between a card and a check.
  const tooltip =
    across === undefined || across === 0
      ? `rhizomorph — ${LADDER_WORD[rank]}`
      : `rhizomorph — ${LADDER_WORD[rank]} · ${across} lane${across === 1 ? '' : 's'} need you`
  return {
    rank,
    word: LADDER_WORD[rank],
    mark: MARK[rank],
    shape: RANK_SHAPE[rank],
    tooltip,
    // **Across every colony, not just the rendered one.** A rung is a fact
    // about what the scene is showing; this is a fact about the machine. An
    // operator whose only waiting lane is off-screen still gets the affordance.
    wantsAttention: rank === 'needs-you' || rank === 'broken' || (across ?? 0) > 0,
    ...(across === undefined ? {} : { needsYouAcrossColonies: across }),
  }
}

/**
 * The badge when there is no fleet to read: the server is not running, or has
 * not spoken yet. **Not `calm`** — S2 lists *server unreachable* as its own
 * state, and a calm tray over an instrument that is not there is precisely the
 * lie the honest-gap voices exist to prevent. It is not an alarm either: dead
 * air from the *shell's* own server is a gap, not a lane's pathology.
 */
export function unreachableBadge(detail: string): TrayBadge {
  return {
    rank: 'notice',
    word: 'NO READING',
    mark: '?',
    // Not any rung's own shape: an outline reads as "there should be something
    // here", which is exactly what a missing reading is.
    shape: 'hollow-square',
    tooltip: `rhizomorph — no reading: ${detail}`,
    wantsAttention: false,
  }
}
