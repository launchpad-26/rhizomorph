import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Disclosure } from './Disclosure.js'
import { DisclosureCard } from './DisclosureCard.js'
import { disclosureLines, unknownDisclosure, type DisclosureContent } from './vocabulary.js'

/**
 * THE LAWS THE TEACH AFFORDANCE IS HELD TO (prd-30 ruling 4 and S2 · #561).
 *
 * S2's acceptance is one sentence — *"a test asserts no string in the teach
 * layer exists outside the condition table"* — and the discipline that makes it
 * survive contact is the rest: teaching appears **on demand**, is
 * **dismissible**, and **does not repeat itself at the reader**.
 *
 * #602 is the live example of the failure being guarded against: `/connect`
 * rendering 282 lines of individually-correct honest-gap prose that together
 * bury the page. Every line there passes its own review. Nobody tested the sum.
 * A teach affordance is exactly where that happens again, so the four laws
 * below are each written to fail on the specific commit that would break
 * them — and where the assertion is a comparison, the mutation that should
 * break it is run as a fixture, because a law never shown to fire is
 * decoration.
 */

afterEach(cleanup)

/** A whole disclosure with something further to show. */
function teachable(): DisclosureContent {
  return {
    label: 'WAITING',
    why: {
      reason: 'no output',
      evidence: { fact: 'last tool call was a file read', elapsedMs: 6 * 60_000 },
      derivedFrom: [
        { fact: 'tool call · read', count: 3, elapsedMs: 6 * 60_000 },
        { fact: 'assistant turn ended', elapsedMs: 6 * 60_000 + 1_000 },
        { fact: 'workmux reports the pane idle', elapsedMs: 30_000 },
      ],
    },
    remedy: { kind: 'action', action: 'attach and see what it is asking', command: 'workmux attach lane-7' },
  }
}

/** The same condition with nothing further behind it — the ordinary wave 1 card. */
function bare(): DisclosureContent {
  const content = teachable()
  return { ...content, why: { reason: content.why.reason, evidence: content.why.evidence } }
}

function teachControl(): HTMLElement {
  return screen.getByTestId('disclosure-teach')
}

/** The expanded teach layer's markup, with `useId`'s per-mount counter blanked. */
function derivationMarkup(): string {
  return screen.getByTestId('disclosure-derivation').outerHTML.replace(/id="[^"]*"/, 'id="«useId»"')
}

describe('law 1 — teaching appears on demand, and never before', () => {
  it('renders the card collapsed: the derivation is absent from the DOM, not merely hidden', () => {
    // Absent rather than `hidden`, and that distinction is the law. A screen
    // reader announcing three derivation lines nobody asked for, an in-page
    // find landing inside a collapsed teach layer, or a `display:none` block a
    // later stylesheet reveals — all three are teaching at the reader, and all
    // three pass a test that only checks visibility.
    render(<DisclosureCard disclosure={teachable()} />)

    expect(screen.queryByTestId('disclosure-derivation')).toBeNull()
    expect(screen.queryAllByTestId('disclosure-derivation-line')).toHaveLength(0)
    expect(screen.getByTestId('disclosure-card').textContent).not.toContain('workmux reports the pane idle')
  })

  it('shows the derivation once the control is used, in the selector’s own order', () => {
    render(<DisclosureCard disclosure={teachable()} />)

    fireEvent.click(teachControl())

    expect(screen.queryAllByTestId('disclosure-derivation-line').map((node) => node.textContent)).toEqual([
      'tool call · read ×3 — 6m00s ago',
      'assistant turn ended — 6m01s ago',
      'workmux reports the pane idle — 30s ago',
    ])
  })

  it('offers no control at all when there is nothing further to show', () => {
    // The anti-noise arm. A control that expands to an empty list is a mark
    // explaining itself constantly with nothing to say — the #602 shape at
    // affordance scale.
    render(<DisclosureCard disclosure={bare()} />)

    expect(screen.queryByTestId('disclosure-teach')).toBeNull()
  })
})

/**
 * The law of law 2, as a pure function so it can be shown to fire: everything
 * expanding added to the card, with the condition table's own lines struck out.
 * Anything left is a string the teach layer wrote itself.
 */
export function foreignText(collapsed: string, expanded: string, derivation: readonly string[]): string {
  const added = expanded.startsWith(collapsed) ? expanded.slice(collapsed.length) : expanded
  return derivation.reduce((rest, line) => rest.replace(line, ''), added)
}

describe('law 2 — the teach layer has no voice of its own', () => {
  it('adds exactly the condition table’s derivation lines to the card, and not one word more', () => {
    // S2's acceptance in its strongest available form: not "the derivation
    // appears" but "expanding adds *only* the derivation". Generated prose, a
    // beginner-register gloss, a "what this means for you" sentence — each of
    // them lands in this diff and fails here.
    //
    // The control's own text is deliberately invariant (`evidence`, with a
    // caret that rotates rather than changing character), so it cancels out of
    // both sides and cannot be where a second voice hides.
    render(<DisclosureCard disclosure={teachable()} />)
    const card = screen.getByTestId('disclosure-card')
    const collapsed = card.textContent ?? ''

    fireEvent.click(teachControl())

    expect(foreignText(collapsed, card.textContent ?? '', disclosureLines(teachable()).derivation)).toBe('')
  })

  it('would name the sentence a teach layer wrote for itself', () => {
    // The mutation, run rather than argued. Without this, the assertion above
    // is "a function nobody has seen return anything returned nothing".
    expect(
      foreignText(
        'WAITING▸evidence',
        'WAITING▸evidenceIn plain terms: your lane is stuck.tool call · read ×3 — 6m00s ago',
        ['tool call · read ×3 — 6m00s ago'],
      ),
    ).toBe('In plain terms: your lane is stuck.')
  })

  it('teaches the unknown condition with the same layer, at the same length', () => {
    // S2's *unknown* state. The honest gap gets no warmer and no longer a teach
    // layer than a known condition — it gets the same one, over the facts the
    // instrument does hold.
    render(
      <DisclosureCard
        disclosure={unknownDisclosure({
          mark: 'WAITING',
          missing: 'no declared attention from the lane',
          elapsedMs: 4 * 60_000,
          at: 'L1',
          derivedFrom: [{ fact: 'hook beacon last seen', elapsedMs: 4 * 60_000 }],
        })}
      />,
    )

    expect(screen.queryByTestId('disclosure-derivation')).toBeNull()
    fireEvent.click(teachControl())
    expect(screen.getByTestId('disclosure-derivation')).toHaveTextContent('hook beacon last seen — 4m00s ago')
  })

  it('offers the unknown card no control either, when nothing is folded behind it', () => {
    render(
      <DisclosureCard
        disclosure={unknownDisclosure({
          mark: 'WAITING',
          missing: 'no declared attention from the lane',
          elapsedMs: 4 * 60_000,
          at: 'L1',
        })}
      />,
    )

    expect(screen.queryByTestId('disclosure-teach')).toBeNull()
  })
})

describe('law 3 — teaching is dismissible', () => {
  it('closes on the same control that opened it', () => {
    render(<DisclosureCard disclosure={teachable()} />)

    fireEvent.click(teachControl())
    expect(screen.getByTestId('disclosure-derivation')).toBeInTheDocument()

    fireEvent.click(teachControl())
    expect(screen.queryByTestId('disclosure-derivation')).toBeNull()
  })

  it('says which state it is in, to a screen reader and to a stylesheet', () => {
    render(<DisclosureCard disclosure={teachable()} />)
    const control = teachControl()

    expect(control).toHaveAttribute('aria-expanded', 'false')
    expect(control).not.toHaveAttribute('aria-controls')

    fireEvent.click(control)

    expect(control).toHaveAttribute('aria-expanded', 'true')
    expect(control.getAttribute('aria-controls')).toBe(screen.getByTestId('disclosure-derivation').id)
  })

  it('closes with the card when Escape dismisses the whole disclosure', () => {
    const { wrapper, trigger } = mountAffordance()
    fireEvent.focus(trigger)
    fireEvent.click(teachControl())

    fireEvent.keyDown(wrapper, { key: 'Escape' })

    expect(screen.queryByTestId('disclosure-card')).toBeNull()
    expect(screen.queryByTestId('disclosure-derivation')).toBeNull()
  })
})

describe('law 4 — teaching is never repeated at the reader unbidden', () => {
  it('comes back collapsed the next time the mark is read', () => {
    // "If a mark's meaning is needed forty times, that is one affordance used
    // forty times, not forty affordances." A card that reopened expanded would
    // be teaching on thirty-nine hovers nobody asked about: the reader asked
    // once, about one reading.
    const { wrapper } = mountAffordance()

    fireEvent.mouseEnter(wrapper)
    fireEvent.click(teachControl())
    expect(screen.getByTestId('disclosure-derivation')).toBeInTheDocument()

    fireEvent.mouseLeave(wrapper)
    expect(screen.queryByTestId('disclosure-card')).toBeNull()

    fireEvent.mouseEnter(wrapper)
    expect(screen.getByTestId('disclosure-card')).toBeInTheDocument()
    expect(screen.queryByTestId('disclosure-derivation')).toBeNull()
    expect(teachControl()).toHaveAttribute('aria-expanded', 'false')
  })

  it('does not remember per condition — expanding one mark leaves its twin alone', () => {
    // S2's "not remembered per condition by default", asserted where it could
    // actually go wrong: a module-level `Set` of expanded labels, or a hook
    // keyed on the condition, passes every test above and fails this one.
    render(
      <>
        <DisclosureCard disclosure={teachable()} id="first" />
        <DisclosureCard disclosure={teachable()} id="second" />
      </>,
    )

    const [first, second] = screen.getAllByTestId('disclosure-teach')
    if (first === undefined || second === undefined) throw new Error('both cards should carry a control')

    fireEvent.click(first)

    expect(screen.getAllByTestId('disclosure-derivation')).toHaveLength(1)
    expect(second).toHaveAttribute('aria-expanded', 'false')
  })

  it('has nowhere to keep the memory: the card that held it is gone', () => {
    // The structural half of the same law. `expanded` is the card's own state
    // and the card unmounts when the disclosure closes, so "not remembered" is
    // not a policy anyone has to maintain. This asserts the card really does
    // unmount rather than being hidden — if it stopped, the law above would be
    // resting on nothing.
    const { wrapper } = mountAffordance()
    expect(screen.getByTestId('disclosure-card')).toBeInTheDocument()

    fireEvent.mouseLeave(wrapper)

    expect(wrapper.querySelector('[data-disclosure-card]')).toBeNull()
  })
})

describe('the control is reachable by keyboard, exactly as by pointer', () => {
  it('is a real button in the tab order, wearing the one focus token', () => {
    render(<DisclosureCard disclosure={teachable()} />)
    const control = teachControl()

    expect(control.tagName).toBe('BUTTON')
    expect(control).toHaveAttribute('type', 'button')
    expect(control).not.toHaveAttribute('tabindex')
    expect(control.className.split(/\s+/)).toContain('focus-ring')
  })

  it('teaches the same thing to the keyboard as to the pointer, byte for byte', () => {
    // The charter §6 claim, extended to the depth #561 adds: whatever hover
    // discloses, focus discloses — including whatever the teach control
    // discloses. One mount, both senses, so the comparison is of two
    // disclosures rather than two `useId` counters.
    //
    // The generated `id` is normalised out and only that: `useId` hands a
    // fresh counter to each mount, and the card is genuinely remounted between
    // the two senses (that remount is law 4's own guarantee). Everything a
    // reader can perceive — the lines, their order, the classes, the
    // structure — is compared literally.
    const { wrapper, trigger } = mountAffordance()

    fireEvent.click(teachControl())
    const byPointer = derivationMarkup()
    fireEvent.mouseLeave(wrapper)
    expect(screen.queryByTestId('disclosure-card')).toBeNull()

    fireEvent.focus(trigger)
    fireEvent.click(teachControl())
    const byKeyboard = derivationMarkup()

    expect(byKeyboard).toBe(byPointer)
    expect(byKeyboard).toContain('workmux reports the pane idle — 30s ago')
  })

  it('keeps the card open while focus moves from the mark into the control', () => {
    // The regression a naive `onBlur` would have shipped: focus leaving the
    // trigger for the control reads as "the keyboard left", which unmounts the
    // card out from under the element receiving focus. A keyboard user could
    // never reach the affordance at all.
    render(<Disclosure disclosure={teachable()}>WAITING</Disclosure>)
    const trigger = screen.getByTestId('disclosure-trigger')
    fireEvent.focus(trigger)

    const control = teachControl()
    fireEvent.blur(trigger, { relatedTarget: control })
    fireEvent.focus(control, { relatedTarget: trigger })

    expect(screen.getByTestId('disclosure-card')).toBeInTheDocument()
    fireEvent.click(control)
    expect(screen.getByTestId('disclosure-derivation')).toBeInTheDocument()
  })

  it('closes once focus leaves the disclosure altogether', () => {
    render(<Disclosure disclosure={teachable()}>WAITING</Disclosure>)
    const trigger = screen.getByTestId('disclosure-trigger')
    fireEvent.focus(trigger)
    const control = teachControl()
    fireEvent.blur(trigger, { relatedTarget: control })

    fireEvent.blur(control, { relatedTarget: document.body })

    expect(screen.queryByTestId('disclosure-card')).toBeNull()
  })

  it('hands focus back to the mark when Escape closes a card focus was inside', () => {
    // Without this the reader's place in the tab order becomes `<body>` — the
    // card holding their focus has just unmounted. Driven with real `.focus()`
    // rather than synthetic events, because `document.activeElement` is the
    // thing under test.
    render(<Disclosure disclosure={teachable()}>WAITING</Disclosure>)
    const wrapper = screen.getByTestId('disclosure')
    const trigger = screen.getByTestId('disclosure-trigger')

    act(() => {
      trigger.focus()
    })
    const control = teachControl()
    act(() => {
      control.focus()
    })
    expect(document.activeElement).toBe(control)

    fireEvent.keyDown(wrapper, { key: 'Escape' })

    expect(document.activeElement).toBe(trigger)
    expect(screen.queryByTestId('disclosure-card')).toBeNull()
  })

  it('stays dismissed after that hand-back — Escape means Escape', () => {
    // The sibling case, and the one that bites: refocusing the trigger fires a
    // focus event, and a handler that cleared `dismissed` on every focus would
    // reopen the card in the same tick the reader closed it. Focus arriving
    // from *inside* the disclosure is not the reader returning.
    render(<Disclosure disclosure={teachable()}>WAITING</Disclosure>)
    const wrapper = screen.getByTestId('disclosure')
    const trigger = screen.getByTestId('disclosure-trigger')

    act(() => {
      trigger.focus()
    })
    act(() => {
      teachControl().focus()
    })

    fireEvent.keyDown(wrapper, { key: 'Escape' })

    expect(screen.queryByTestId('disclosure-card')).toBeNull()
    expect(trigger).toHaveAttribute('data-open', 'false')
  })
})

/** The affordance, open by hover — the state in which the card's control exists at all. */
function mountAffordance(): { wrapper: HTMLElement; trigger: HTMLElement } {
  render(<Disclosure disclosure={teachable()}>WAITING</Disclosure>)
  const wrapper = screen.getByTestId('disclosure')
  fireEvent.mouseEnter(wrapper)
  return { wrapper, trigger: screen.getByTestId('disclosure-trigger') }
}
