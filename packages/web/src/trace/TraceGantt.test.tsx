import { cleanup, render, screen } from '@testing-library/react'
import { fixtureTraceSpans, initialSessionState, reduceAll } from '@rhizomorph/core'
import { afterEach, describe, expect, it } from 'vitest'
import { TraceGantt } from './TraceGantt.js'

afterEach(cleanup)

describe('TraceGantt', () => {
  it('is the honest gap when the lane has produced no spans at all', () => {
    render(<TraceGantt state={initialSessionState()} lane="2-core" />)

    expect(screen.getByRole('status').textContent).toContain('no trace telemetry from this lane')
    expect(screen.queryByTestId('trace-gantt')).toBeNull()
  })

  it('scrolls horizontally inside its own container', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    render(<TraceGantt state={state} lane="2-core" />)

    expect(screen.getByTestId('trace-gantt').className).toContain('overflow-x-auto')
  })

  it('renders the root and every descendant as a positioned, scaled bar — same rows/glyphs/badges as the tree', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    render(<TraceGantt state={state} lane="2-core" />)

    const rows = screen.getAllByTestId('trace-gantt-row')
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual([
      'interaction',
      'llm_request',
      'tool',
      'tool_blocked',
      'tool_execution',
    ])

    for (const row of rows) {
      const bar = row.querySelector('.bg-ice-700') as HTMLElement | null
      expect(bar).not.toBeNull()
      expect(bar?.style.width).not.toBe('')
    }

    const blockedRow = rows.find((row) => row.getAttribute('data-kind') === 'tool_blocked')
    expect(blockedRow?.textContent).toContain('waited')
    expect(blockedRow?.textContent).toContain('unknown')
    expect(blockedRow?.textContent).not.toMatch(/\bwaiting\b/)
  })

  it('renders only the newest interaction — the tree is where history is paged', () => {
    const state = reduceAll([
      ...fixtureTraceSpans({ lane: '2-core', traceId: 'trace-old', startTs: 0 }),
      ...fixtureTraceSpans({ lane: '2-core', traceId: 'trace-new', startTs: 1_000_000, idPrefix: 'newer' }),
    ])

    render(<TraceGantt state={state} lane="2-core" />)

    const rows = screen.getAllByTestId('trace-gantt-row')
    expect(rows).toHaveLength(5)
    expect(rows[0]?.querySelector('[data-testid="trace-duration"], [data-testid="trace-decision"]')).toBeTruthy()
  })

  it('is static rendering — no motion classes on the bars', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    render(<TraceGantt state={state} lane="2-core" />)

    for (const row of screen.getAllByTestId('trace-gantt-row')) {
      expect(row.innerHTML).not.toMatch(/animate-|transition-/)
    }
  })
})
