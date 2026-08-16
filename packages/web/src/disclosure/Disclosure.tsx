import { useId, useState, type ReactElement, type ReactNode } from 'react'
import { DisclosureCard } from './DisclosureCard.js'
import type { DisclosureContent } from './vocabulary.js'

/**
 * THE ONE DISCLOSURE AFFORDANCE (prd-30 ruling 1 · charter §6, binding · #554)
 * — wrap a mark in this and it explains itself, by mouse, by keyboard and by
 * touch, with the same card in all three.
 *
 * **Hover and focus are the same event here, structurally.** They are not two
 * code paths asserted to agree: `open` is one boolean OR-ed out of the senses
 * that can open it, and there is exactly one `<DisclosureCard>` in the tree
 * below. A keyboard user cannot be shown less than a mouse user because there
 * is no second render to be shown *from*. The test that asserts parity
 * compares the two markups anyway — the structure is the guarantee, the
 * assertion is what stops a later hand from adding the second path.
 *
 * **`Escape` closes, and closing survives still being focused.** `dismissed`
 * is separate from `focused` for that reason: a reader who has read the card
 * and pressed Escape wants the mark back, not the card redrawn because their
 * keyboard never left. Moving away and returning re-opens it.
 *
 * **Touch taps open it.** `onClick` pins the card, which is the tap path on a
 * device with no hover at all, and a second tap unpins. No disclosure in the
 * instrument is pointer-only, and none is hover-only either.
 *
 * **It opens immediately.** The native `title=` this replaces is OS-delayed by
 * something like a second, and that delay is named in prd-30's problem
 * statement as part of the defect rather than as polish. `MarkHoverCard`'s own
 * open delay is its business until wave 3 re-seats it here.
 *
 * **One focus token, and it is not ours.** The trigger wears `focus-ring`
 * (prd-32 ruling 9, #548) and this directory defines no focus paint of its
 * own — prd-30 says so explicitly ("its keyboard work is about what focus
 * reveals, not what it draws"), and #548 had just finished deleting three
 * hand-rolled idioms. `one-card-law.test.ts` holds this directory to that.
 *
 * The card is `pointer-events-none` and positioned under the trigger, so it
 * can never sit between the pointer and the mark it explains — a card that
 * swallowed its own trigger's `mouseleave` would flicker. Viewport-aware
 * positioning is the loupe's existing code and re-seats here in a later wave
 * (prd-30, *what already exists*); this places it in flow beneath the mark,
 * which is right for every adoption site that exists today.
 */
export interface DisclosureProps {
  /** The three strings, from the selector. Never composed here. */
  disclosure: DisclosureContent
  /** The mark itself — the word, glyph or figure being explained. */
  children: ReactNode
  /** The trigger's accessible name, when the mark is not readable text on its own. */
  triggerLabel?: string
  /** Classes for the trigger, beside the one focus token. */
  className?: string
}

export function Disclosure({ disclosure, children, triggerLabel, className }: DisclosureProps): ReactElement {
  const cardId = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [tapped, setTapped] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const open = !dismissed && (hovered || focused || tapped)

  return (
    <span
      className="relative inline-flex"
      data-testid="disclosure"
      onMouseEnter={() => {
        setHovered(true)
        setDismissed(false)
      }}
      onMouseLeave={() => {
        setHovered(false)
        setTapped(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // Stopped here rather than left to bubble: a dismissed card must not
        // also close the drawer or panel it is sitting inside.
        event.stopPropagation()
        setDismissed(true)
        setTapped(false)
      }}
    >
      <button
        type="button"
        data-testid="disclosure-trigger"
        data-open={open}
        aria-label={triggerLabel}
        aria-describedby={open ? cardId : undefined}
        className={className === undefined ? 'focus-ring' : `focus-ring ${className}`}
        onFocus={() => {
          setFocused(true)
          setDismissed(false)
        }}
        onBlur={() => {
          setFocused(false)
          setTapped(false)
        }}
        onClick={() => {
          setTapped((pinned) => !pinned)
          setDismissed(false)
        }}
      >
        {children}
      </button>
      {open ? (
        <span className="pointer-events-none absolute left-0 top-full z-50 pt-1">
          <DisclosureCard disclosure={disclosure} id={cardId} />
        </span>
      ) : null}
    </span>
  )
}
