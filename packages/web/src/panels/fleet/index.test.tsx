import type { ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createEventFactory, initialSessionState, reduce } from '@rhizomorph/core'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useFocusRequest } from '../../app/panelPrefs.js'
import { StreamProvider } from '../../app/StreamContext.js'
import type { CopyText } from '../../drawer/AttachButton.js'
import { FleetProvider } from '../../fleet/FleetContext.js'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  offFenceHonestySpec,
  pathologySpec,
  specFor,
  SyntheticFleet,
  type FixtureSpec,
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

/**
 * Mounts a fixture spec that is not wired into the app's own '2'/'3' fixture
 * switcher (issue #226's `offFenceHonestySpec`, kept out of `pathologySpec` so
 * it does not disturb every other test that pins that fixture's lane count) —
 * the same event-through-a-fake-source path `renderDrillDownScenario` below
 * uses, generalised to any spec's own synthetic history and manifest.
 */
async function renderSyntheticFleet(spec: FixtureSpec) {
  const events = new SyntheticFleet(spec).history(NOW)
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
        <FleetProvider now={NOW} fetchLanes={async () => ({ ok: true, json: async () => manifestFor(spec) })}>
          <SelectionProvider>
            <FleetTable />
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>,
    )
  })
  await act(async () => {
    source?.open()
    for (const event of events) source?.emit(event)
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

/**
 * S1'S SCALE CRITERION (prd-36, #562) — "at forty lanes the list renders every
 * lane; a test asserts no lane is dropped or virtualised out of the
 * accessibility tree."
 *
 * The twenty-lane fixture above is ruling 22's scale test and it is not this
 * one. prd-36's claim is stronger and specifically about the *floor*: the list
 * is what a person is left with when the canvas will not draw, so a windowing
 * optimisation that kept forty rows readable at sixty frames a second by
 * putting thirty-two of them outside the DOM would satisfy every visual
 * impression of this panel and defeat the reason it exists. Screen readers,
 * ctrl-F and `getAllByTestId` all see the same thing here, which is the point.
 */
describe('FleetTable — forty lanes, complete (prd-36 S1)', () => {
  const FORTY = 40

  async function renderFortyLanes() {
    const fx = createEventFactory({ startTs: NOW - 10 * 60_000, stepMs: 250 })
    fx.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })
    for (let i = 0; i < FORTY; i += 1) {
      const branch = `${600 + i}-lane-${i}`
      const worktreePath = `/repo-wt/${branch}`
      fx.worktreeDiscovered({ path: worktreePath, branch, isMain: false })
      fx.llmUsage({
        lane: branch,
        branch,
        worktreePath,
        tokens: { input: 5, output: 100 + i, cacheRead: 0, cacheCreation: 0 },
      })
    }

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
  }

  it('renders all forty rows, every one of them in the accessibility tree', async () => {
    await renderFortyLanes()

    expect(rows()).toHaveLength(FORTY)
    // Distinct lanes, not forty renders of the same one.
    expect(new Set(rows().map((row) => row.getAttribute('data-lane'))).size).toBe(FORTY)
    // Every row is a real, reachable control — `role="button"` and tabbable —
    // rather than a painted stripe a keyboard cannot get to.
    for (const row of rows()) {
      expect(row.getAttribute('role')).toBe('button')
      expect(row.getAttribute('tabindex')).toBe('0')
    }
    // …and every row carries its own drill-down, so the fortieth lane is as
    // openable as the first.
    expect(screen.getAllByTestId('fleet-row-open')).toHaveLength(FORTY)
  })

  it('names no virtualisation seam at all — the structural half', async () => {
    // The mutation the assertion above cannot make: a windowing library added
    // tomorrow would render forty rows in a forty-lane test and eight in a
    // four-hundred-lane fleet, and this suite would never know. The floor is a
    // claim about the component, so it is also checked as one.
    const [{ readFileSync }, path, { fileURLToPath }] = await Promise.all([
      import('node:fs'),
      import('node:path'),
      import('node:url'),
    ])
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.tsx'),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/virtual|windowed|react-window|slice\(0,/i)
    // …and the sweep is not vacuous: the file it read is the one under test.
    expect(code).toContain('data-testid="fleet-row"')
  })

  it('renders the empty fleet as an IDLE fleet, naming the repo and its last activity', async () => {
    // The other half of S1's list pass: "no lanes" and "nothing connected" are
    // different answers, and before #562 both were a near-blank table.
    const fx = createEventFactory({ startTs: NOW - 90_000, stepMs: 1_000 })
    fx.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo', branch: 'main', isMain: true })

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

    // Before the stream opens: nothing is known, and "no lanes" would be a
    // claim the instrument has not earned.
    expect(screen.getByTestId('fleet-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('fleet-idle')).not.toBeInTheDocument()

    await act(async () => {
      source?.open()
      for (const event of fx.all()) source?.emit(event)
    })

    const idle = screen.getByTestId('fleet-idle')
    expect(idle.textContent).toContain('rhizomorph')
    expect(idle.textContent).toMatch(/last activity \d+/)
    expect(idle.textContent).toMatch(/idle fleet, not a broken one/)
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

  // Issue #226, defect 2 (voice): OFF-FENCE named no file, so the operator
  // could not tell a real breach from noise on sight. The STATE hover must
  // name the exact path, not just a count of trespasses.
  it('names the trespassed path on the OFF-FENCE hover, not merely a count', async () => {
    await renderFixture('3')

    const row = rows().find((r) => r.getAttribute('data-lane') === '45-ledger-subrows') as HTMLElement
    const stateCell = row.querySelectorAll('td')[1] as HTMLElement
    expect(stateCell.getAttribute('title')).toContain('packages/core/src/selectors/spend-subrows.ts')
  })

  // Issue #226, defect 1 (signal): a lane whose only trespass is uncommitted
  // lockfile churn must read calm — no OFF-FENCE word, no glyph for it.
  it('shows no OFF-FENCE for a lane whose only trespass is uncommitted lockfile churn', async () => {
    await renderSyntheticFleet(offFenceHonestySpec())

    const row = rows().find((r) => r.getAttribute('data-lane') === '60-lockfile-churn') as HTMLElement
    expect(row.textContent).not.toContain('OFF-FENCE')
  })

  // Issue #226, defect 3: a dead pane whose lane committed everything and left
  // a clean worktree must read done, and the hover must say which kind of
  // finish this was rather than a bare, unexplained word. No pathology here,
  // so the finish is said once — by the sigil word alone — and the separate
  // terminal-done MARK (reserved for a lane that also carries an alarm; see
  // the combined test below) must not double it up.
  it('reads a dead pane that committed clean work as done, and says which kind of finish it was', async () => {
    await renderSyntheticFleet(offFenceHonestySpec())

    const row = rows().find((r) => r.getAttribute('data-lane') === '61-pane-died-clean') as HTMLElement
    expect(row.textContent).not.toContain('FROZEN')
    expect(row.textContent).toContain('done')
    const stateCell = row.querySelectorAll('td')[1] as HTMLElement
    expect(stateCell.getAttribute('title')).toMatch(/pane likely died/)
    // Not load-bearing without this: `showsTerminalDoneMark`'s own
    // `worstPathology(lane) !== null` guard is what keeps a plain terminal-done
    // lane (no alarm at all) from rendering the mark a second time.
    expect(stateCell.querySelector('[data-testid="terminal-done-mark"]')).toBeNull()
  })

  // The gap verify caught: a lane can carry a live pathology AND be
  // terminal-done at once. The alarm sigil must not be swallowed by the
  // finish (still reads OFF-FENCE), and the finish must not be swallowed by
  // the alarm (the done mark and the hover both still say the pane is gone,
  // beside the trespassed path).
  it('shows OFF-FENCE and a done mark together for a lane that is both, and names both facts on hover', async () => {
    await renderSyntheticFleet(offFenceHonestySpec())

    const row = rows().find((r) => r.getAttribute('data-lane') === '62-pane-died-offence') as HTMLElement
    const stateCell = row.querySelectorAll('td')[1] as HTMLElement

    // The sigil word is still the alarm, never quietly replaced by done.
    const svg = stateCell.querySelector('svg[data-sigil]')
    expect(svg?.getAttribute('data-sigil')).toBe('off-fence')
    expect(stateCell.textContent).toContain('OFF-FENCE')

    // The finish still gets said, as its own mark beside the alarm word —
    // asserted by testid, not by text, since the mark's own text ("done") is
    // otherwise indistinguishable from a plain DONE sigil word.
    const mark = stateCell.querySelector('[data-testid="terminal-done-mark"]')
    expect(mark).not.toBeNull()
    expect(mark?.textContent).toBe('done')

    // And the hover carries both facts — the trespassed path and the finish.
    const title = stateCell.getAttribute('title') ?? ''
    expect(title).toContain('packages/web/src/panels/attention/churn-neighbour.ts')
    expect(title).toMatch(/pane likely died/)
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

describe('FleetTable — row drill-down (issue #159)', () => {
  const LANE_ID = '90-drilldown'
  const LANE_WORKTREE = `/repo/rhizomorph__worktrees/${LANE_ID}`

  async function renderDrillDownScenario() {
    const fx = createEventFactory({ startTs: NOW - 5 * 60_000 })
    fx.sessionStarted({ repoPath: '/repo/rhizomorph', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true })
    fx.worktreeDiscovered({ path: LANE_WORKTREE, branch: LANE_ID, isMain: false })
    fx.llmUsage({
      lane: LANE_ID,
      branch: LANE_ID,
      worktreePath: LANE_WORKTREE,
      tokens: { input: 5, output: 90, cacheRead: 0, cacheCreation: 0 },
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

    return rows().find((r) => r.getAttribute('data-lane') === LANE_ID) as HTMLElement
  }

  it('links a real lane to its own deep-linkable page, keyboard-reachable', async () => {
    const row = await renderDrillDownScenario()
    const link = row.querySelector('[data-testid="fleet-row-open"]') as HTMLElement

    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe(`/lane/${LANE_ID}`)
    expect(link.tabIndex).not.toBe(-1)
  })

  it('navigates on click without hijacking the row\'s own select-on-click', async () => {
    const row = await renderDrillDownScenario()
    window.history.replaceState(null, '', '/')
    const link = row.querySelector('[data-testid="fleet-row-open"]') as HTMLElement

    await act(async () => {
      fireEvent.click(link, { button: 0 })
    })

    expect(window.location.pathname).toBe(`/lane/${LANE_ID}`)
    // The click never reached the row's own handler — the drawer did not open.
    expect(row.getAttribute('aria-selected')).toBe('false')

    window.history.replaceState(null, '', '/')
  })

  it('leaves a plain click on the row free to select it, exactly as before', async () => {
    const row = await renderDrillDownScenario()

    await act(async () => {
      fireEvent.click(row)
    })

    expect(row.getAttribute('aria-selected')).toBe('true')
  })
})

describe('FleetTable — OUTPUT sparkline (issue #159)', () => {
  it('draws a spark once the lane has at least three honest buckets of history', async () => {
    const LANE_ID = '91-sparkline'
    const LANE_WORKTREE = `/repo/rhizomorph__worktrees/${LANE_ID}`
    const fx = createEventFactory({ startTs: NOW - 30 * 60_000 })
    fx.sessionStarted({ repoPath: '/repo/rhizomorph', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true })
    fx.worktreeDiscovered({ path: LANE_WORKTREE, branch: LANE_ID, isMain: false })
    // Three requests, well apart, so they land in three distinct 3-minute buckets.
    fx.llmUsage(
      { lane: LANE_ID, branch: LANE_ID, worktreePath: LANE_WORKTREE, tokens: { input: 1, output: 100, cacheRead: 0, cacheCreation: 0 } },
      { ts: NOW - 25 * 60_000 },
    )
    fx.llmUsage(
      { lane: LANE_ID, branch: LANE_ID, worktreePath: LANE_WORKTREE, tokens: { input: 1, output: 200, cacheRead: 0, cacheCreation: 0 } },
      { ts: NOW - 15 * 60_000 },
    )
    fx.llmUsage(
      { lane: LANE_ID, branch: LANE_ID, worktreePath: LANE_WORKTREE, tokens: { input: 1, output: 300, cacheRead: 0, cacheCreation: 0 } },
      { ts: NOW - 1_000 },
    )

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

    const row = rows().find((r) => r.getAttribute('data-lane') === LANE_ID) as HTMLElement
    const outputCell = row.querySelectorAll('td')[2] as HTMLElement
    const spark = outputCell.querySelector('svg[data-testid="sparkline"]')

    expect(spark).not.toBeNull()
    expect(spark?.getAttribute('aria-hidden')).toBe('true')
    // The real number stays the truth beside the spark, not replaced by it.
    expect(outputCell.textContent).toContain('600')
  })

  it('draws nothing for a lane too young to have three honest buckets — never a fabricated flat line', async () => {
    const LANE_ID = '92-too-young'
    const LANE_WORKTREE = `/repo/rhizomorph__worktrees/${LANE_ID}`
    const fx = createEventFactory({ startTs: NOW - 60_000 })
    fx.sessionStarted({ repoPath: '/repo/rhizomorph', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true })
    fx.worktreeDiscovered({ path: LANE_WORKTREE, branch: LANE_ID, isMain: false })
    fx.llmUsage({
      lane: LANE_ID,
      branch: LANE_ID,
      worktreePath: LANE_WORKTREE,
      tokens: { input: 1, output: 50, cacheRead: 0, cacheCreation: 0 },
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

    const row = rows().find((r) => r.getAttribute('data-lane') === LANE_ID) as HTMLElement
    const outputCell = row.querySelectorAll('td')[2] as HTMLElement

    expect(outputCell.querySelector('svg[data-testid="sparkline"]')).toBeNull()
    expect(outputCell.textContent).toContain('50')
  })
})

describe('FleetTable — gap-honest cells (law 12)', () => {
  async function renderGapScenario() {
    const fx = createEventFactory({ startTs: NOW - 5 * 60_000 })
    const laneWorktreePath = '/repo/rhizomorph__worktrees/42-gap-lane'

    fx.sessionStarted({ repoPath: '/repo/rhizomorph', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true })
    fx.worktreeDiscovered({ path: laneWorktreePath, branch: '42-gap-lane', isMain: false })
    // A declared subagent thread and a thread the source never named — the
    // honest reading is `sub` beside `unk`, never a guess at the second one.
    // `model` is pinned to an id no vendored pricing pattern covers (prd9
    // ruling 7): this scenario's whole point is "no cost feed reached the
    // lane" law 12 tests, and the real fixture default (`claude-opus-5`) is
    // now a real vendored entry that would earn a selector-side estimate —
    // an honest, different fact this describe block does not mean to cover.
    fx.llmUsage({
      lane: '42-gap-lane',
      branch: '42-gap-lane',
      worktreePath: laneWorktreePath,
      model: 'test-model-unpriced',
      thread: 'subagent',
      tokens: { input: 5, output: 120, cacheRead: 10, cacheCreation: 20 },
    })
    fx.llmUsage({
      lane: '42-gap-lane',
      branch: '42-gap-lane',
      worktreePath: laneWorktreePath,
      model: 'test-model-unpriced',
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
    const laneWorktreePath = `/repo/rhizomorph__worktrees/${PARKED_LANE}`

    fx.sessionStarted({ repoPath: '/repo/rhizomorph', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true })
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
    expect(span.className).toContain('text-(--ink-dim)')
    expect(span.className).toContain('italic')
    expect(stateCell.getAttribute('title')).toMatch(/parked/i)
  })

  it('still shows the lane\'s real output honestly — parked mutes the alarm, not the evidence', async () => {
    const row = await renderParkedScenario()
    const outputCell = row.querySelectorAll('td')[2] as HTMLElement
    expect(outputCell.textContent?.trim()).not.toBe('')
    expect(outputCell.textContent).not.toBe('—')
  })
})

describe('FleetTable — AGE / ACTIVE column (#141)', () => {
  const LANE_ID = '70-active-lane'
  const LANE_WORKTREE = `/repo/rhizomorph__worktrees/${LANE_ID}`

  async function renderActiveTimeScenario(activeSeconds?: number) {
    const fx = createEventFactory({ startTs: NOW - 5 * 60_000 })
    fx.sessionStarted({ repoPath: '/repo/rhizomorph', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true })
    fx.worktreeDiscovered({ path: LANE_WORKTREE, branch: LANE_ID, isMain: false })
    // Gives the lane a real work-age, independent of whether OTel ever
    // reaches it — otherwise this lane's age is itself unknown, and the
    // AGE/ACTIVE distinction this describe block tests would be moot.
    fx.agentStatus({ handle: LANE_ID, status: 'working', worktreePath: LANE_WORKTREE, branch: LANE_ID })
    if (activeSeconds !== undefined) {
      fx.agentActiveTime({
        lane: LANE_ID,
        branch: LANE_ID,
        worktreePath: LANE_WORKTREE,
        sessionId: `sess-${LANE_ID}`,
        activeSeconds,
      })
    }

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

    return rows().find((r) => r.getAttribute('data-lane') === LANE_ID) as HTMLElement
  }

  it('renders the combined "age / active" header', async () => {
    await renderActiveTimeScenario(300)
    expect(screen.getByText('age / active')).toBeInTheDocument()
  })

  it('shows AGE alone when no OTel active-time reading has reached the lane (law 12)', async () => {
    const row = await renderActiveTimeScenario()
    const cell = row.querySelectorAll('td')[7] as HTMLElement
    expect(cell.textContent).not.toContain('/')
    expect(cell.textContent).not.toBe('')
    expect(cell.getAttribute('title')).toMatch(/no OTel active-time reading/)
  })

  it('shows AGE / ACTIVE once OTel has reported active time for the lane', async () => {
    const row = await renderActiveTimeScenario(300)
    const cell = row.querySelectorAll('td')[7] as HTMLElement
    expect(cell.textContent).toMatch(/^.+ \/ 5m00s$/)
    expect(cell.getAttribute('title')).toMatch(/claude_code\.active_time\.total/)
  })
})

describe('FleetTable — prd5 ruling 1+6: single-key verbs (k9s idiom)', () => {
  const LANE_ID = '60-verbs-lane'
  const VERBS_WORKTREE = `/repo/rhizomorph__worktrees/${LANE_ID}`

  /**
   * Test-only witness for the `f` verb's `requestPanelFocus('fleet')` call —
   * the same `useFocusRequest` `PanelFrame` answers with in the real tree,
   * mounted here so this suite proves the request without pulling `PanelGrid`
   * and every other panel into a table test.
   */
  function FocusListener({ id, onRequest }: { id: string; onRequest: () => void }) {
    useFocusRequest(id, onRequest)
    return null
  }

  async function renderVerbsScenario(onCopy?: CopyText, focusListener?: ReactNode) {
    const fx = createEventFactory({ startTs: NOW - 5 * 60_000 })
    fx.sessionStarted({ repoPath: '/repo/rhizomorph', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true })
    fx.worktreeDiscovered({ path: VERBS_WORKTREE, branch: LANE_ID, isMain: false })
    fx.llmUsage({
      lane: LANE_ID,
      branch: LANE_ID,
      worktreePath: VERBS_WORKTREE,
      tokens: { input: 5, output: 90, cacheRead: 0, cacheCreation: 0 },
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
          <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
            <SelectionProvider>
              {focusListener}
              <FleetTable onCopy={onCopy} />
            </SelectionProvider>
          </FleetProvider>
        </StreamProvider>,
      )
    })
    await act(async () => {
      source?.open()
      for (const event of fx.all()) source?.emit(event)
    })

    return rows().find((r) => r.getAttribute('data-lane') === LANE_ID) as HTMLElement
  }

  it('renders a one-line, discoverable key hint in the footer', async () => {
    await renderVerbsScenario()

    const hint = screen.getByTestId('fleet-key-hint')
    expect(hint.textContent).toMatch(/\bn\b.*needs-you/)
    expect(hint.textContent).toMatch(/\bf\b.*focus/)
    expect(hint.textContent).toMatch(/\ba\b.*attach/)
    expect(hint.textContent).toMatch(/esc/i)
  })

  it('copies the ATTACH command for the selected lane on "a" — the drawer\'s own clipboard path', async () => {
    const onCopy = vi.fn(async () => {})
    const row = await renderVerbsScenario(onCopy)

    await act(async () => {
      fireEvent.click(row)
    })
    await act(async () => {
      fireEvent.keyDown(window, { key: 'a' })
    })

    // No tmux pane was ever discovered for this lane, so `attachPlan` (the
    // same function `AttachButton` reads) falls back to the workmux command —
    // proof this reuses that plan rather than composing its own string.
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onCopy).toHaveBeenCalledWith(`workmux open ${LANE_ID}`)
  })

  it('acts on a row focused via keyboard (Tab), even with no click-selection', async () => {
    const onCopy = vi.fn(async () => {})
    const row = await renderVerbsScenario(onCopy)

    act(() => {
      row.focus()
    })
    expect(document.activeElement).toBe(row)

    await act(async () => {
      fireEvent.keyDown(window, { key: 'a' })
    })

    expect(onCopy).toHaveBeenCalledWith(`workmux open ${LANE_ID}`)
  })

  it('does nothing on "a" when no lane row is focused or selected', async () => {
    const onCopy = vi.fn(async () => {})
    await renderVerbsScenario(onCopy)

    await act(async () => {
      fireEvent.keyDown(window, { key: 'a' })
    })

    expect(onCopy).not.toHaveBeenCalled()
  })

  it('asks the fleet FRAME to focus on "f" rather than drawing a second full view (#562)', async () => {
    // Before #562 this verb called the table's own `usePanelFocus` and the
    // table drew `fixed inset-0` itself — inside a `PanelFrame` that did not
    // know it was focused, so the grid's "one panel at a time" invariant could
    // not see it and the heading and border were drawn twice. It now goes
    // through the one focus channel, by panel id.
    const focused: string[] = []
    const row = await renderVerbsScenario(
      undefined,
      <FocusListener id="fleet" onRequest={() => focused.push('fleet')} />,
    )

    await act(async () => {
      fireEvent.click(row)
    })
    expect(focused).toEqual([])

    await act(async () => {
      fireEvent.keyDown(window, { key: 'f' })
    })
    expect(focused).toEqual(['fleet'])

    // …and the table itself does not become a full view of its own.
    expect((row.closest('section') as HTMLElement).className).not.toContain('fixed')
  })

  it('does not fire "a" while typing in an input (the standard guard)', async () => {
    const onCopy = vi.fn(async () => {})
    const row = await renderVerbsScenario(onCopy)
    await act(async () => {
      fireEvent.click(row)
    })

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    try {
      await act(async () => {
        fireEvent.keyDown(input, { key: 'a' })
      })
      expect(onCopy).not.toHaveBeenCalled()
    } finally {
      input.remove()
    }
  })
})

describe('FleetTable — git status incident mark (#606)', () => {
  const FAILING_LANE = '42-failing-lane'
  const HEALTHY_LANE = '43-healthy-lane'

  /** Parks the failing lane and nothing else, so the mark is tested against a
   *  row the operator has explicitly stood down. */
  const parkedFailingManifest: FetchLike = async () => ({
    ok: true,
    json: async () => ({
      available: true,
      version: 1,
      lanes: [
        {
          handle: FAILING_LANE,
          branch: FAILING_LANE,
          fence: ['packages/parked/**'],
          parked: true,
        },
      ],
    }),
  })

  async function renderTwoWorktreeScenario(
    extra?: (fx: ReturnType<typeof createEventFactory>) => void,
    manifest: FetchLike = noLaneManifest,
  ) {
    const fx = createEventFactory({ startTs: NOW - 5 * 60_000 })
    const failingPath = `/repo/rhizomorph__worktrees/${FAILING_LANE}`
    const healthyPath = `/repo/rhizomorph__worktrees/${HEALTHY_LANE}`

    fx.sessionStarted({ repoPath: '/repo/rhizomorph', repoName: 'rhizomorph', mainBranch: 'main' })
    fx.worktreeDiscovered({ path: '/repo/rhizomorph', branch: 'main', isMain: true })
    fx.worktreeDiscovered({ path: failingPath, branch: FAILING_LANE, isMain: false })
    fx.worktreeDiscovered({ path: healthyPath, branch: HEALTHY_LANE, isMain: false })
    fx.llmUsage({
      lane: FAILING_LANE,
      branch: FAILING_LANE,
      worktreePath: failingPath,
      tokens: { input: 5, output: 90, cacheRead: 0, cacheCreation: 0 },
    })
    fx.llmUsage({
      lane: HEALTHY_LANE,
      branch: HEALTHY_LANE,
      worktreePath: healthyPath,
      tokens: { input: 5, output: 90, cacheRead: 0, cacheCreation: 0 },
    })

    extra?.(fx)

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
          <FleetProvider now={NOW} fetchLanes={manifest}>
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

    return {
      failingRow: rows().find((r) => r.getAttribute('data-lane') === FAILING_LANE) as HTMLElement,
      healthyRow: rows().find((r) => r.getAttribute('data-lane') === HEALTHY_LANE) as HTMLElement,
    }
  }

  it('names the failing worktree\'s own row', async () => {
    const { failingRow } = await renderTwoWorktreeScenario((fx) => {
      fx.worktreeDirtyStatusFailed({
        worktreePath: `/repo/rhizomorph__worktrees/${FAILING_LANE}`,
        consecutiveFailures: 4,
        message: 'boom',
      })
    })
    expect(
      within(failingRow).getByRole('status', { name: `${FAILING_LANE}: git status failing` }),
    ).toBeDefined()
  })

  it('a healthy worktree\'s row carries no mark', async () => {
    const { healthyRow } = await renderTwoWorktreeScenario((fx) => {
      fx.worktreeDirtyStatusFailed({
        worktreePath: `/repo/rhizomorph__worktrees/${FAILING_LANE}`,
        consecutiveFailures: 4,
        message: 'boom',
      })
    })
    expect(within(healthyRow).queryByRole('status', { name: /git status failing/ })).toBeNull()
  })

  it('only the failing worktree\'s row shows it — the sibling is untouched', async () => {
    const { failingRow, healthyRow } = await renderTwoWorktreeScenario((fx) => {
      fx.worktreeDirtyStatusFailed({
        worktreePath: `/repo/rhizomorph__worktrees/${FAILING_LANE}`,
        consecutiveFailures: 4,
        message: 'boom',
      })
    })
    expect(
      within(failingRow).getByRole('status', { name: `${FAILING_LANE}: git status failing` }),
    ).toBeDefined()
    expect(within(healthyRow).queryByRole('status', { name: /git status failing/ })).toBeNull()
  })

  it('repeated failures still show exactly one mark, not one per event', async () => {
    const { failingRow } = await renderTwoWorktreeScenario((fx) => {
      const failingPath = `/repo/rhizomorph__worktrees/${FAILING_LANE}`
      fx.worktreeDirtyStatusFailed({ worktreePath: failingPath, consecutiveFailures: 4, message: 'boom' })
      fx.worktreeDirtyStatusFailed({ worktreePath: failingPath, consecutiveFailures: 5, message: 'boom again' })
    })
    expect(
      within(failingRow).getAllByRole('status', { name: `${FAILING_LANE}: git status failing` }),
    ).toHaveLength(1)
  })

  it('recovery removes the mark', async () => {
    const { failingRow } = await renderTwoWorktreeScenario((fx) => {
      const failingPath = `/repo/rhizomorph__worktrees/${FAILING_LANE}`
      fx.worktreeDirtyStatusFailed({ worktreePath: failingPath, consecutiveFailures: 4, message: 'boom' })
      fx.worktreeDirtyStatusRecovered({ worktreePath: failingPath })
    })
    expect(within(failingRow).queryByRole('status', { name: /git status failing/ })).toBeNull()
  })

  it('survives an unrelated worktree.dirty update', async () => {
    const { failingRow } = await renderTwoWorktreeScenario((fx) => {
      const failingPath = `/repo/rhizomorph__worktrees/${FAILING_LANE}`
      fx.worktreeDirtyStatusFailed({ worktreePath: failingPath, consecutiveFailures: 4, message: 'boom' })
      fx.worktreeDirty({
        path: failingPath,
        branch: FAILING_LANE,
        files: [{ path: 'src/x.ts', status: 'modified' }],
      })
    })
    expect(
      within(failingRow).getByRole('status', { name: `${FAILING_LANE}: git status failing` }),
    ).toBeDefined()
  })

  // The title is the only surface that voices `Lane.dirtyStatusFailedForMs` and
  // the only place the "no message is retained" gap is stated. Asserting the
  // whole string is deliberate: querying by role and accessible name alone left
  // `gitStatusIncidentTitle` free to return '' with the suite still green.
  it('titles the mark with the worktree, how long the incident has been open, and the gap it cannot fill', async () => {
    const { failingRow } = await renderTwoWorktreeScenario((fx) => {
      fx.worktreeDirtyStatusFailed(
        {
          worktreePath: `/repo/rhizomorph__worktrees/${FAILING_LANE}`,
          consecutiveFailures: 4,
          message: 'boom',
        },
        // Pinned rather than left on the factory clock, so the rendered span is
        // an exact string and not a shape the assertion has to guess at.
        { ts: NOW - 90_000 },
      )
    })
    const mark = within(failingRow).getByRole('status', {
      name: `${FAILING_LANE}: git status failing`,
    })
    expect(mark.getAttribute('title')).toBe(
      `${FAILING_LANE}: git status --porcelain has failed repeatedly for 1m30s` +
        ` — the underlying error is not retained in-app; check the server's own log`,
    )
  })

  // ADR-0022's boundary, at the render layer: parking is the operator muting an
  // *inference*, and this is a recorded fact about the worktree. Without this,
  // gating the mark on `!lane.parked` — the exact regression the docstring on
  // `showsGitStatusIncidentMark` forbids — passes the whole suite.
  it('still marks a parked lane — parking mutes an inferred alarm, never a recorded fact', async () => {
    const { failingRow } = await renderTwoWorktreeScenario(
      (fx) => {
        fx.worktreeDirtyStatusFailed({
          worktreePath: `/repo/rhizomorph__worktrees/${FAILING_LANE}`,
          consecutiveFailures: 4,
          message: 'boom',
        })
      },
      parkedFailingManifest,
    )
    // The row really is parked — otherwise the assertion below proves nothing.
    expect((failingRow.querySelectorAll('td')[1] as HTMLElement).textContent).toContain('PARKED')
    expect(
      within(failingRow).getByRole('status', { name: `${FAILING_LANE}: git status failing` }),
    ).toBeDefined()
  })
})
