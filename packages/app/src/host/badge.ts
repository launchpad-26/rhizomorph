import { LADDER_WORD, type LadderRank } from '@rhizomorph/core'
import { RANK_SHAPE, type IconShape } from './tray-icon.js'

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
}

/** Shape, not hue: a rising ladder, and nothing at rest. */
const MARK: Record<LadderRank, string> = {
  calm: '',
  notice: '·',
  'needs-you': '▲',
  broken: '■',
}

export function badgeFor(rank: LadderRank): TrayBadge {
  return {
    rank,
    word: LADDER_WORD[rank],
    mark: MARK[rank],
    shape: RANK_SHAPE[rank],
    tooltip: `rhizomorph — ${LADDER_WORD[rank]}`,
    wantsAttention: rank === 'needs-you' || rank === 'broken',
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
