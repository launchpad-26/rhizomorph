import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEventFactory, initialSessionState, reduce } from '@observatory/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { StreamProvider } from '../../app/StreamContext.js'
import { FleetProvider } from '../../fleet/FleetContext.js'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  specFor,
  SyntheticFleet,
} from '../../fleet/index.js'
import type { FetchLike } from '../../fleet/manifest.js'
import { SelectionProvider } from '../../fleet/selection.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import FleetTable from './index.js'

afterEach(cleanup)

/** Pinned, so the fixture and the derived fleet never move under the test. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

/**
 * `StreamProvider` builds each fixture's history the first time a test
 * presses its key, which is also the moment vitest's per-test timeout clock
 * is running. Warming fixtures.ts's memo here — same spec singleton, same
 * `now`, same default seed the provider uses — moves that one-time
 * ~8,000-event build into setup, so no single test (in this file or any
 * other sharing the cache) pays for it under load.
 */
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

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  open() {
    this.onopen?.(new Event('open'))
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }

  close() {}
}

const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

async function renderFixture(key: '2' | '3') {
  await act(async () => {
    render(
      <StreamProvider url="/api/stream" now={NOW} createSource={() => new SilentEventSource()}>
        <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
          <SelectionProvider>
            <FleetTable />
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>,
    )
  })
  await act(async () => {
    fireEvent.keyDown(window, { key })
  })
}

/** The same derivation FleetProvider performs for a fixture, computed independently. */
function expectedFleet(id: 'fleet20' | 'pathology') {
  const spec = specFor(id)
  const events = new SyntheticFleet(spec).history(NOW)
  const session = events.reduce(reduce, initialSessionState())
  return buildFleet(session, { now: NOW, manifest: manifestFor(spec) })
}

function rows(): HTMLElement[] {
  return screen.getAllByTestId('fleet-row')
}

describe('FleetTable — the twenty-lane fixture (ruling 22 scale test)', () => {
  // Hoisted out of the `it`: the mount folds a real ~8,000-event history and
  // renders all 20 rows, so it belongs under `beforeAll`'s hookTimeout
  // (10s), not the 5s testTimeout a busy box can blow through on cost alone.
  beforeAll(async () => {
    await renderFixture('2')
  })

  it('renders every lane, in the fleet object\'s own order', async () => {
    const expected = expectedFleet('fleet20')
    expect(expected.rank).toBe('calm')
    expect(rows()).toHaveLength(20)
    expect(rows().map((row) => row.getAttribute('data-lane'))).toEqual(
      expected.lanes.map((lane) => lane.id),
    )
  })
})

describe('FleetTable — the staged-pathology fixture', () => {
  it('draws a distinct STATE glyph for every one of the five pathologies', async () => {
    await renderFixture('3')

    const expected = { rank: expectedFleet('pathology').rank }
    expect(expected.rank).toBe('broken')

    const cases: [string, string, string][] = [
      ['41-retry-parser', 'looping', 'LOOPING'],
      ['42-otel-receiver', 'frozen', 'FROZEN'],
      ['43-drawer-attach', 'waiting', 'WAITING'],
      ['44-scene-pulses', 'expensive', 'EXPENSIVE'],
      ['45-ledger-subrows', 'off-fence', 'OFF-FENCE'],
    ]

    for (const [laneId, sigilKind, word] of cases) {
      const row = rows().find((r) => r.getAttribute('data-lane') === laneId)
      expect(row, `no row for ${laneId}`).toBeDefined()
      const svg = (row as HTMLElement).querySelector('svg[data-sigil]')
      expect(svg?.getAttribute('data-sigil')).toBe(sigilKind)
      expect((row as HTMLElement).textContent).toContain(word)
    }
  })

  it('inks the STATE cell in the same six hues the scene paints with (graft g1)', async () => {
    await renderFixture('3')

    // The table is the scene's legend, and since ruling 3 that means the
    // palette and not only the glyphs: a reader learns "green = getting on with
    // it" here, beside the word, and then reads the picture without a legend.
    const stateSpan = (laneId: string): HTMLElement => {
      const row = rows().find((r) => r.getAttribute('data-lane') === laneId)
      expect(row, `no row for ${laneId}`).toBeDefined()
      const span = (row as HTMLElement).querySelectorAll('td')[1]?.querySelector('span')
      expect(span, `no state span for ${laneId}`).not.toBeNull()
      return span as HTMLElement
    }

    // An alarmed row keeps the rung's class outright. A looping lane is also,
    // technically, working — and must never be softened into green by it.
    expect(stateSpan('41-retry-parser').className).toContain('text-needs-you')
    expect(stateSpan('42-otel-receiver').className).toContain('text-broken')
    expect(stateSpan('44-scene-pulses').className).toContain('text-notice')

    // A calm row wears its activity's own hue instead of the old blanket ice.
    const calm = expectedFleet('pathology').lanes.find(
      (lane) => lane.rank === 'calm' && lane.activity === 'working',
    )
    expect(calm, 'the fixture has no calm working lane to read').toBeDefined()
    expect(stateSpan((calm as { id: string }).id).className).toContain('text-working')
  })

  it('keeps a quiet lane\'s facts as legible as a busy one\'s', async () => {
    // The row-wide `opacity-60` on idle and done lanes is gone. It dimmed the
    // lane's name, cost and age along with its state — facts exactly as true and
    // exactly as worth reading whatever the lane is up to. Dimness now lives in
    // the one cell that is about how the lane *is*.
    await renderFixture('3')

    for (const row of rows()) {
      expect(row.className, `${row.getAttribute('data-lane')} was faded wholesale`).not.toContain(
        'opacity-',
      )
    }
  })

  it('surfaces the detector\'s own evidence string on the STATE cell, not a bare label (graft g4)', async () => {
    await renderFixture('3')

    const loopingRow = rows().find((r) => r.getAttribute('data-lane') === '41-retry-parser') as HTMLElement
    const stateCell = loopingRow.querySelectorAll('td')[1] as HTMLElement
    expect(stateCell.getAttribute('title')).toMatch(/Read→Edit→Bash ×\d+, no commit/)

    const frozenRow = rows().find((r) => r.getAttribute('data-lane') === '42-otel-receiver') as HTMLElement
    const frozenState = frozenRow.querySelectorAll('td')[1] as HTMLElement
    expect(frozenState.getAttribute('title')).toMatch(/no events for/)

    const expensiveRow = rows().find((r) => r.getAttribute('data-lane') === '44-scene-pulses') as HTMLElement
    const expensiveState = expensiveRow.querySelectorAll('td')[1] as HTMLElement
    expect(expensiveState.getAttribute('title')).toMatch(/out-tok\/min.*fleet median/)
  })
})

describe('FleetTable — selection wiring', () => {
  it('toggles the shared selection on click, and Esc clears it', async () => {
    await renderFixture('2')

    const first = rows()[0] as HTMLElement
    expect(first.getAttribute('aria-selected')).toBe('false')

    await act(async () => {
      fireEvent.click(first)
    })
    expect(first.getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(first.getAttribute('aria-selected')).toBe('false')
  })

  it('clicking a second row moves the selection rather than adding to it', async () => {
    await renderFixture('2')

    const [first, second] = rows()

    await act(async () => {
      fireEvent.click(first as HTMLElement)
    })
    await act(async () => {
      fireEvent.click(second as HTMLElement)
    })

    expect((first as HTMLElement).getAttribute('aria-selected')).toBe('false')
    expect((second as HTMLElement).getAttribute('aria-selected')).toBe('true')
  })
})

describe('FleetTable — gap-honest cells (law 12)', () => {
  async function renderGapScenario() {
    const fx = createEventFactory({ startTs: NOW - 5 * 60_000 })
    const laneWorktreePath = '/repo/observatory__worktrees/42-gap-lane'

    fx.sessionStarted({ repoPath: '/repo/observatory', repoName: 'observatory', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/observatory', branch: 'main', isMain: true })
    fx.worktreeDiscovered({ path: laneWorktreePath, branch: '42-gap-lane', isMain: false })
    // A declared subagent thread and a thread the source never named — the
    // honest reading is `sub` beside `unk`, never a guess at the second one.
    fx.llmUsage({
      lane: '42-gap-lane',
      branch: '42-gap-lane',
      worktreePath: laneWorktreePath,
      thread: 'subagent',
      tokens: { input: 5, output: 120, cacheRead: 10, cacheCreation: 20 },
    })
    fx.llmUsage({
      lane: '42-gap-lane',
      branch: '42-gap-lane',
      worktreePath: laneWorktreePath,
      tokens: { input: 5, output: 80, cacheRead: 5, cacheCreation: 5 },
    })
    fx.toolActivity({ lane: '42-gap-lane', branch: '42-gap-lane', worktreePath: laneWorktreePath, tool: 'Read' })
    // Deliberately no `llm.cost` event anywhere in the session: no cost feed at all.

    let source: FakeEventSource | undefined
    await act(async () => {
      render(
        <StreamProvider
          url="/api/stream"
          now={NOW}
          createSource={() => {
            source = new FakeEventSource()
            return source
          }}
        >
          <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
            <SelectionProvider>
              <FleetTable />
            </SelectionProvider>
          </FleetProvider>
        </StreamProvider>,
      )
    })
    await act(async () => {
      source?.open()
      for (const event of fx.all()) source?.emit(event)
    })

    return rows().find((r) => r.getAttribute('data-lane') === '42-gap-lane') as HTMLElement
  }

  it('reads $ as a gap, not a zero, when no cost telemetry has arrived (law 12)', async () => {
    const row = await renderGapScenario()
    const costCell = row.querySelectorAll('td')[3] as HTMLElement
    expect(costCell.textContent).toContain('—')
    expect(costCell.getAttribute('title')).toMatch(/NO COST FEED.*dollars unavailable.*run:/)
  })

  it('labels threads honestly: a declared thread beside `unk` for the one the source never named', async () => {
    const row = await renderGapScenario()
    const threadsCell = row.querySelectorAll('td')[6] as HTMLElement
    expect(threadsCell.textContent?.toUpperCase()).toContain('SUB')
    expect(threadsCell.textContent?.toUpperCase()).toContain('UNK')
  })

  it('shows `none` in the fence column when there is no lane manifest at all (ruling 19)', async () => {
    const row = await renderGapScenario()
    const fenceCellEl = row.querySelectorAll('td')[8] as HTMLElement
    expect(fenceCellEl.textContent).toBe('none')
    expect(fenceCellEl.getAttribute('title')).toMatch(/NO LANE MANIFEST.*off-fence detection unavailable/)
  })
})

describe('FleetTable — parked lanes (prd4 ruling 5)', () => {
  const PARKED_LANE = '50-parked-lane'

  async function renderParkedScenario() {
    const fx = createEventFactory({ startTs: NOW - 5 * 60_000 })
    const laneWorktreePath = `/repo/observatory__worktrees/${PARKED_LANE}`

    fx.sessionStarted({ repoPath: '/repo/observatory', repoName: 'observatory', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/observatory', branch: 'main', isMain: true })
    fx.worktreeDiscovered({ path: laneWorktreePath, branch: PARKED_LANE, isMain: false })
    fx.llmUsage({
      lane: PARKED_LANE,
      branch: PARKED_LANE,
      worktreePath: laneWorktreePath,
      tokens: { input: 5, output: 90, cacheRead: 0, cacheCreation: 0 },
    })

    const parkedManifest: FetchLike = async () => ({
      ok: true,
      json: async () => ({
        available: true,
        version: 1,
        lanes: [
          {
            handle: PARKED_LANE,
            branch: PARKED_LANE,
            fence: ['packages/parked/**'],
            parked: true,
          },
        ],
      }),
    })

    let source: FakeEventSource | undefined
    await act(async () => {
      render(
        <StreamProvider
          url="/api/stream"
          now={NOW}
          createSource={() => {
            source = new FakeEventSource()
            return source
          }}
        >
          <FleetProvider now={NOW} fetchLanes={parkedManifest}>
            <SelectionProvider>
              <FleetTable />
            </SelectionProvider>
          </FleetProvider>
        </StreamProvider>,
      )
    })
    await act(async () => {
      source?.open()
      for (const event of fx.all()) source?.emit(event)
    })
    // `fetchLanes` resolves on a microtask of its own; give it a tick to land.
    await act(async () => {})

    return rows().find((r) => r.getAttribute('data-lane') === PARKED_LANE) as HTMLElement
  }

  it('reads PARKED, dimmer than an idle row, in place of a glyph and a pathology word', async () => {
    const row = await renderParkedScenario()
    const stateCell = row.querySelectorAll('td')[1] as HTMLElement

    expect(stateCell.textContent).toContain('PARKED')
    // No sigil glyph is drawn for a parked row: the alphabet has no member for
    // "parked" (see buildFleet.ts's `Lane.parked` doc — extending it would
    // require an exhaustive key on maps outside this change's fence), so the
    // word carries the state on its own rather than the mark falling back to
    // an unrelated glyph.
    expect(stateCell.querySelector('svg[data-sigil]')).toBeNull()

    const span = stateCell.querySelector('span') as HTMLElement
    expect(span.className).toContain('text-ice-700')
    expect(stateCell.getAttribute('title')).toMatch(/parked/i)
  })

  it('still shows the lane\'s real output honestly — parked mutes the alarm, not the evidence', async () => {
    const row = await renderParkedScenario()
    const outputCell = row.querySelectorAll('td')[2] as HTMLElement
    expect(outputCell.textContent?.trim()).not.toBe('')
    expect(outputCell.textContent).not.toBe('—')
  })
})
