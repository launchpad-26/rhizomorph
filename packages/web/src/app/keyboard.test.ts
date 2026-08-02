import { initialSessionState, reduce } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FleetProvider } from '../fleet/FleetContext.js'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  specFor,
  SyntheticFleet,
  type Fleet,
} from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { needsYouLaneIds, SelectionProvider, useSelection } from '../fleet/selection.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { StreamProvider } from './StreamContext.js'
import { ALL_CLEAR_FLASH_MS, useIdleWorkerJump } from './keyboard.js'

/**
 * Plain `React.createElement`, no JSX: the fence names this file `.ts`, and
 * Vite's esbuild transform only parses JSX syntax for a `.tsx` loader.
 */

afterEach(cleanup)

/**
 * Same fixture-warming reasoning as `panels/fleet/index.test.tsx`: the memo
 * is a singleton keyed by spec + `now`, so warming it here in `beforeAll`
 * means no single `it()` here (or anywhere else sharing the cache) pays for
 * the ~8,000-event fixture build under load.
 */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

beforeAll(() => {
  fixtureHistory(fleet20Spec(), NOW)
  fixtureHistory(pathologySpec(), NOW)
})

class SilentEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

/** The same derivation `FleetProvider` performs for a fixture, computed independently. */
function expectedFleet(id: 'fleet20' | 'pathology'): Fleet {
  const spec = specFor(id)
  const events = new SyntheticFleet(spec).history(NOW)
  const session = events.reduce(reduce, initialSessionState())
  return buildFleet(session, { now: NOW, manifest: manifestFor(spec) })
}

/**
 * Mounts the hook under test plus enough surface to assert on: a plain
 * reader of the shared selection (standing in for every click-idiom
 * consumer — the table, the scene, the drawer), a typing target for the
 * guard, and the attention-strip stub the "all clear" flash reaches for by
 * its `data-panel` attribute (owned by #103; this file never renders its
 * real content, only the same bare marker it exposes).
 */
function Harness() {
  useIdleWorkerJump()
  const { selectedId } = useSelection()
  return createElement(
    'div',
    null,
    createElement('div', { 'data-panel': 'attention', 'data-testid': 'attention-region' }),
    createElement('input', { 'aria-label': 'typing target' }),
    createElement('span', { 'data-testid': 'selected' }, selectedId ?? '(none)'),
  )
}

async function renderFixture(key: '2' | '3') {
  await act(async () => {
    render(
      createElement(
        StreamProvider,
        { url: '/api/stream', now: NOW, createSource: () => new SilentEventSource(), children: null },
        createElement(
          FleetProvider,
          { now: NOW, fetchLanes: noLaneManifest, children: null },
          createElement(SelectionProvider, null, createElement(Harness)),
        ),
      ),
    )
  })
  await act(async () => {
    fireEvent.keyDown(window, { key })
  })
}

describe('useIdleWorkerJump — the staged-pathology fixture (needs-you lanes)', () => {
  it('cycles worst-first — the ladder\'s own order — and wraps', async () => {
    await renderFixture('3')
    const order = needsYouLaneIds(expectedFleet('pathology'))
    expect(order.length).toBeGreaterThanOrEqual(3)

    for (const laneId of order) {
      await act(async () => {
        fireEvent.keyDown(window, { key: 'n' })
      })
      expect(screen.getByTestId('selected').textContent).toBe(laneId)
    }

    // One more forward jump wraps back to the worst lane.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'n' })
    })
    expect(screen.getByTestId('selected').textContent).toBe(order[0])
  })

  it('walks backward on Shift+n, in the reverse order', async () => {
    await renderFixture('3')
    const order = needsYouLaneIds(expectedFleet('pathology'))

    await act(async () => {
      fireEvent.keyDown(window, { key: 'N', shiftKey: true })
    })
    expect(screen.getByTestId('selected').textContent).toBe(order[order.length - 1])

    await act(async () => {
      fireEvent.keyDown(window, { key: 'N', shiftKey: true })
    })
    expect(screen.getByTestId('selected').textContent).toBe(order[order.length - 2])
  })

  it('does not fire while typing in an input (the standard guard)', async () => {
    await renderFixture('3')
    const input = screen.getByLabelText('typing target')
    input.focus()

    await act(async () => {
      fireEvent.keyDown(input, { key: 'n' })
    })

    expect(screen.getByTestId('selected').textContent).toBe('(none)')
  })

  it('ignores a modified n (Ctrl/Cmd+n), so it does not steal a browser shortcut', async () => {
    await renderFixture('3')

    await act(async () => {
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true })
    })

    expect(screen.getByTestId('selected').textContent).toBe('(none)')
  })
})

describe('useIdleWorkerJump — the twenty-lane fixture (ALL CLEAR)', () => {
  it('leaves the selection untouched and flashes the attention region instead', async () => {
    vi.useFakeTimers()
    try {
      await renderFixture('2')
      expect(needsYouLaneIds(expectedFleet('fleet20'))).toEqual([])

      const region = screen.getByTestId('attention-region')
      expect(region.style.backgroundColor).toBe('')

      act(() => {
        fireEvent.keyDown(window, { key: 'n' })
      })

      expect(screen.getByTestId('selected').textContent).toBe('(none)')
      expect(region.style.backgroundColor).not.toBe('')

      act(() => {
        vi.advanceTimersByTime(ALL_CLEAR_FLASH_MS + 10)
      })
      expect(region.style.backgroundColor).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
})
