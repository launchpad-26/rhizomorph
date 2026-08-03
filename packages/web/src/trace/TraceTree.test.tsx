import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { fixtureTraceSpans, initialSessionState, reduceAll } from '@rhizomorph/core'
import { afterEach, describe, expect, it } from 'vitest'
import { TraceTree } from './TraceTree.js'

afterEach(cleanup)

describe('TraceTree', () => {
  it('is the honest gap when the lane has produced no spans at all', () => {
    render(<TraceTree state={initialSessionState()} lane="2-core" />)

    const status = screen.getByRole('status')
    expect(status.textContent).toContain('no trace telemetry from this lane')
    expect(status.textContent).toContain('docs/telemetry.md')
    expect(screen.queryByTestId('trace-tree')).toBeNull()
  })

  it('renders one collapsed block per interaction, newest first, with the root row format', () => {
    const state = reduceAll([
      ...fixtureTraceSpans({ lane: '2-core', traceId: 'trace-old', startTs: 0 }),
      ...fixtureTraceSpans({ lane: '2-core', traceId: 'trace-new', startTs: 1_000_000, idPrefix: 'newer' }),
    ])

    render(<TraceTree state={state} lane="2-core" />)

    const blocks = screen.getAllByTestId('trace-interaction')
    expect(blocks).toHaveLength(2)

    // Newest first in the list; ordinal counts up from the oldest (#1) so the
    // top row (the newest) carries the highest number.
    expect(blocks[0]?.textContent).toContain('interaction #2')
    expect(blocks[1]?.textContent).toContain('interaction #1')

    // wall (14_100ms → 14s) vs Σ (leaves only → 13_600ms → 13s), output-led tokens.
    expect(blocks[0]?.textContent).toContain('14s')
    expect(blocks[0]?.textContent).toContain('Σ13s')
    expect(blocks[0]?.textContent).toContain('3.1K')

    // Collapsed by default — no child rows yet.
    expect(within(blocks[0]!).queryAllByTestId('trace-row')).toHaveLength(0)
  })

  it('shows the four-tier breakdown in the tokens tooltip, never an unlabelled total', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    render(<TraceTree state={state} lane="2-core" />)

    const title = screen.getByTitle(/output 3\.1K/)
    expect(title.textContent).toBe('3.1K')
    expect(title.getAttribute('title')).toBe('output 3.1K · input 4 · cache read 180K · cache write 6.4K')
  })

  it('expands to show every child row, indented, none hidden', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    render(<TraceTree state={state} lane="2-core" />)

    fireEvent.click(screen.getByTestId('trace-interaction-toggle'))

    const rows = screen.getAllByTestId('trace-row')
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual([
      'llm_request',
      'tool',
      'tool_blocked',
      'tool_execution',
    ])
  })

  it('the llm_request row carries model and ttft', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    render(<TraceTree state={state} lane="2-core" />)
    fireEvent.click(screen.getByTestId('trace-interaction-toggle'))

    const llmRow = screen.getAllByTestId('trace-row').find((row) => row.getAttribute('data-kind') === 'llm_request')
    expect(llmRow?.textContent).toContain('claude-opus-5')
    expect(llmRow?.textContent).toContain('ttft')
    expect(llmRow?.textContent).toContain('1s')
  })

  it('the tool_blocked row renders the honest `unknown` decision, worded "waited" — never "waiting"', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    render(<TraceTree state={state} lane="2-core" />)
    fireEvent.click(screen.getByTestId('trace-interaction-toggle'))

    const blockedRow = screen
      .getAllByTestId('trace-row')
      .find((row) => row.getAttribute('data-kind') === 'tool_blocked')

    expect(blockedRow?.textContent).toContain('waited')
    expect(blockedRow?.textContent).not.toMatch(/\bwaiting\b/)
    expect(blockedRow?.querySelector('[data-testid="trace-decision"]')?.getAttribute('data-decision')).toBe(
      'unknown',
    )
    expect(blockedRow?.textContent).toContain('unknown')
  })

  it('replay correctness: a folded state at mid-session renders the partial tree honestly, nothing hidden', () => {
    // Leaves-first export order is `[llm, blocked, execution, toolSpan,
    // interaction]` — the root always exports last, since a span is only
    // exported once it ends (prd9 ruling 6). Folding only the first two
    // simulates a state built mid-session, before the interaction (and the
    // tool span) have closed: both `llm` and `blocked` arrive with a parent
    // that has not exported yet, so each becomes its own orphan root — a
    // partial summary, never a missing one (`traces.ts`'s own doc comment).
    const events = fixtureTraceSpans({ lane: '2-core' }).slice(0, 2)
    const state = reduceAll(events)

    render(<TraceTree state={state} lane="2-core" />)

    const blocks = screen.getAllByTestId('trace-interaction')
    expect(blocks).toHaveLength(2)

    fireEvent.click(within(blocks[0]!).getByTestId('trace-interaction-toggle'))
    fireEvent.click(within(blocks[1]!).getByTestId('trace-interaction-toggle'))

    // Neither orphan has had a chance to grow children yet — an empty child
    // list here is the honest state of a session still in flight, not a bug.
    expect(screen.queryAllByTestId('trace-row')).toHaveLength(0)
  })
})
