import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamProvider } from '../app/StreamContext.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { FleetProvider, useFleet } from './FleetContext.js'
import type { FetchLike } from './manifest.js'

afterEach(cleanup)

/**
 * The provider chain end to end: a source, folded by one reducer, read by one
 * derived object. Nothing here mocks `buildFleet` — the point is that the fleet
 * a surface will actually receive is the one the detectors produced.
 */

/** Pinned, so the fixtures and the derived fleet never move under the test. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

class SilentEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/** A server that has not shipped `/api/lanes` yet (#76) — the wave-1 truth. */
const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

/** A server that has: the manifest the keystone's own dispatch would have written. */
const withLaneManifest: FetchLike = async () => ({
  ok: true,
  json: async () => ({
    lanes: {
      '75-instrument-keystone': {
        handle: '75-instrument-keystone',
        fence: ['packages/web/src/fleet/**'],
        issue: '75',
        model: 'claude-opus-5',
      },
    },
  }),
})

function Probe() {
  const fleet = useFleet()
  return (
    <div>
      <span data-testid="rank">{fleet.rank}</span>
      <span data-testid="lanes">{fleet.lanes.length}</span>
      <span data-testid="manifest">{String(fleet.hasLaneManifest)}</span>
      <span data-testid="gaps">{fleet.gaps.map((gap) => gap.id).join(',')}</span>
      <span data-testid="items">
        {fleet.ladder.rank === 'calm' ? fleet.ladder.evidence.line : fleet.ladder.items.map((item) => item.kind).sort().join(',')}
      </span>
    </div>
  )
}

async function renderChain(fetchLanes: FetchLike) {
  await act(async () => {
    render(
      <StreamProvider url="/api/stream" now={NOW} createSource={() => new SilentEventSource()}>
        <FleetProvider now={NOW} fetchLanes={fetchLanes}>
          <Probe />
        </FleetProvider>
      </StreamProvider>,
    )
  })
}

describe('FleetProvider', () => {
  it('derives an empty, calm fleet from a stream that has said nothing', async () => {
    await renderChain(noLaneManifest)

    expect(screen.getByTestId('rank').textContent).toBe('calm')
    expect(screen.getByTestId('lanes').textContent).toBe('0')
    // An empty instrument still speaks in the gap voice rather than reassuring.
    expect(screen.getByTestId('gaps').textContent).toContain('no-lane-manifest')
    expect(screen.getByTestId('gaps').textContent).toContain('no-cost-feed')
  })

  it('takes the lane manifest from the server when it serves one (#76)', async () => {
    await renderChain(withLaneManifest)

    expect(screen.getByTestId('manifest').textContent).toBe('true')
    expect(screen.getByTestId('gaps').textContent).not.toContain('no-lane-manifest')
  })

  it('rebuilds from a fixture source, detectors and all', async () => {
    await renderChain(noLaneManifest)

    await act(async () => {
      fireEvent.keyDown(window, { key: '3' })
    })

    expect(screen.getByTestId('lanes').textContent).toBe('9')
    expect(screen.getByTestId('rank').textContent).toBe('broken')
    // A fixture brings the manifest it was dispatched with, so off-fence is
    // available here even though the server has none.
    expect(screen.getByTestId('manifest').textContent).toBe('true')
    expect(screen.getByTestId('items').textContent).toBe(
      'expensive,frozen,looping,off-fence,waiting',
    )
  })

  it('reads ALL CLEAR with its evidence on the twenty-lane fleet', async () => {
    await renderChain(noLaneManifest)

    await act(async () => {
      fireEvent.keyDown(window, { key: '2' })
    })

    expect(screen.getByTestId('rank').textContent).toBe('calm')
    expect(screen.getByTestId('items').textContent).toBe(
      'collisions: 0 — checked 20 branches / 20 files',
    )
  })
})
