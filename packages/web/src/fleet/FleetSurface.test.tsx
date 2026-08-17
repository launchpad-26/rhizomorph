import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamProvider } from '../app/StreamContext.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { FleetProvider } from './FleetContext.js'
import { FleetSurface } from './FleetSurface.js'
import { fixtureHistory, fleet20Spec, useFleet } from './index.js'
import type { FetchLike } from './manifest.js'
import { SelectionProvider, useSelection } from './selection.js'

/**
 * THE FLEET SURFACE (prd-36 ruling 1 / S1, #555).
 *
 * The list arm here is the REAL fleet table, not a stub: this file's central
 * claim is that the list is the floor, and a stubbed floor proves nothing about
 * the one a person actually stands on. The organism arm is stubbed, because the
 * scene is a canvas — there is nothing in a jsdom `<canvas>` to read a lane id
 * off — and the stub is deliberately built to answer the two questions the
 * canvas cannot: which fleet was it handed, and which lane does it think is
 * selected. Both come from the same providers the real scene reads, so a stub
 * that agreed with the table while the real scene did not would have to be
 * reading a second fleet, which is the thing `FleetProvider` makes impossible.
 */

/** `vi.hoisted`, so the mock factory below can reach it whenever `lazy()` resolves the module. */
const scene = vi.hoisted(() => ({ canRender: true }))

vi.mock('../scene/index.js', () => ({
  default: function SceneStub() {
    const fleet = useFleet()
    const { selectedId, select } = useSelection()
    if (!scene.canRender) {
      // What a canvas that cannot get a WebGL context does, from the surface's
      // point of view: it throws on first render and the error boundary catches.
      throw new Error('scene stub: no context')
    }
    return (
      <div
        data-testid="scene-stub"
        data-lanes={fleet.lanes.map((lane) => lane.id).join(' ')}
        data-selected={selectedId ?? ''}
      >
        <button type="button" onClick={() => select(fleet.lanes[2]?.id ?? null)}>
          select a thread
        </button>
      </div>
    )
  },
}))

/** Pinned, so the fixture and the derived fleet never move under a test. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

class SilentEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/**
 * Both arms are behind `lazy()`, and both are preloaded here rather than raced
 * against a `waitFor` deadline — the same flake class `App.test.tsx` and
 * `PanelGrid.test.tsx` document at length. The fixture history is warmed for the
 * same reason: building ~8,000 events inside the first test's own timeout is how
 * a suite goes red under load rather than because of the code.
 */
beforeAll(async () => {
  await Promise.all([import('../scene/index.js'), import('../panels/fleet/index.js')])
  fixtureHistory(fleet20Spec(), NOW)
})

beforeEach(() => {
  scene.canRender = true
})

afterEach(cleanup)

/** Mounts the surface over the 20-lane fixture — the fleet a real screen holds. */
async function renderSurface() {
  render(
    <StreamProvider url="/api/stream" now={NOW} createSource={() => new SilentEventSource()}>
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <SelectionProvider>
          <FleetSurface />
        </SelectionProvider>
      </FleetProvider>
    </StreamProvider>,
  )
  await act(async () => {})
  await act(async () => {
    fireEvent.keyDown(window, { key: '2' })
  })
}

/** The representation currently up, read off the surface itself rather than inferred. */
function representation(): string | null {
  return document.querySelector('[data-surface="fleet"]')?.getAttribute('data-representation') ?? null
}

/**
 * The keystroke, plus the one tick React's `lazy()` insists on the first time
 * an arm is mounted. Awaited rather than raced against a `waitFor` deadline —
 * the module is already preloaded, so there is nothing left but the mandatory
 * suspend-then-resume, and flushing it deterministically is what keeps this
 * suite off the flake class the other shells' tests document.
 */
async function toggle() {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'v' })
  })
}

function listedLaneIds(): string[] {
  return [...document.querySelectorAll('[data-testid="fleet-row"]')].map(
    (row) => row.getAttribute('data-lane') ?? '',
  )
}

function scenedLaneIds(): string[] {
  const lanes = screen.getByTestId('scene-stub').getAttribute('data-lanes') ?? ''
  return lanes === '' ? [] : lanes.split(' ')
}

describe('one surface, two representations', () => {
  it('opens on the organism and mounts no list beside it', async () => {
    await renderSurface()

    expect(representation()).toBe('organism')
    expect(screen.getByTestId('scene-stub')).toBeInTheDocument()
    expect(listedLaneIds()).toEqual([])
    // One frame, not two — the merge's whole point.
    expect(document.querySelectorAll('[data-surface="fleet"]')).toHaveLength(1)
  })

  it('switches to the list on one keystroke, and back', async () => {
    await renderSurface()

    await toggle()
    expect(representation()).toBe('list')
    expect(screen.queryByTestId('scene-stub')).not.toBeInTheDocument()
    expect(listedLaneIds().length).toBeGreaterThan(0)

    await toggle()
    expect(representation()).toBe('organism')
    expect(screen.getByTestId('scene-stub')).toBeInTheDocument()
  })

  it('renders both representations from the same Fleet — the lane id sets are identical', async () => {
    await renderSurface()

    const fromScene = scenedLaneIds()
    expect(fromScene.length).toBeGreaterThanOrEqual(20)

    await toggle()
    const fromList = listedLaneIds()

    // Sets, not order: the table sorts by the derived fleet's own ranking and
    // the scene positions by lifecycle. What may never differ is WHO is there.
    expect([...fromList].sort()).toEqual([...fromScene].sort())
    // …and the list drops nobody on the way, which set-equality alone would
    // hide if the table rendered one lane twice.
    expect(fromList).toHaveLength(fromScene.length)
    expect(new Set(fromList).size).toBe(fromList.length)
  })
})

describe('selection is shared, and survives the switch', () => {
  it('carries a lane selected in the list over to the organism', async () => {
    await renderSurface()
    await toggle()

    const rows = [...document.querySelectorAll('[data-testid="fleet-row"]')]
    const chosen = rows[3]?.getAttribute('data-lane') as string
    fireEvent.click(rows[3] as Element)
    expect(rows[3]).toHaveAttribute('aria-selected', 'true')

    await toggle()

    expect(representation()).toBe('organism')
    expect(screen.getByTestId('scene-stub')).toHaveAttribute('data-selected', chosen)
  })

  it('carries a lane selected in the organism over to the list', async () => {
    await renderSurface()

    fireEvent.click(screen.getByRole('button', { name: 'select a thread' }))
    const chosen = screen.getByTestId('scene-stub').getAttribute('data-selected') as string
    expect(chosen).not.toBe('')

    await toggle()

    const selected = [...document.querySelectorAll('[data-testid="fleet-row"]')].filter(
      (row) => row.getAttribute('aria-selected') === 'true',
    )
    expect(selected).toHaveLength(1)
    expect(selected[0]).toHaveAttribute('data-lane', chosen)
  })

  it('still holds the selection after a round trip through both representations', async () => {
    await renderSurface()
    await toggle()

    const chosen = [...document.querySelectorAll('[data-testid="fleet-row"]')][1] as Element
    const chosenId = chosen.getAttribute('data-lane')
    fireEvent.click(chosen)

    await toggle()
    await toggle()

    const selected = [...document.querySelectorAll('[data-testid="fleet-row"]')].filter(
      (row) => row.getAttribute('aria-selected') === 'true',
    )
    expect(selected.map((row) => row.getAttribute('data-lane'))).toEqual([chosenId])
  })
})

describe('the list is the floor', () => {
  it('renders and is fully usable with the scene off', async () => {
    // Not "falls back to" — the list is what is always there. The scene here
    // cannot render at all, which is the case ruling 1 wrote the floor for.
    scene.canRender = false
    await renderSurface()

    await toggle()

    expect(representation()).toBe('list')
    // Every lane, not a subset: the floor is complete or it is not a floor.
    expect(listedLaneIds().length).toBeGreaterThanOrEqual(20)
    // …and usable, not merely present: rows select, and the verbs are on show.
    const row = document.querySelector('[data-testid="fleet-row"]') as Element
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('fleet-key-hint')).toBeInTheDocument()
    expect(screen.getAllByTestId('fleet-row-open').length).toBe(listedLaneIds().length)
  })

  it('falls to the list and says so ONCE when the canvas will not come up (S1 *error*)', async () => {
    scene.canRender = false
    await renderSurface()

    // Law 12's voice: what is missing, what is unaffected, and no offer to
    // retry silently — S1 is explicit that a spinner in place of a fleet is the
    // wrong answer for a canvas that failed to initialise.
    const line = screen.getByTestId('fleet-organism-unavailable')
    expect(line.textContent).toMatch(/organism unavailable/i)
    expect(line.textContent).toMatch(/carries every lane/i)

    // Once, not once per retry: the line is the boundary's single fallback,
    // and there is exactly one of it however many frames the renderer throws on.
    expect(screen.getAllByTestId('fleet-organism-unavailable')).toHaveLength(1)

    // The FLOOR is what is under it — every lane, in full, without the person
    // having to press anything.
    expect(listedLaneIds().length).toBeGreaterThanOrEqual(20)
    expect(screen.getByTestId('fleet-key-hint')).toBeInTheDocument()

    // …and the person's own choice is untouched. Ruling 3's fourth guarantee:
    // no representation may be selected automatically by application state, so
    // the toggle still reads `organism` and a reload lands back on it — on a
    // machine where the canvas may since have recovered.
    expect(representation()).toBe('organism')
    expect(screen.getByTestId('fleet-representation-organism')).toHaveAttribute('aria-pressed', 'true')
  })

  it('does not depend on the scene ever having been mounted', async () => {
    // The mutation this survives: if the list arm quietly needed something the
    // organism arm set up, a suite that always renders the organism first would
    // never see it. Here the scene is broken from the first frame AND the list
    // is reached without a working one.
    scene.canRender = false
    await renderSurface()
    await toggle()

    expect(screen.queryByTestId('scene-stub')).not.toBeInTheDocument()
    expect(listedLaneIds().length).toBeGreaterThanOrEqual(20)
  })
})
