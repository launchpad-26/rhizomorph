import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DisclosureCard } from './DisclosureCard.js'
import { DisclosureError, unknownDisclosure, type DisclosureContent } from './vocabulary.js'

afterEach(cleanup)

function known(): DisclosureContent {
  return {
    label: 'WAITING',
    why: { reason: 'no output', evidence: { fact: 'last tool call was a file read', elapsedMs: 6 * 60_000 } },
    remedy: { kind: 'action', action: 'attach and see what it is asking', command: 'workmux attach lane-7' },
  }
}

describe('the card renders the triple, in the one order', () => {
  it('shows label, why and remedy', () => {
    render(<DisclosureCard disclosure={known()} />)

    expect(screen.getByTestId('disclosure-label')).toHaveTextContent('WAITING')
    expect(screen.getByTestId('disclosure-why')).toHaveTextContent(
      'no output — last tool call was a file read 6m00s ago',
    )
    expect(screen.getByTestId('disclosure-remedy')).toHaveTextContent('attach and see what it is asking')
  })

  it('lays them out label first, why second, remedy third — in the DOM, not by convention', () => {
    // Asserted on document order rather than on presence: three strings that
    // are all on screen in an order nobody checked is how "the same condition
    // reads differently on two surfaces" comes back.
    render(<DisclosureCard disclosure={known()} />)
    const card = screen.getByTestId('disclosure-card')

    const order = [...card.querySelectorAll('[data-testid^="disclosure-"]')].map((node) =>
      node.getAttribute('data-testid'),
    )
    expect(order.slice(0, 3)).toEqual(['disclosure-label', 'disclosure-why', 'disclosure-remedy'])
  })

  it('carries the evidence and the elapsed time in the why line itself', () => {
    // The whole posture of prd-30 in one assertion: the why is not an apology,
    // it is a fact with its provenance and its age attached.
    render(<DisclosureCard disclosure={known()} />)
    const why = screen.getByTestId('disclosure-why')

    expect(why).toHaveTextContent('last tool call was a file read')
    expect(why).toHaveTextContent('6m00s ago')
  })

  it('renders the command as its own element, ready for the copy affordance', () => {
    render(<DisclosureCard disclosure={known()} />)

    const command = screen.getByTestId('disclosure-command')
    expect(command).toHaveTextContent('workmux attach lane-7')
    expect(command.tagName).toBe('CODE')
  })

  it('omits the command element when the remedy has no command, and still says the remedy', () => {
    render(
      <DisclosureCard
        disclosure={{ ...known(), remedy: { kind: 'none', because: 'the lane has landed; nothing is running' } }}
      />,
    )

    expect(screen.queryByTestId('disclosure-command')).toBeNull()
    expect(screen.getByTestId('disclosure-remedy')).toHaveTextContent('the lane has landed; nothing is running')
  })

  it('is a tooltip to a screen reader, addressable by id', () => {
    render(<DisclosureCard disclosure={known()} id="card-1" />)

    const card = screen.getByRole('tooltip')
    expect(card).toHaveAttribute('id', 'card-1')
  })
})

describe('the card fails rather than disclosing a bare gap', () => {
  it('throws on a why with no evidence instead of rendering "no data" alone', () => {
    const bare: DisclosureContent = {
      ...known(),
      why: { reason: 'no data', evidence: { fact: '', elapsedMs: 4 * 60_000 } },
    }

    // React will log the boundary-less throw; the assertion is that it throws
    // at all. A card that degraded to a label here would be the exact defect
    // the evidence requirement exists to forbid, in the one place nobody looks.
    expect(() => render(<DisclosureCard disclosure={bare} />)).toThrow(DisclosureError)
    expect(screen.queryByTestId('disclosure-card')).toBeNull()
  })
})

describe('the unknown condition', () => {
  it('renders all three parts, naming what is missing and which rung would prove it', () => {
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

    expect(screen.getByTestId('disclosure-label')).toHaveTextContent('unknown — WAITING')
    expect(screen.getByTestId('disclosure-why')).toHaveTextContent('no declared attention from the lane')
    expect(screen.getByTestId('disclosure-why')).toHaveTextContent('4m00s ago')
    expect(screen.getByTestId('disclosure-remedy')).toHaveTextContent('L2 would prove it')
  })
})
