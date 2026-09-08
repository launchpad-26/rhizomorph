import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Disclosure } from './Disclosure.js'
import type { DisclosureContent } from './vocabulary.js'

afterEach(cleanup)

const CONTENT: DisclosureContent = {
  label: 'WAITING',
  why: { reason: 'no output', evidence: { fact: 'last tool call was a file read', elapsedMs: 6 * 60_000 } },
  remedy: { kind: 'action', action: 'attach and see what it is asking', command: 'workmux attach lane-7' },
}

function mount(trigger?: 'button' | 'inline') {
  const view = render(
    <Disclosure disclosure={CONTENT} trigger={trigger}>
      WAITING
    </Disclosure>,
  )
  return {
    view,
    wrapper: screen.getByTestId('disclosure'),
    trigger: screen.getByTestId('disclosure-trigger'),
  }
}

describe('hover and focus disclose the same thing (charter §6, binding)', () => {
  it('opens on hover', () => {
    const { wrapper } = mount()
    expect(screen.queryByTestId('disclosure-card')).toBeNull()

    fireEvent.mouseEnter(wrapper)
    expect(screen.getByTestId('disclosure-card')).toHaveTextContent('no output')
  })

  it('opens on focus', () => {
    const { trigger } = mount()

    fireEvent.focus(trigger)
    expect(screen.getByTestId('disclosure-card')).toHaveTextContent('no output')
  })

  it('discloses byte-for-byte the same card either way', () => {
    // The strongest form of the parity claim: not "both show something", but
    // the two markups are identical. A second render path added later for the
    // keyboard — the historical way keyboard users get shown less — fails here
    // even if it renders the same three strings in a different wrapper.
    //
    // One mount, both senses, so the comparison is of the two disclosures and
    // not of two `useId` counters.
    const { wrapper, trigger } = mount()

    fireEvent.mouseEnter(wrapper)
    const byMouse = screen.getByTestId('disclosure-card').outerHTML
    fireEvent.mouseLeave(wrapper)
    expect(screen.queryByTestId('disclosure-card')).toBeNull()

    fireEvent.focus(trigger)
    const byKeyboard = screen.getByTestId('disclosure-card').outerHTML

    expect(byKeyboard).toBe(byMouse)
    expect(byKeyboard).toContain('last tool call was a file read 6m00s ago')
  })

  it('names the card as the trigger’s description while it is open, by either sense', () => {
    const { wrapper, trigger } = mount()
    expect(trigger).not.toHaveAttribute('aria-describedby')

    fireEvent.focus(trigger)
    const byKeyboard = trigger.getAttribute('aria-describedby')
    expect(byKeyboard).toBe(screen.getByTestId('disclosure-card').id)

    fireEvent.blur(trigger)
    fireEvent.mouseEnter(wrapper)
    expect(trigger.getAttribute('aria-describedby')).toBe(byKeyboard)
  })
})

describe('the keyboard path', () => {
  it('puts the trigger in the tab order as a real button', () => {
    const { trigger } = mount()

    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger).toHaveAttribute('type', 'button')
    expect(trigger).not.toHaveAttribute('tabindex')
  })

  it('wears the one focus token and paints no focus of its own', () => {
    // prd-32 ruling 9 (#548) had just deleted three hand-rolled focus idioms;
    // `one-card-law.test.ts` holds the whole directory to the token, this holds
    // the trigger a caller actually tabs to.
    const { trigger } = mount()

    expect(trigger.className.split(/\s+/)).toContain('focus-ring')
    expect(trigger.className).not.toMatch(/ring-|outline-|focus-visible:/)
  })

  it('keeps the caller’s classes beside the token rather than instead of it', () => {
    render(
      <Disclosure disclosure={CONTENT} className="figures px-1">
        WAITING
      </Disclosure>,
    )

    const trigger = screen.getByTestId('disclosure-trigger')
    expect(trigger.className.split(/\s+/)).toEqual(expect.arrayContaining(['focus-ring', 'figures', 'px-1']))
  })

  it('closes on Escape, and stays closed while the trigger is still focused', () => {
    // The point of the separate `dismissed` flag: a reader who has read the
    // card and pressed Escape wants the mark back, not the card redrawn
    // because their keyboard never left it.
    const { wrapper, trigger } = mount()
    fireEvent.focus(trigger)
    expect(screen.getByTestId('disclosure-card')).toBeInTheDocument()

    fireEvent.keyDown(wrapper, { key: 'Escape' })
    expect(screen.queryByTestId('disclosure-card')).toBeNull()
    expect(trigger).toHaveAttribute('data-open', 'false')
  })

  it('re-opens after Escape once focus leaves and returns', () => {
    const { wrapper, trigger } = mount()
    fireEvent.focus(trigger)
    fireEvent.keyDown(wrapper, { key: 'Escape' })

    fireEvent.blur(trigger)
    fireEvent.focus(trigger)
    expect(screen.getByTestId('disclosure-card')).toBeInTheDocument()
  })

  it('ignores other keys — Escape is the close, not any keypress', () => {
    const { wrapper, trigger } = mount()
    fireEvent.focus(trigger)

    fireEvent.keyDown(wrapper, { key: 'a' })
    expect(screen.getByTestId('disclosure-card')).toBeInTheDocument()
  })
})

describe('the pointer and touch paths close the way they opened', () => {
  it('closes when the pointer leaves', () => {
    const { wrapper } = mount()
    fireEvent.mouseEnter(wrapper)

    fireEvent.mouseLeave(wrapper)
    expect(screen.queryByTestId('disclosure-card')).toBeNull()
  })

  it('closes when focus leaves', () => {
    const { trigger } = mount()
    fireEvent.focus(trigger)

    fireEvent.blur(trigger)
    expect(screen.queryByTestId('disclosure-card')).toBeNull()
  })

  it('stays open when the pointer leaves but focus has not', () => {
    // Two senses, one card: whichever is still asking gets to keep it open.
    const { wrapper, trigger } = mount()
    fireEvent.mouseEnter(wrapper)
    fireEvent.focus(trigger)

    fireEvent.mouseLeave(wrapper)
    expect(screen.getByTestId('disclosure-card')).toBeInTheDocument()
  })

  it('opens on a tap, with no hover and no focus event at all', () => {
    // The touch path: a device with no hover still gets the explanation.
    const { trigger } = mount()

    fireEvent.click(trigger)
    expect(screen.getByTestId('disclosure-card')).toHaveTextContent('no output')
  })

  it('closes on a second tap', () => {
    const { trigger } = mount()
    fireEvent.click(trigger)

    fireEvent.click(trigger)
    expect(screen.queryByTestId('disclosure-card')).toBeNull()
  })
})

describe('the mark keeps its own voice', () => {
  it('renders whatever it wraps, and takes an accessible name when the mark is a glyph', () => {
    render(
      <Disclosure disclosure={CONTENT} triggerLabel="waiting">
        <span aria-hidden="true">◇</span>
      </Disclosure>,
    )

    const trigger = screen.getByRole('button', { name: 'waiting' })
    expect(trigger).toHaveTextContent('◇')
  })
})

/**
 * THE MODE IS AN ELEMENT AND NOTHING ELSE (ADR-0040, #220).
 *
 * `trigger="inline"` exists because a third of the marks #220 converted are
 * already controls, and a button around a button is invalid markup with two
 * click handlers racing for one tap. The risk it introduces is the one every
 * mode introduces: two paths that drift, with the keyboard path the one that
 * quietly gets less. These are what stop that.
 */
describe('the inline trigger discloses everything the button trigger does', () => {
  it('renders no button of its own, so a control it wraps stays the only one', () => {
    const { trigger } = mount('inline')

    expect(trigger.tagName).toBe('SPAN')
    expect(trigger.getAttribute('role')).toBe('note')
    // Focusable, or the keyboard cannot reach the card at all — which is the
    // entire defect this mode was introduced to avoid re-creating.
    expect(trigger.getAttribute('tabindex')).toBe('0')
  })

  it('still wears the one focus token, never a hue of its own (prd-32 ruling 9)', () => {
    const { trigger } = mount('inline')
    expect(trigger.className).toContain('focus-ring')
  })

  it('discloses byte-for-byte the same card by mouse and by keyboard', () => {
    const { wrapper, trigger } = mount('inline')

    fireEvent.mouseEnter(wrapper)
    const byMouse = screen.getByTestId('disclosure-card').outerHTML
    fireEvent.mouseLeave(wrapper)
    expect(screen.queryByTestId('disclosure-card')).toBeNull()

    fireEvent.focus(trigger)
    const byKeyboard = screen.getByTestId('disclosure-card').outerHTML

    expect(byKeyboard).toBe(byMouse)
    expect(byKeyboard).toContain('last tool call was a file read 6m00s ago')
  })

  it('shows the same card the button trigger shows — the mode changes the element, not the disclosure', () => {
    // Two mounts, so `useId` differs; the ids are normalised out and everything
    // else must match. A mode that rendered a poorer card for the inline case —
    // no remedy, no evidence — passes every assertion above and fails this one.
    const asButton = mount('button')
    fireEvent.mouseEnter(asButton.wrapper)
    const buttonCard = screen.getByTestId('disclosure-card').textContent
    cleanup()

    const asInline = mount('inline')
    fireEvent.mouseEnter(asInline.wrapper)
    const inlineCard = screen.getByTestId('disclosure-card').textContent

    expect(inlineCard).toBe(buttonCard)
  })

  it('closes on Escape and hands focus back, exactly as the button trigger does', () => {
    const { wrapper, trigger } = mount('inline')

    fireEvent.focus(trigger)
    expect(screen.getByTestId('disclosure-card')).toBeInTheDocument()

    fireEvent.keyDown(wrapper, { key: 'Escape' })
    expect(screen.queryByTestId('disclosure-card')).toBeNull()
  })

  it('opens, closes and re-opens identically three times over', () => {
    // The idempotence case the plan asked for: a card that accumulated state
    // across openings — a second card left mounted, a stale `dismissed` — shows
    // up here and nowhere else.
    const { wrapper } = mount('inline')
    const seen: string[] = []

    for (let round = 0; round < 3; round += 1) {
      fireEvent.mouseEnter(wrapper)
      expect(screen.getAllByTestId('disclosure-card')).toHaveLength(1)
      seen.push(screen.getByTestId('disclosure-card').outerHTML)
      fireEvent.mouseLeave(wrapper)
      expect(screen.queryByTestId('disclosure-card')).toBeNull()
    }

    expect(seen[1]).toBe(seen[0])
    expect(seen[2]).toBe(seen[0])
  })
})
