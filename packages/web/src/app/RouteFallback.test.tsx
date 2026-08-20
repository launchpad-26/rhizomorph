import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary.js'
import { RouteFallback } from './RouteFallback.js'

/**
 * THE ROUTE BOUNDARY'S LAWS (loop 21). A page crash must produce words, a way
 * back, and a console record — never a white screen, and never a silent catch.
 */

function Bomb(): never {
  throw new Error('deliberate test crash')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('a route crash is contained, worded, and reported', () => {
  it('the boundary absorbs a throwing page and shows the fallback instead of nothing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary fallback={<RouteFallback route="settings" />}>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('this page failed to draw')).toBeInTheDocument()
    expect(screen.getByText('settings')).toBeInTheDocument()
    // the two ways out are real controls
    expect(screen.getByRole('button', { name: /reload the instrument/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back to the observatory/i })).toHaveAttribute('href', '/')
  })

  it('the catch is never silent — the boundary reports what it absorbed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary fallback={<RouteFallback route="lane" />}>
        <Bomb />
      </ErrorBoundary>,
    )
    const reported = spy.mock.calls.some((call) =>
      String(call[0]).includes('a view crashed and its boundary caught it'),
    )
    expect(reported).toBe(true)
  })

  it('says whose fault it is — the page, never the session', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary fallback={<RouteFallback route="recordings" />}>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && /separate processes and are not affected/i.test(el.textContent ?? '')),
    ).toBeInTheDocument()
  })
})
