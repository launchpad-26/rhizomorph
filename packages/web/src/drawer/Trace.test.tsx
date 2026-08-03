import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fixtureTraceSpans, reduceAll } from '@rhizomorph/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TraceSection } from './Trace.js'

const requestPanelFocus = vi.fn()
vi.mock('../app/panelPrefs.js', () => ({ requestPanelFocus: (id: string) => requestPanelFocus(id) }))

afterEach(cleanup)

describe('TraceSection (the drawer\'s TRACE section)', () => {
  it('renders the lane\'s compact tree, below the conversation', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    render(<TraceSection state={state} lane="2-core" />)

    expect(screen.getByTestId('drawer-trace')).toBeInTheDocument()
    expect(screen.getByTestId('trace-tree')).toBeInTheDocument()
  })

  it('its FOCUS ↗ affordance requests the same panel-focus mechanism every other focus uses', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    render(<TraceSection state={state} lane="2-core" />)

    fireEvent.click(screen.getByTestId('trace-focus'))

    expect(requestPanelFocus).toHaveBeenCalledWith('trace')
  })
})
