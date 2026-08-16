import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WindowFloor, WINDOW_MIN_HEIGHT, WINDOW_MIN_WIDTH } from './WindowFloor.js'

afterEach(cleanup)

function resize(width: number, height: number): void {
  window.innerWidth = width
  window.innerHeight = height
  fireEvent(window, new Event('resize'))
}

describe('WindowFloor (S5, prd-32 ruling 10)', () => {
  it('renders its children at the primary size (>=1440x900)', () => {
    render(
      <WindowFloor>
        <div>the instrument</div>
      </WindowFloor>,
    )

    expect(screen.getByText('the instrument')).toBeInTheDocument()
    expect(screen.queryByTestId('window-floor')).toBeNull()
  })

  it('renders its children exactly at the floor (1100x700) — the floor itself still works', () => {
    act(() => resize(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT))
    render(
      <WindowFloor>
        <div>the instrument</div>
      </WindowFloor>,
    )

    expect(screen.getByText('the instrument')).toBeInTheDocument()
    expect(screen.queryByTestId('window-floor')).toBeNull()
  })

  it('replaces the whole frame with the one honest panel below the width floor', () => {
    act(() => resize(WINDOW_MIN_WIDTH - 1, 900))
    render(
      <WindowFloor>
        <div>the instrument</div>
      </WindowFloor>,
    )

    expect(screen.queryByText('the instrument')).not.toBeInTheDocument()
    const panel = screen.getByTestId('window-floor')
    expect(panel).toBeInTheDocument()
    // The three things S5 requires the panel to say: the minimum, the
    // current size, and that the instrument resumes when resized.
    expect(panel.textContent).toContain(`${WINDOW_MIN_WIDTH}×${WINDOW_MIN_HEIGHT}`)
    expect(panel.textContent).toContain(`${WINDOW_MIN_WIDTH - 1}×900`)
    expect(panel.textContent?.toLowerCase()).toContain('resumes')
  })

  it('replaces the whole frame below the height floor too', () => {
    act(() => resize(1440, WINDOW_MIN_HEIGHT - 1))
    render(
      <WindowFloor>
        <div>the instrument</div>
      </WindowFloor>,
    )

    expect(screen.queryByText('the instrument')).not.toBeInTheDocument()
    expect(screen.getByTestId('window-floor').textContent).toContain(`1440×${WINDOW_MIN_HEIGHT - 1}`)
  })

  it('never breaks silently — a live resize below the floor swaps in the panel, and back out resumes the instrument', () => {
    render(
      <WindowFloor>
        <div>the instrument</div>
      </WindowFloor>,
    )
    expect(screen.getByText('the instrument')).toBeInTheDocument()

    act(() => resize(900, 600))
    expect(screen.queryByText('the instrument')).not.toBeInTheDocument()
    expect(screen.getByTestId('window-floor')).toBeInTheDocument()

    act(() => resize(1440, 900))
    expect(screen.getByText('the instrument')).toBeInTheDocument()
    expect(screen.queryByTestId('window-floor')).toBeNull()
  })
})
