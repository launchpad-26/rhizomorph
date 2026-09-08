import { useId, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
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
 * Viewport-aware positioning is the loupe's existing code and re-seats here in
 * a later wave (prd-30, *what already exists*); this places the card in flow
 * beneath the mark, which is right for every adoption site that exists today.
 *
 * ---
 *
 * **What the teach affordance changed here (#561), and why.**
 *
 * The card carries a control now (`DisclosureCard`, prd-30 S2), and a control a
 * reader cannot reach is not a control. Two things follow, and both are
 * deliberate reversals of what wave 1 shipped:
 *
 * **The card is no longer `pointer-events-none`.** It was, so that it could
 * "never sit between the pointer and the mark it explains" — but the card is
 * positioned *below* its own trigger, so what that actually bought was
 * transparency over whatever is beneath, at the price of making the card itself
 * unreachable: a transparent card hit-tests through to the page, which fires
 * `mouseleave` on this wrapper, which closes the card the moment the pointer
 * moves toward it. The flicker the old note worried about is not a risk in the
 * other direction — the card is a *descendant* of the element carrying
 * `onMouseLeave`, and neither React's nor the DOM's mouseleave fires on a move
 * into a descendant. The card stays open while the pointer is on it, and closes
 * when the pointer leaves the pair.
 *
 * **Focus is tracked on the wrapper, not on the trigger, with a containment
 * check.** Focus moving trigger → teach control is a `blur` on the trigger, and
 * the old handler would have read that as "the keyboard left", unmounted the
 * card, and thrown focus to `<body>` mid-keystroke. `relatedTarget` says where
 * focus is going; if that is still inside this disclosure, the keyboard has not
 * left. This is still **one** `focused` boolean and still one card — the two
 * senses did not become two paths.
 *
 * **Escape hands focus back to the mark.** With focus inside the card, the card
 * is about to unmount; without this the reader's place in the tab order becomes
 * `<body>`. It refocuses only when focus is genuinely inside the card, so the
 * ordinary case (Escape while on the trigger) moves nothing. And a focus event
 * arriving from *inside* the wrapper does not clear `dismissed`: the reader who
 * pressed Escape has not left and has not asked again, so the card must not
 * spring back open because we moved their focus for them.
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
  /**
   * What the trigger IS — `'button'` by default, `'inline'` when the mark it
   * wraps is already a control (ADR-0040).
   *
   * A chip that filters, a row that navigates, a rename button: wrapping one of
   * those in the default trigger nests a button inside a button, which is
   * invalid markup, assembles the accessible name from two sources, and leaves
   * two click handlers racing for one tap. `'inline'` renders a focusable
   * `<span role="note">` instead, so the caller's own control stays the only
   * button on the mark.
   *
   * **It is a mode, not a second path.** Everything below this line is shared:
   * one `open` boolean, one `<DisclosureCard>`, one focus token, the same
   * Escape and tap-to-pin behaviour. The mode chooses an element and nothing
   * else — which is why `Disclosure.test.tsx` asserts hover/focus parity under
   * both rather than trusting the sentence.
   */
  trigger?: 'button' | 'inline'
}

export function Disclosure({
  disclosure,
  children,
  triggerLabel,
  className,
  trigger = 'button',
}: DisclosureProps): ReactElement {
  const cardId = useId()
  const wrapperRef = useRef<HTMLSpanElement>(null)
  // `HTMLElement` rather than `HTMLButtonElement`: the inline mode's trigger is
  // a span, and Escape's hand-back below only ever calls `focus()`.
  const triggerRef = useRef<HTMLElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [tapped, setTapped] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const open = !dismissed && (hovered || focused || tapped)

  /**
   * Everything the trigger wears, assembled once. The two branches below differ
   * in their element and in nothing else; spelling these out twice is how the
   * mode would become the second path the module note says it is not.
   */
  const triggerProps = {
    'data-testid': 'disclosure-trigger',
    'data-open': open,
    'aria-label': triggerLabel,
    'aria-describedby': open ? cardId : undefined,
    className: className === undefined ? 'focus-ring' : `focus-ring ${className}`,
    onClick: () => {
      setTapped((pinned) => !pinned)
      setDismissed(false)
    },
  }

  /** Is focus going somewhere still inside this disclosure — the trigger, or the card's teach control? */
  const withinDisclosure = (node: EventTarget | null): boolean =>
    node instanceof Node && wrapperRef.current !== null && wrapperRef.current.contains(node)

  return (
    <span
      ref={wrapperRef}
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
      onFocus={(event) => {
        setFocused(true)
        // Only focus arriving from outside counts as *returning* — see the
        // Escape note above.
        if (!withinDisclosure(event.relatedTarget)) setDismissed(false)
      }}
      onBlur={(event) => {
        // Focus moving from the trigger to the card's teach control is not the
        // keyboard leaving; unmounting the card here would drop focus on the
        // floor between two keystrokes.
        if (withinDisclosure(event.relatedTarget)) return
        setFocused(false)
        setTapped(false)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        // Stopped here rather than left to bubble: a dismissed card must not
        // also close the drawer or panel it is sitting inside.
        event.stopPropagation()
        setDismissed(true)
        setTapped(false)

        const active = document.activeElement
        if (active !== triggerRef.current && withinDisclosure(active)) triggerRef.current?.focus()
      }}
    >
      {trigger === 'button' ? (
        <button
          ref={triggerRef as RefObject<HTMLButtonElement>}
          type="button"
          {...triggerProps}
        >
          {children}
        </button>
      ) : (
        // `role="note"` and not `button`: the mark's own control is the button
        // here, and announcing a second one would be the nested-button defect
        // read aloud. It is focusable so the keyboard reaches the same card the
        // pointer does — charter §6, which is the whole reason this mode exists
        // rather than the eight sites keeping their `title=`.
        <span ref={triggerRef as RefObject<HTMLSpanElement>} role="note" tabIndex={0} {...triggerProps}>
          {children}
        </span>
      )}
      {open ? (
        <span className="absolute left-0 top-full z-(--z-card) pt-1">
          <DisclosureCard disclosure={disclosure} id={cardId} />
        </span>
      ) : null}
    </span>
  )
}
