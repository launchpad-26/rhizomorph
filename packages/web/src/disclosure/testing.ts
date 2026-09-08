import { fireEvent } from '@testing-library/react'

/**
 * TEST-ONLY (#220) — open the card on a mark, PROVE THE TWO SENSES AGREE, and
 * read it back.
 *
 * The adoption sweep retired 50 native `title=` attributes, and with them 19
 * assertions that read `element.title` to prove what a mark says. Those tests
 * were right to check the claim and had no way to check it except the
 * attribute; this is the replacement, in one place rather than re-derived in
 * thirteen test files.
 *
 * **Every call is a focus-parity assertion**, which is how prd-30 S1's
 * acceptance — *"a test asserts focus parity for each adopting surface"* — is
 * met without thirteen near-identical tests. The helper opens the card by
 * mouse, closes it, opens it again by keyboard, and refuses to return unless
 * the two markups are identical. So every existing assertion about what a mark
 * says is also, now, an assertion that a keyboard user is shown exactly what a
 * mouse user is shown, on that surface, with that surface's own data.
 *
 * Parity inside `Disclosure` is structural — one `open` boolean, one
 * `<DisclosureCard>` — and `Disclosure.test.tsx` proves it directly for both
 * trigger modes. What this adds is the other half: that each SURFACE actually
 * adopted the component rather than reimplementing a corner of it, and that
 * its trigger is genuinely reachable by keyboard with real data in it.
 *
 * Not exported from `index.ts`: nothing shipped imports it, so it is not in the
 * bundle, and a component that reached for `fireEvent` would fail review long
 * before it failed a build.
 */
export function discloseText(mark: HTMLElement): string {
  // Up first, then down. Both shapes are legitimate and both are in the tree:
  // a cell whose whole content is the trigger (`<td><Disclosure>…`), and a
  // marked wrapper that holds one (`<span data-testid="burn-errors">
  // <Disclosure>…`). A helper that only walked one way would send the next
  // author looking for a bug in their component.
  const wrapper =
    mark.closest('[data-testid="disclosure"]') ?? mark.querySelector('[data-testid="disclosure"]')
  if (wrapper === null) {
    throw new Error(
      'no disclosure on or under this mark — did the sweep miss it?',
    )
  }

  fireEvent.mouseEnter(wrapper)
  const byMouse = wrapper.querySelector('[data-testid="disclosure-card"]')
  if (byMouse === null) throw new Error('the disclosure opened no card on hover')
  const hovered = byMouse.outerHTML
  const text = byMouse.textContent ?? ''
  fireEvent.mouseLeave(wrapper)

  const trigger = wrapper.querySelector('[data-testid="disclosure-trigger"]')
  if (trigger === null) throw new Error('the disclosure has no trigger to focus')
  fireEvent.focus(trigger)
  const byKeyboard = wrapper.querySelector('[data-testid="disclosure-card"]')
  if (byKeyboard === null) {
    throw new Error(
      'this mark discloses on hover but not on focus — charter §6 is binding: whatever hover discloses, focus discloses',
    )
  }
  if (byKeyboard.outerHTML !== hovered) {
    throw new Error(
      `this mark shows a keyboard user something different from a mouse user (charter §6).\n  hover:\n    ${hovered}\n  focus:\n    ${byKeyboard.outerHTML}`,
    )
  }

  // Left closed: a test that opened three cards and left them open would be
  // asserting against a DOM no reader ever sees.
  fireEvent.blur(trigger)
  return text
}

/** The card on a mark found by test id — the shape most of these call sites want. */
export function discloseTextOf(container: HTMLElement, testId: string): string {
  const mark = container.querySelector(`[data-testid="${testId}"]`)
  if (mark === null) throw new Error(`no element with data-testid="${testId}"`)
  return discloseText(mark as HTMLElement)
}
