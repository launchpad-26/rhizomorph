import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { InteractionCard } from './InteractionCard.js'
import type { InteractionCardModel, InteractionCost } from './model.js'

afterEach(cleanup)

const SAID =
  "I'll add the plan/run split first, then wire the route. After that the index needs a test that deletes a worktree."

function model(overrides: Partial<InteractionCardModel> = {}): InteractionCardModel {
  const now = Date.UTC(2026, 7, 16, 19, 10, 0)
  return {
    traceId: 'trace-1',
    spanId: 'span-1',
    lane: '556-run-view',
    startTs: Date.UTC(2026, 7, 16, 19, 4, 12),
    endTs: Date.UTC(2026, 7, 16, 19, 7, 24),
    inFlight: false,
    wallMs: 192_000,
    workMs: 47_000,
    gapMs: 145_000,
    gapDisclosure: {
      label: 'the gap',
      why: {
        reason: 'wall-clock time exceeds summed work',
        evidence: { fact: '3 leaf spans summed, last span', elapsedMs: 60_000 },
      },
      remedy: { kind: 'none', because: 'the gap is a measurement, not a fault' },
    },
    quote: { headline: "I'll add the plan/run split first, then wire the route.", full: SAID, hasMore: true },
    facts: {
      model: 'claude-opus-5',
      tokens: { input: 4, output: 41_200, cacheRead: 180_000, cacheCreation: 6_400 },
      toolCount: 9,
      files: ['a.ts', 'b.ts'],
      cost: { kind: 'estimated', usd: 0.31, sources: ['langfuse-prices@cfac485'] },
    },
    phase: {
      phase: 'implementing',
      inferred: true,
      disclosure: {
        label: 'implementing — inferred',
        why: {
          reason: 'this phase is derived from what ran, not declared by the agent',
          evidence: { fact: 'Edit, Write were called', elapsedMs: now - Date.UTC(2026, 7, 16, 19, 7, 24) },
        },
        remedy: { kind: 'none', because: 'nothing to correct' },
      },
    },
    subagents: [],
    refusals: [],
    ...overrides,
  }
}

/** UTC, so the card's clock reads identically on every machine that runs this. */
function renderCard(overrides: Partial<InteractionCardModel> = {}) {
  return render(<InteractionCard model={model(overrides)} timeZone="UTC" />)
}

describe('the time shape leads', () => {
  it('shows wall beside work — the gap between them is the headline', () => {
    renderCard()
    expect(screen.getByTestId('interaction-wall').textContent).toContain('3:12')
    expect(screen.getByTestId('interaction-work').textContent).toContain('0:47')
    expect(screen.getByTestId('interaction-clock').textContent).toBe('19:04:12')
  })

  it('shows NO total for an interaction still in flight', () => {
    renderCard({ inFlight: true })
    expect(screen.queryByTestId('interaction-wall')).toBeNull()
    expect(screen.queryByTestId('interaction-work')).toBeNull()
    expect(screen.getByTestId('interaction-in-flight').textContent).toContain('has not ended')
  })

  it('explains the gap through the ONE disclosure card, not prose of its own', () => {
    renderCard()
    const trigger = screen.getByTestId('interaction-why-gap')
    fireEvent.mouseEnter(trigger.closest('[data-testid="disclosure"]') as HTMLElement)
    expect(screen.getByTestId('disclosure-card')).toBeTruthy()
    expect(screen.getByTestId('disclosure-why').textContent).toContain('3 leaf spans summed')
  })
})

describe('the words are the agent’s, marked as a quotation', () => {
  it('renders the opening sentence verbatim inside a blockquote', () => {
    renderCard()
    const quote = screen.getByTestId('interaction-quote')
    expect(quote.tagName).toBe('BLOCKQUOTE')
    expect(quote.textContent).toContain("I'll add the plan/run split first, then wire the route.")
  })

  it('expands to the whole block in place, still verbatim', () => {
    renderCard()
    fireEvent.click(screen.getByTestId('interaction-full-text'))
    expect(screen.getByTestId('interaction-quote').textContent).toContain(SAID)
  })

  it('renders NO quote element for a pure tool turn — absent, not blank', () => {
    renderCard({ quote: null })
    expect(screen.queryByTestId('interaction-quote')).toBeNull()
    // And no dangling affordance for text that is not there.
    expect(screen.queryByTestId('interaction-full-text')).toBeNull()
    // The facts still carry the reading (S1's *no text* state).
    expect(screen.getByTestId('interaction-facts')).toBeTruthy()
  })

  it('offers no `full text` when the whole block was one sentence', () => {
    renderCard({ quote: { headline: 'Done.', full: 'Done.', hasMore: false } })
    expect(screen.queryByTestId('interaction-full-text')).toBeNull()
  })
})

describe('the facts strip shows only what it can source', () => {
  it('flags an estimated dollar BESIDE the figure, never behind a hover', () => {
    renderCard()
    const cost = screen.getByTestId('interaction-fact-cost')
    expect(cost.getAttribute('data-cost-provenance')).toBe('estimated')
    expect(cost.textContent).toContain('$0.31')
    expect(cost.textContent).toContain('est.')
  })

  it('does not flag the CLI’s own figure', () => {
    renderCard({ facts: { ...model().facts, cost: { kind: 'authoritative', usd: 0.31 } } })
    const cost = screen.getByTestId('interaction-fact-cost')
    expect(cost.getAttribute('data-cost-provenance')).toBe('authoritative')
    expect(cost.textContent).not.toContain('est.')
  })

  it('renders an unavailable cost as the honest gap, never `$0.00`', () => {
    const gap: InteractionCost = {
      kind: 'gap',
      disclosure: {
        label: 'cost',
        why: {
          reason: 'no dollars can be attributed to this interaction',
          evidence: { fact: 'no cost record names this request id, last span', elapsedMs: 1_000 },
        },
        remedy: { kind: 'none', because: 'the figure is missing, not zero' },
      },
    }
    renderCard({ facts: { ...model().facts, cost: gap } })
    const cost = screen.getByTestId('interaction-fact-cost')
    expect(cost.getAttribute('data-cost-provenance')).toBe('gap')
    expect(cost.textContent).not.toContain('$0.00')
    expect(screen.getByTestId('interaction-cost-gap')).toBeTruthy()
  })

  it('omits the model field entirely when no span named one', () => {
    renderCard({ facts: { ...model().facts, model: null } })
    expect(screen.queryByTestId('interaction-fact-model')).toBeNull()
    // No placeholder, no dash: an omitted field is honest, a blank one implies
    // we looked (S1, D6).
    expect(screen.getByTestId('interaction-facts').textContent).not.toContain('—')
  })

  it('leads tokens with output, per prd2’s standing ruling', () => {
    renderCard()
    expect(screen.getByTestId('interaction-fact-tokens').textContent).toContain('41.2K')
  })
})

describe('refusals and subagents', () => {
  it('renders a rejected tool call’s own mark', () => {
    renderCard({
      refusals: [{ spanId: 'blocked-1', toolName: 'Bash', decision: 'reject', waitMs: 42_000 }],
    })
    const refusal = screen.getByTestId('interaction-refusal')
    expect(refusal.getAttribute('data-decision')).toBe('reject')
    expect(refusal.textContent).toContain('Bash')
    expect(refusal.textContent).toContain('0:42')
  })

  it('renders nothing at all when nothing was refused — never an empty list', () => {
    renderCard()
    expect(screen.queryByTestId('interaction-refusals')).toBeNull()
  })

  it('nests subagents, collapsed by default, expanding to their own reading', () => {
    renderCard({
      subagents: [
        {
          agentId: 'agent-1',
          subagentType: 'Explore',
          spanCount: 4,
          durationMs: 61_000,
          tokens: { input: 1, output: 2_400, cacheRead: 0, cacheCreation: 0 },
        },
      ],
    })
    expect(screen.queryByTestId('interaction-subagents')).toBeNull()
    fireEvent.click(screen.getByTestId('interaction-subagents-toggle'))
    const line = screen.getByTestId('interaction-subagent')
    expect(line.textContent).toContain('Explore')
    expect(line.textContent).toContain('1:01')
  })
})

describe('phase wears its inference', () => {
  it('never shows the word without saying it was derived', () => {
    renderCard()
    expect(screen.getByTestId('interaction-phase').textContent).toContain('implementing')
    expect(screen.getByTestId('interaction-phase').textContent).toContain('inferred')
  })

  it('discloses the evidence behind it', () => {
    renderCard()
    const phase = screen.getByTestId('interaction-phase')
    fireEvent.mouseEnter(phase.querySelector('[data-testid="disclosure"]') as HTMLElement)
    expect(screen.getByTestId('disclosure-why').textContent).toContain('Edit, Write were called')
  })
})
