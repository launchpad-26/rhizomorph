import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { laneUrl, navigate, parseRoute, useRoute } from './router.js'

/** Every test starts mid-history so `back()` always has somewhere to land. */
function resetHistory(): void {
  window.history.replaceState(null, '', '/')
}

/** jsdom's `back`/`forward` fire `popstate` on a later task, not synchronously. */
function waitForPopstate(): Promise<void> {
  return new Promise((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }))
}

afterEach(() => {
  resetHistory()
})

describe('parseRoute', () => {
  it('reads the bare root as the balcony', () => {
    expect(parseRoute('/')).toEqual({ name: 'balcony' })
  })

  it('reads a lane path as the lane route, handle intact', () => {
    expect(parseRoute('/lane/42-otel-receiver')).toEqual({
      name: 'lane',
      handle: '42-otel-receiver',
    })
  })

  it('tolerates a trailing slash', () => {
    expect(parseRoute('/lane/42-otel-receiver/')).toEqual({
      name: 'lane',
      handle: '42-otel-receiver',
    })
  })

  it('decodes a percent-encoded handle', () => {
    expect(parseRoute('/lane/feature%20branch')).toEqual({
      name: 'lane',
      handle: 'feature branch',
    })
  })

  it('falls back to the balcony for anything else — never a crash on an unknown shape', () => {
    expect(parseRoute('/lane/')).toEqual({ name: 'balcony' })
    expect(parseRoute('/lane/a/b')).toEqual({ name: 'balcony' })
    expect(parseRoute('/whatever')).toEqual({ name: 'balcony' })
  })

  it('reads /recordings as the recordings library (prd16 ruling 4)', () => {
    expect(parseRoute('/recordings')).toEqual({ name: 'recordings' })
  })

  it('tolerates a trailing slash on /recordings', () => {
    expect(parseRoute('/recordings/')).toEqual({ name: 'recordings' })
  })

  it('reads /lab as the experiment console (prd14)', () => {
    expect(parseRoute('/lab')).toEqual({ name: 'lab' })
  })

  it('tolerates a trailing slash on /lab', () => {
    expect(parseRoute('/lab/')).toEqual({ name: 'lab' })
  })
})

describe('laneUrl', () => {
  it('builds the one URL a lane page ever answers to', () => {
    expect(laneUrl('42-otel-receiver')).toBe('/lane/42-otel-receiver')
  })

  it('encodes characters a path segment cannot carry raw', () => {
    expect(laneUrl('feature branch')).toBe('/lane/feature%20branch')
  })

  it('round-trips through parseRoute', () => {
    expect(parseRoute(laneUrl('a/b'))).toEqual({ name: 'lane', handle: 'a/b' })
  })
})

describe('useRoute', () => {
  it('reads the current location on mount', () => {
    window.history.replaceState(null, '', '/lane/9-lane-page')
    const { result } = renderHook(() => useRoute())
    expect(result.current).toEqual({ name: 'lane', handle: '9-lane-page' })
  })

  it('re-renders after a programmatic navigate', () => {
    const { result } = renderHook(() => useRoute())
    expect(result.current).toEqual({ name: 'balcony' })

    act(() => navigate(laneUrl('9-lane-page')))

    expect(result.current).toEqual({ name: 'lane', handle: '9-lane-page' })
    expect(window.location.pathname).toBe('/lane/9-lane-page')
  })

  it('follows the browser back button', async () => {
    const { result } = renderHook(() => useRoute())

    act(() => navigate(laneUrl('9-lane-page')))
    expect(result.current).toEqual({ name: 'lane', handle: '9-lane-page' })

    await act(async () => {
      const popped = waitForPopstate()
      window.history.back()
      await popped
    })

    expect(result.current).toEqual({ name: 'balcony' })
  })

  it('follows the browser forward button', async () => {
    const { result } = renderHook(() => useRoute())

    act(() => navigate(laneUrl('9-lane-page')))
    await act(async () => {
      const popped = waitForPopstate()
      window.history.back()
      await popped
    })
    expect(result.current).toEqual({ name: 'balcony' })

    await act(async () => {
      const popped = waitForPopstate()
      window.history.forward()
      await popped
    })

    expect(result.current).toEqual({ name: 'lane', handle: '9-lane-page' })
  })

  it('navigates to the recordings library and back', () => {
    const { result } = renderHook(() => useRoute())

    act(() => navigate('/recordings'))
    expect(result.current).toEqual({ name: 'recordings' })

    act(() => navigate('/'))
    expect(result.current).toEqual({ name: 'balcony' })
  })

  it('navigates to the lab and back', () => {
    const { result } = renderHook(() => useRoute())

    act(() => navigate('/lab'))
    expect(result.current).toEqual({ name: 'lab' })

    act(() => navigate('/'))
    expect(result.current).toEqual({ name: 'balcony' })
  })
})
