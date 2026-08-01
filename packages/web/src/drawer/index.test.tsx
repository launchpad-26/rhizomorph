import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createEventFactory,
  initialSessionState,
  reduce,
  type ObservatoryEvent,
} from '@observatory/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { StreamProvider } from '../app/StreamContext.js'
import { FleetProvider } from '../fleet/FleetContext.js'
import {
  buildFleet,
  fixtureHistory,
  manifestFor,
  pathologySpec,
  specFor,
  SyntheticFleet,
} from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { SelectionProvider } from '../fleet/selection.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { costCellText, outputCellText } from '../panels/fleet/format.js'
import LaneDrawer from './index.js'

afterEach(cleanup)

/** Pinned, so the fixture, the derived fleet and every age string are still. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

const LANE = '84-chat-drawer'
const WORKTREE = '/repo-wt/84-chat-drawer'

/**
 * The staged-pathology fixture is built once here rather than inside a test,
 * for the same reason #78 does it: its ~8,000-event history must not be
 * charged to a 5s per-test timeout on a busy box (ruling 33).
 */
beforeAll(() => {
  fixtureHistory(pathologySpec(), NOW)
})

const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

class ScriptedEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/** One lane's whole life, close enough to `NOW` that it reads as working. */
function laneHistory(): ObservatoryEvent[] {
  const f = createEventFactory({ startTs: NOW - 40_000, stepMs: 2_000 })
  return [
    f.sessionStarted({ repoPath: '/repo', repoName: 'observatory', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false }),
    f.paneDiscovered({
      paneId: '%7',
      sessionName: 'observatory',
      windowName: LANE,
      windowIndex: 3,
      currentPath: WORKTREE,
      worktreePath: WORKTREE,
    }),
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'sess-84',
      thread: 'main',
      tokens: { input: 10, output: 4_200, cacheRead: 90_000, cacheCreation: 1_000 },
    }),
    f.toolActivity({ lane: LANE, branch: LANE, worktreePath: WORKTREE, sessionId: 'sess-84', tool: 'Read' }),
    f.toolActivity({ lane: LANE, branch: LANE, worktreePath: WORKTREE, sessionId: 'sess-84', tool: 'Read' }),
    f.toolActivity({ lane: LANE, branch: LANE, worktreePath: WORKTREE, sessionId: 'sess-84', tool: 'Write' }),
    f.worktreeDirty({ path: WORKTREE, branch: LANE, files: [{ path: 'packages/web/src/drawer/index.tsx', status: 'added' }] }),
    f.commitLanded({
      branch: LANE,
      sha: 'abc1234def5678',
      message: 'feat(drawer): the lane drawer\n\nbody',
      files: [{ path: 'packages/web/src/drawer/index.tsx', status: 'added' }],
      insertions: 90,
      deletions: 0,
      worktreePath: WORKTREE,
    }),
  ]
}

interface HarnessOptions {
  events?: ObservatoryEvent[]
  selected?: string | null
  fetchTranscript?: FetchLike
  onCopy?: (text: string) => Promise<void>
  transcriptExpanded?: boolean
}

async function renderDrawer(options: HarnessOptions = {}) {
  const events = options.events ?? laneHistory()
  let source: ScriptedEventSource | null = null

  const result = render(
    <StreamProvider
      url="/api/stream"
      now={NOW}
      createSource={() => {
        source = new ScriptedEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <SelectionProvider initialSelectedId={options.selected === undefined ? LANE : options.selected}>
          <LaneDrawer
            fetchTranscript={options.fetchTranscript}
            transcriptPollMs={0}
            transcriptExpanded={options.transcriptExpanded}
            onCopy={options.onCopy}
          />
        </SelectionProvider>
      </FleetProvider>
    </StreamProvider>,
  )

  await act(async () => {
    source?.onopen?.(new Event('open'))
    for (const event of events) {
      source?.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
    }
  })

  return result
}

/** The same derivation `FleetProvider` performs for the fixture, computed independently. */
function expectedFixtureFleet() {
  const spec = specFor('pathology')
  const events = new SyntheticFleet(spec).history(NOW)
  return buildFleet(events.reduce(reduce, initialSessionState()), {
    now: NOW,
    manifest: manifestFor(spec),
  })
}

/**
 * The drawer over the staged-pathology fixture, driven the way the app itself
 * switches logs (key `3`). That path folds the fixture's ~8,000 events in one
 * batch inside `StreamProvider`, where pushing them through the SSE seam one at
 * a time would re-copy the event array per event — a quadratic cost this suite
 * must not carry under load (ruling 33).
 */
async function renderFixtureDrawer(laneId: string) {
  render(
    <StreamProvider url="/api/stream" now={NOW} createSource={() => new ScriptedEventSource()}>
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <SelectionProvider initialSelectedId={laneId}>
          <LaneDrawer transcriptPollMs={0} />
        </SelectionProvider>
      </FleetProvider>
    </StreamProvider>,
  )
  await act(async () => {
    fireEvent.keyDown(window, { key: '3' })
  })
}

describe('LaneDrawer — opening and closing from the one selection', () => {
  it('renders nothing at all when no lane is selected', async () => {
    await renderDrawer({ selected: null })

    expect(screen.queryByTestId('lane-drawer')).toBeNull()
  })

  it('opens on the selected lane', async () => {
    await renderDrawer()

    const drawer = screen.getByTestId('lane-drawer')
    expect(drawer.getAttribute('data-lane')).toBe(LANE)
    expect(drawer.textContent).toContain(LANE)
  })

  it('closes on Esc, and the selection clears with it', async () => {
    await renderDrawer()
    expect(screen.getByTestId('lane-drawer')).toBeTruthy()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(screen.queryByTestId('lane-drawer')).toBeNull()
  })

  it('closes on the close button', async () => {
    await renderDrawer()

    await act(async () => {
      fireEvent.click(screen.getByTestId('drawer-close'))
    })

    expect(screen.queryByTestId('lane-drawer')).toBeNull()
  })

  it('says so, loudly, when the selected lane is not in the fleet', async () => {
    await renderDrawer({ selected: 'a-lane-that-never-was' })

    expect(screen.getByTestId('drawer-unknown-lane').textContent).toContain('LANE GONE')
    expect(screen.queryByTestId('drawer-vitals')).toBeNull()
  })
})

describe('LaneDrawer — vitals', () => {
  it('shows the state glyph, its word and the evidence string', async () => {
    await renderDrawer()

    const vitals = screen.getByTestId('drawer-vitals')
    expect(vitals.querySelector('svg[data-sigil]')).toBeTruthy()
    expect(vitals.textContent).toContain('working')
    expect(screen.getByTestId('drawer-evidence').textContent).toContain('req')
  })

  it('shows output, $, age, branch and fence', async () => {
    await renderDrawer()
    const vitals = screen.getByTestId('drawer-vitals')

    for (const label of ['output', '$', 'age', 'branch', 'fence']) {
      expect([...vitals.querySelectorAll('dt')].map((dt) => dt.textContent)).toContain(label)
    }
    expect(vitals.textContent).toContain(LANE)
  })

  it('renders the $ cell as a gap, not a zero, when no cost feed reached the lane', async () => {
    await renderDrawer()

    const cost = [...screen.getByTestId('drawer-vitals').querySelectorAll('div')].find(
      (cell) => cell.querySelector('dt')?.textContent === '$',
    )
    expect(cost?.querySelector('dd')?.textContent).toBe('—')
    expect(cost?.getAttribute('title')).toMatch(/cost/i)
  })

  it('reports the fixture lane\'s vitals exactly as the derived fleet does', async () => {
    // The WAITING lane of the staged-pathology fixture — a real detector call,
    // not a hand-built one.
    const lane = expectedFixtureFleet().lanes.find((l) => l.id === '43-drawer-attach')
    expect(lane, 'the staged fixture must still carry 43-drawer-attach').toBeDefined()
    if (!lane) return

    await renderFixtureDrawer(lane.id)

    const vitals = screen.getByTestId('drawer-vitals')
    expect(vitals.querySelector('svg[data-sigil]')?.getAttribute('data-sigil')).toBe('waiting')
    expect(vitals.textContent).toContain('WAITING')
    expect(vitals.textContent).toContain(outputCellText(lane))
    expect(vitals.textContent).toContain(costCellText(lane))
    expect(screen.getByTestId('drawer-evidence').textContent).toBe(
      lane.pathologies[0]?.inferred
        ? `~ ${lane.pathologies[0]?.evidence}`
        : (lane.pathologies[0]?.evidence ?? ''),
    )
  })
})

describe('LaneDrawer — the activity view (the default reading)', () => {
  it('folds the three kinds out of the lane\'s own events, newest first', async () => {
    await renderDrawer()

    const kinds = [...screen.getAllByTestId('activity-entry')].map((li) => li.getAttribute('data-kind'))
    expect(kinds).toEqual(['commit', 'file', 'tool', 'tool'])
  })

  it('coalesces the repeated tool call and shows the count', async () => {
    await renderDrawer()

    const entries = screen.getAllByTestId('activity-entry')
    const read = entries.find((li) => li.textContent?.includes('Read'))
    expect(read?.textContent).toContain('×2')
  })

  it('names the commit and the file it touched', async () => {
    await renderDrawer()

    const text = screen.getByTestId('drawer-activity').textContent ?? ''
    expect(text).toContain('abc1234')
    expect(text).toContain('feat(drawer): the lane drawer')
    expect(text).toContain('packages/web/src/drawer/index.tsx')
  })

  it('is above the transcript — the ruling\'s ordering, structurally', async () => {
    await renderDrawer()

    const drawer = screen.getByTestId('lane-drawer')
    const order = [...drawer.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'))
    expect(order.indexOf('drawer-vitals')).toBeLessThan(order.indexOf('drawer-activity'))
    expect(order.indexOf('drawer-activity')).toBeLessThan(order.indexOf('drawer-transcript'))
  })
})

describe('LaneDrawer — the transcript tail', () => {
  it('reads the lane\'s transcript from the server when expanded', async () => {
    const urls: string[] = []
    const fetchTranscript: FetchLike = async (input) => {
      urls.push(input)
      return {
        ok: true,
        json: async () => ({
          available: true,
          lane: LANE,
          sessionId: 'sess-84',
          offset: 0,
          nextOffset: 20,
          size: 20,
          eof: true,
          restarted: false,
          text: '▌ assistant\nreading\n\n',
        }),
      }
    }

    await renderDrawer({ fetchTranscript, transcriptExpanded: true })

    expect(urls).toEqual([`/api/transcript/${LANE}?offset=0`])
    expect(screen.getByTestId('transcript-body').textContent).toContain('reading')
  })
})

describe('LaneDrawer — ATTACH (it copies, it never executes)', () => {
  it('copies the exact tmux command when the lane\'s pane is on record', async () => {
    const copied: string[] = []
    await renderDrawer({ onCopy: async (text) => void copied.push(text) })

    expect(screen.getByTestId('attach-command').textContent).toBe(
      'tmux attach -t observatory \\; select-window -t 3',
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('attach-copy'))
    })

    expect(copied).toEqual(['tmux attach -t observatory \\; select-window -t 3'])
    expect(screen.getByTestId('drawer-attach').textContent).toContain('copied to clipboard')
  })

  it('copies the workmux equivalent when no tmux identity is known', async () => {
    const withoutPane = laneHistory().filter((event) => event.type !== 'pane.discovered')
    const copied: string[] = []

    await renderDrawer({ events: withoutPane, onCopy: async (text) => void copied.push(text) })

    expect(screen.getByTestId('attach-command').textContent).toBe(`workmux open ${LANE}`)

    await act(async () => {
      fireEvent.click(screen.getByTestId('attach-copy'))
    })

    expect(copied).toEqual([`workmux open ${LANE}`])
  })

  it('shows the command anyway, and says so, when the clipboard refuses', async () => {
    await renderDrawer({ onCopy: async () => Promise.reject(new Error('no clipboard')) })

    await act(async () => {
      fireEvent.click(screen.getByTestId('attach-copy'))
    })

    expect(screen.getByTestId('drawer-attach').textContent).toContain('clipboard unavailable')
    expect(screen.getByTestId('attach-command').textContent).toContain('tmux attach')
  })

  it('makes no request of any kind when it is pressed — copying is all it does', async () => {
    const requests: string[] = []
    const fetchTranscript: FetchLike = async (input) => {
      requests.push(input)
      return { ok: false, json: async () => ({ available: false, lane: LANE, reason: 'none' }) }
    }

    await renderDrawer({ fetchTranscript, onCopy: async () => {} })
    const before = requests.length

    await act(async () => {
      fireEvent.click(screen.getByTestId('attach-copy'))
    })

    expect(requests).toHaveLength(before)
  })
})
