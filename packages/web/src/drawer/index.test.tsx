import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createEventFactory,
  fixtureTraceSpans,
  initialSessionState,
  reduce,
  type RhizomorphEvent,
} from '@rhizomorph/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { requestPanelFocus } from '../app/panelPrefs.js'
import { StreamProvider } from '../app/StreamContext.js'
import { FleetProvider } from '../fleet/FleetContext.js'
import {
  buildFleet,
  fixtureHistory,
  MAIN_SELECTION,
  manifestFor,
  pathologySpec,
  specFor,
  SyntheticFleet,
  useSelection,
} from '../fleet/index.js'
import type { FetchLike } from '../fleet/manifest.js'
import { SelectionProvider } from '../fleet/selection.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import { formatTokens } from '../lib/format.js'
import {
  formatDollarsOrGap,
  formatOverheadOrGap,
  outputHoverTitle,
} from '../panels/burn/format.js'
import { costCellText, outputCellText } from '../panels/fleet/format.js'
import LaneDrawer from './index.js'
import type { TabId } from './Tabs.js'

afterEach(cleanup)

/** Switches the drawer's own active tab by clicking the tab bar — the same path a mouse takes. */
async function openTab(id: TabId): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`drawer-tab-${id}`))
  })
}

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
function laneHistory(): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: NOW - 40_000, stepMs: 2_000 })
  return [
    f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false }),
    f.paneDiscovered({
      paneId: '%7',
      sessionName: 'rhizomorph',
      windowName: LANE,
      windowIndex: 3,
      currentPath: WORKTREE,
      worktreePath: WORKTREE,
    }),
    // `model` is pinned to an id no vendored pricing pattern covers (prd9
    // ruling 7): this fixture's `$` cell means "no cost feed reached the
    // lane" (law 12), and the real default model (`claude-opus-5`) is now a
    // real vendored entry that would earn a selector-side estimate instead.
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'sess-84',
      model: 'test-model-unpriced',
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

/**
 * The conversation is the drawer's default view now (prd4 ruling 4), so every
 * mount reads the transcript. A test that is about the vitals or the ledger
 * still has to answer that read, and it answers with an honest absence rather
 * than letting the real `fetch` reach for a server that is not there.
 */
const noTranscript: FetchLike = async () => ({
  ok: false,
  json: async () => ({
    available: false,
    lane: LANE,
    reason: 'NO SESSION LOG for this fixture — no session log was written for it — run: `rhizomorph doctor`',
  }),
})

interface HarnessOptions {
  events?: RhizomorphEvent[]
  selected?: string | null
  fetchTranscript?: FetchLike
  onCopy?: (text: string) => Promise<void>
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
            fetchTranscript={options.fetchTranscript ?? noTranscript}
            transcriptPollMs={0}
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
          <LaneDrawer transcriptPollMs={0} fetchTranscript={noTranscript} />
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

describe('LaneDrawer — the open-page affordance (prd9 B1b, #135)', () => {
  it('links a real lane to its own deep-linkable page', async () => {
    await renderDrawer()

    const link = screen.getByTestId('drawer-open-page')
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe(`/lane/${LANE}`)
  })

  it('navigates the SPA in place on a plain click, rather than reloading', async () => {
    await renderDrawer()
    window.history.replaceState(null, '', '/')

    await act(async () => {
      fireEvent.click(screen.getByTestId('drawer-open-page'), { button: 0 })
    })

    expect(window.location.pathname).toBe(`/lane/${LANE}`)
    // The drawer is untouched by this click — it is a navigation, not a close.
    expect(screen.getByTestId('lane-drawer')).toBeTruthy()

    window.history.replaceState(null, '', '/')
  })

  it('offers no such link for MAIN — the conductor is not a lane the page answers to', async () => {
    await renderDrawer({ selected: MAIN_SELECTION, events: laneHistory() })

    expect(screen.queryByTestId('drawer-open-page')).toBeNull()
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

describe('LaneDrawer — the activity view, in its own tab', () => {
  it('folds the three kinds out of the lane\'s own events, newest first', async () => {
    await renderDrawer()
    await openTab('activity')

    const kinds = [...screen.getAllByTestId('activity-entry')].map((li) => li.getAttribute('data-kind'))
    expect(kinds).toEqual(['commit', 'file', 'tool', 'tool'])
  })

  it('coalesces the repeated tool call and shows the count', async () => {
    await renderDrawer()
    await openTab('activity')

    const entries = screen.getAllByTestId('activity-entry')
    const read = entries.find((li) => li.textContent?.includes('Read'))
    expect(read?.textContent).toContain('×2')
  })

  it('names the commit and the file it touched', async () => {
    await renderDrawer()
    await openTab('activity')

    const text = screen.getByTestId('drawer-activity').textContent ?? ''
    expect(text).toContain('abc1234')
    expect(text).toContain('feat(drawer): the lane drawer')
    expect(text).toContain('packages/web/src/drawer/index.tsx')
  })

  it('is not mounted at all until its tab is selected — only one body renders at a time', async () => {
    await renderDrawer()

    expect(screen.queryByTestId('drawer-activity')).toBeNull()

    await openTab('activity')
    expect(screen.getByTestId('drawer-activity')).toBeTruthy()
    expect(screen.queryByTestId('drawer-conversation')).toBeNull()
  })
})

/**
 * #151/#163 REGRESSION COVERAGE — one flow column, one scroll region.
 *
 * jsdom has no layout engine, so none of this can *prove* the drawer reads
 * right in a real window; it can only prove the DOM shape a browser lays out
 * never invites the old overlap (#151) or the old fixed-height-claims-more-
 * than-the-viewport crush (#163) in the first place. The gate's browser check
 * is the actual proof.
 */
describe('LaneDrawer — one flow column, one scroll region (#151, #163)', () => {
  it('every top-level section is a plain flow sibling — none pulled out of flow to stack on another', async () => {
    await renderDrawer({ events: [...laneHistory(), ...fixtureTraceSpans({ lane: LANE, sessionId: 'sess-84' })] })

    const drawer = screen.getByTestId('lane-drawer')
    const children = [...drawer.children]
    // header + vitals + tab bar + the active tab's panel + attach.
    expect(children.length).toBeGreaterThanOrEqual(5)
    for (const child of children) {
      const el = child as HTMLElement
      expect(el.className).not.toMatch(/(?:^|\s)(?:absolute|fixed)(?:\s|$)/)
      expect(el.style.position).not.toBe('absolute')
      expect(el.style.position).not.toBe('fixed')
    }
  })

  it('the conversation section is a clip boundary, not just a shrinkable one — #151 root cause', async () => {
    await renderDrawer()

    const section = screen.getByTestId('drawer-conversation')
    expect(section.className).toContain('min-h-0')
    expect(section.className).toContain('flex-1')
    expect(section.className).toContain('overflow-hidden')
  })

  it('the conversation body is the classic bounded-scroll pattern — a min-h-0 flex child with its own overflow-y-auto', async () => {
    const fetchTranscript: FetchLike = async () => ({
      ok: true,
      json: async () => ({
        available: true,
        lane: LANE,
        sessionId: 'sess-84',
        offset: 0,
        nextOffset: 40,
        size: 40,
        eof: true,
        restarted: false,
        entries: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }],
      }),
    })
    await renderDrawer({ fetchTranscript })

    const body = screen.getByTestId('conversation-body')
    expect(body.className).toContain('min-h-0')
    expect(body.className).toContain('flex-1')
    expect(body.className).toContain('overflow-y-auto')
    // The old floor (`min-h-32`) is exactly what let this box outgrow a
    // squeezed section: never reintroduce a positive min-height here.
    expect(body.className).not.toMatch(/min-h-(?!0\b)\d/)
  })

  it('ACTIVITY, WHY and TRACE carry no self max-height or self overflow-auto — the tab body is the drawer\'s one scroll region (#163)', async () => {
    await renderDrawer({ events: [...laneHistory(), ...fixtureTraceSpans({ lane: LANE, sessionId: 'sess-84' })] })

    for (const tab of ['activity', 'why', 'trace'] as const) {
      await openTab(tab)
      const testId = tab === 'activity' ? 'drawer-activity' : tab === 'why' ? 'why-surface' : 'drawer-trace'
      const el = screen.getByTestId(testId)
      expect(el.className).not.toMatch(/max-h-\d+/)
      expect(el.className).not.toContain('overflow-auto')
      // Each fills the tab body the same way CONVERSATION always has.
      expect(el.className).toContain('flex-1')
      expect(el.className).toContain('min-h-0')
    }
  })

  it('each tab body owns exactly one overflow-y-auto region', async () => {
    const fetchTranscript: FetchLike = async () => ({
      ok: true,
      json: async () => ({
        available: true,
        lane: LANE,
        sessionId: 'sess-84',
        offset: 0,
        nextOffset: 10,
        size: 10,
        eof: true,
        restarted: false,
        entries: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }],
      }),
    })
    await renderDrawer({
      events: [...laneHistory(), ...fixtureTraceSpans({ lane: LANE, sessionId: 'sess-84' })],
      fetchTranscript,
    })

    for (const tab of ['conversation', 'activity', 'why', 'trace'] as const) {
      await openTab(tab)
      const panel = document.getElementById('drawer-tabpanel-' + tab)
      expect(panel).toBeTruthy()
      const scrollers = panel!.querySelectorAll('.overflow-y-auto')
      expect(scrollers.length).toBe(1)
    }
  })
})

describe('LaneDrawer — the tab bar (#163)', () => {
  it('renders the four tabs, in order, CONVERSATION first and active by default', async () => {
    await renderDrawer()

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('data-testid'))).toEqual([
      'drawer-tab-conversation',
      'drawer-tab-activity',
      'drawer-tab-why',
      'drawer-tab-trace',
    ])
    expect(screen.getByTestId('drawer-tab-conversation').getAttribute('aria-selected')).toBe('true')
  })

  it('carries counts on ACTIVITY and WHY, the honest gap on TRACE when the lane has produced none', async () => {
    await renderDrawer()

    // laneHistory() folds to 4 activity entries and one commit-landed file
    // touch (index.tsx) — no trace.span events at all, so TRACE reads the gap.
    expect(screen.getByTestId('drawer-tab-activity').textContent).toContain('4')
    expect(screen.getByTestId('drawer-tab-why').textContent).toContain('1 file')
    expect(screen.getByTestId('drawer-tab-trace').textContent).toContain('—')
  })

  it('reads the honest gap on WHY too, for a lane that has touched nothing', async () => {
    const f = createEventFactory({ startTs: NOW - 10_000, stepMs: 1_000 })
    await renderDrawer({
      events: [
        f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
        f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
        f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false }),
        // A registered handle, so this is the "zero touches" gap, not the
        // "spans more than one handle" gap — the same distinction
        // `WhySurface.test.tsx` draws at the component level.
        f.llmUsage({
          lane: LANE,
          branch: LANE,
          worktreePath: WORKTREE,
          sessionId: 'sess-84',
          model: 'test-model-unpriced',
          tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
        }),
      ],
    })

    expect(screen.getByTestId('drawer-tab-why').textContent).toContain('—')
  })

  it('clicking a tab shows only that tab\'s body', async () => {
    await renderDrawer()
    await openTab('why')

    expect(screen.getByTestId('drawer-tab-why').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('why-surface')).toBeTruthy()
    expect(screen.queryByTestId('drawer-conversation')).toBeNull()
    expect(screen.queryByTestId('drawer-activity')).toBeNull()
    expect(screen.queryByTestId('drawer-trace')).toBeNull()
  })

  it('ArrowRight/ArrowLeft cycle the active tab, wrapping at either end', async () => {
    await renderDrawer()

    const conversationTab = screen.getByTestId('drawer-tab-conversation')
    conversationTab.focus()

    await act(async () => {
      fireEvent.keyDown(conversationTab, { key: 'ArrowRight' })
    })
    expect(screen.getByTestId('drawer-tab-activity').getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByTestId('drawer-tab-activity'))

    // Wraps forward past TRACE, back to CONVERSATION.
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('drawer-tab-activity'), { key: 'ArrowRight' })
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('drawer-tab-why'), { key: 'ArrowRight' })
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('drawer-tab-trace'), { key: 'ArrowRight' })
    })
    expect(screen.getByTestId('drawer-tab-conversation').getAttribute('aria-selected')).toBe('true')

    // And wraps backward past CONVERSATION, to TRACE.
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('drawer-tab-conversation'), { key: 'ArrowLeft' })
    })
    expect(screen.getByTestId('drawer-tab-trace').getAttribute('aria-selected')).toBe('true')
  })

  it('Esc still closes the drawer even with the tab bar focused — the tab bar does not eat the keystroke', async () => {
    await renderDrawer()
    screen.getByTestId('drawer-tab-conversation').focus()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(screen.queryByTestId('lane-drawer')).toBeNull()
  })

  it('is w-[min(48rem,92vw)] — widened from the pre-#163 34rem to use a single full-height section\'s own room', async () => {
    await renderDrawer()

    expect(screen.getByTestId('lane-drawer').className).toContain('w-[min(48rem,92vw)]')
  })
})

describe('LaneDrawer — the WHY surface (prd11 ruling 5)', () => {
  /**
   * A tool call and a commit naming the same file, plus a trace span sharing
   * the tool call's `toolUseId` — the DoD's "fixture session with tool
   * activity + commits renders the chain", not just the honest empty state.
   */
  function whyHistory(): RhizomorphEvent[] {
    const f = createEventFactory({ startTs: NOW - 40_000, stepMs: 2_000 })
    return [
      f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
      f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
      f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false }),
      f.toolActivity({
        lane: LANE,
        branch: LANE,
        worktreePath: WORKTREE,
        sessionId: 'sess-84',
        tool: 'Edit',
        filePath: 'packages/web/src/drawer/index.tsx',
        toolUseId: 'toolu_why_1',
      }),
      f.traceSpan({
        lane: LANE,
        sessionId: 'sess-84',
        traceId: 'trace-why-1',
        spanId: 'span-why-1',
        kind: 'tool',
        name: 'claude_code.tool',
        toolName: 'Edit',
        toolUseId: 'toolu_why_1',
      }),
      // A `worktree.dirty` snapshot too, so ACTIVITY's own fold (which reads
      // this event, not `commit.landed`, for its `file` kind) has an entry for
      // the same path — the WHY→ACTIVITY jump test below needs one to mark.
      f.worktreeDirty({
        path: WORKTREE,
        branch: LANE,
        files: [{ path: 'packages/web/src/drawer/index.tsx', status: 'modified' }],
      }),
      f.commitLanded({
        branch: LANE,
        sha: 'abc1234def5678',
        message: 'feat(drawer): the lane drawer',
        files: [{ path: 'packages/web/src/drawer/index.tsx', status: 'added' }],
        insertions: 90,
        deletions: 0,
        worktreePath: WORKTREE,
      }),
    ]
  }

  it('renders the chain — the tool call joined to its span, and the commit that landed the file', async () => {
    await renderDrawer({ events: whyHistory() })
    await openTab('why')

    expect(screen.getByTestId('why-surface')).toBeTruthy()
    expect(screen.getByTestId('why-tool-call').textContent).toContain('Edit')
    expect(screen.getByTestId('trace-kind').getAttribute('data-kind')).toBe('tool')
    expect(screen.getByTestId('why-commit').textContent).toContain('abc1234')
    expect(screen.queryByTestId('why-gap')).toBeNull()
  })

  it('is reachable from its own tab, alongside CONVERSATION, ACTIVITY and TRACE — the tab bar is the ordering now', async () => {
    await renderDrawer({ events: whyHistory() })

    const order = screen.getAllByRole('tab').map((tab) => tab.getAttribute('data-testid'))
    expect(order).toEqual([
      'drawer-tab-conversation',
      'drawer-tab-activity',
      'drawer-tab-why',
      'drawer-tab-trace',
    ])
  })

  /**
   * CAUSALITY SURVIVES TABBING (#163) — the named cost of moving off one flow
   * column was losing the side-by-side view of a commit and its own WHY
   * chain. `onJumpToActivity` pays it back: the active file's own "activity
   * ↗" switches the drawer to ACTIVITY with that exact file scrolled to and
   * marked, never hidden behind a filter (`Activity.tsx` keeps its
   * deliberate no-filter-chips rule).
   */
  it('a file\'s "activity ↗" jumps to ACTIVITY, scoped to that file', async () => {
    await renderDrawer({ events: whyHistory() })
    await openTab('why')

    await act(async () => {
      fireEvent.click(screen.getByTestId('why-open-in-activity'))
    })

    expect(screen.getByTestId('drawer-tab-activity').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('drawer-activity')).toBeTruthy()
    const marked = screen
      .getAllByTestId('activity-entry')
      .find((li) => li.getAttribute('data-highlighted') === 'true')
    expect(marked, 'no activity entry was marked by the WHY jump').toBeDefined()
    expect(marked?.textContent).toContain('packages/web/src/drawer/index.tsx')
  })
})

describe('LaneDrawer — the trace section (prd9 B1a)', () => {
  it('renders the lane\'s span tree in its own tab', async () => {
    const events = [...laneHistory(), ...fixtureTraceSpans({ lane: LANE, sessionId: 'sess-84' })]
    await renderDrawer({ events })
    await openTab('trace')

    const trace = screen.getByTestId('drawer-trace')
    expect(trace.querySelector('[data-testid="trace-tree"]')).toBeTruthy()

    fireEvent.click(screen.getByTestId('trace-interaction-toggle'))
    expect(screen.getAllByTestId('trace-row').length).toBeGreaterThan(0)
  })

  it('is the honest gap when the lane has produced no trace telemetry', async () => {
    await renderDrawer() // `laneHistory()` alone carries no `trace.span` events.
    await openTab('trace')

    const trace = screen.getByTestId('drawer-trace')
    expect(trace.textContent).toContain('no trace telemetry from this lane')
    expect(trace.textContent).toContain('docs/telemetry.md')
  })

  /**
   * #159's OWN JUMP, LANDING ON ITS TARGET TAB (#163) — the ledger's exemplar
   * jump does exactly `select(laneId)` then `requestPanelFocus('trace')`
   * (`panels/ledger/index.tsx`'s `ExemplarJumpButton`, unmodified by this
   * issue's fence). This drawer now listens on that same channel
   * (`useFocusRequest('trace', …)`) and switches its own active tab, so the
   * jump still lands where it always did — it no longer has to, since every
   * section used to be visible at once, but tabbing must not silently drop it.
   */
  it('a requestPanelFocus("trace") call switches the drawer to its own TRACE tab', async () => {
    await renderDrawer()
    expect(screen.getByTestId('drawer-tab-conversation').getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      requestPanelFocus('trace')
    })

    expect(screen.getByTestId('drawer-tab-trace').getAttribute('aria-selected')).toBe('true')
  })

  it('the exemplar jump\'s own sequence — select a lane, then request trace focus, in the same handler — still lands on TRACE, not the fresh lane\'s CONVERSATION default', async () => {
    const OTHER_LANE = 'other-lane'
    const OTHER_WORKTREE = '/repo-wt/other-lane'

    function twoLaneHistory(): RhizomorphEvent[] {
      const f = createEventFactory({ startTs: NOW - 40_000, stepMs: 2_000 })
      return [
        f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
        f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
        f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false }),
        f.worktreeDiscovered({ path: OTHER_WORKTREE, branch: OTHER_LANE, head: 'sha-other', isMain: false }),
        f.llmUsage({
          lane: LANE,
          branch: LANE,
          worktreePath: WORKTREE,
          sessionId: 'sess-84',
          model: 'test-model-unpriced',
          tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
        }),
        f.llmUsage({
          lane: OTHER_LANE,
          branch: OTHER_LANE,
          worktreePath: OTHER_WORKTREE,
          sessionId: 'sess-other',
          model: 'test-model-unpriced',
          tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
        }),
      ]
    }

    function ExemplarJumpStub({ to }: { to: string }) {
      const { select } = useSelection()
      return (
        <button
          type="button"
          data-testid="test-exemplar-jump"
          onClick={() => {
            // The exact sequence `ExemplarJumpButton` (panels/ledger/index.tsx) runs.
            select(to)
            requestPanelFocus('trace')
          }}
        >
          jump
        </button>
      )
    }

    let source: ScriptedEventSource | null = null
    render(
      <StreamProvider
        url="/api/stream"
        now={NOW}
        createSource={() => {
          source = new ScriptedEventSource()
          return source
        }}
      >
        <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
          <SelectionProvider initialSelectedId={LANE}>
            <ExemplarJumpStub to={OTHER_LANE} />
            <LaneDrawer fetchTranscript={noTranscript} transcriptPollMs={0} />
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>,
    )
    await act(async () => {
      source?.onopen?.(new Event('open'))
      for (const event of twoLaneHistory()) {
        source?.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>)
      }
    })
    expect(screen.getByTestId('lane-drawer').getAttribute('data-lane')).toBe(LANE)
    expect(screen.getByTestId('drawer-tab-conversation').getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      fireEvent.click(screen.getByTestId('test-exemplar-jump'))
    })

    expect(screen.getByTestId('lane-drawer').getAttribute('data-lane')).toBe(OTHER_LANE)
    expect(screen.getByTestId('drawer-tab-trace').getAttribute('aria-selected')).toBe('true')
  })
})

describe('LaneDrawer — the conversation (the main view)', () => {
  const conversation: FetchLike = async () => ({
    ok: true,
    json: async () => ({
      available: true,
      lane: LANE,
      sessionId: 'sess-84',
      offset: 0,
      nextOffset: 120,
      size: 120,
      eof: true,
      restarted: false,
      entries: [
        { role: 'user', blocks: [{ kind: 'text', text: 'rebuild the drawer' }] },
        {
          role: 'assistant',
          blocks: [
            { kind: 'text', text: 'Reading the drawer first.' },
            { kind: 'tool_use', name: 'Read', hint: 'packages/web/src/drawer/index.tsx' },
          ],
        },
      ],
    }),
  })

  it('reads the lane\'s conversation on open — no fold to click through first', async () => {
    const urls: string[] = []
    const fetchTranscript: FetchLike = async (input) => {
      urls.push(input)
      return conversation(input)
    }

    await renderDrawer({ fetchTranscript })

    // #134: the conversation opens at the tail, not offset zero.
    expect(urls).toEqual([`/api/transcript/${LANE}?tail=1`])
    const body = screen.getByTestId('conversation-body')
    expect(body.textContent).toContain('rebuild the drawer')
    expect(body.textContent).toContain('Reading the drawer first.')
    expect(screen.getByTestId('tool-call').textContent).toContain('Read')
  })

  it('is the default tab, and fills the whole tab body — vitals above, tabs below', async () => {
    await renderDrawer({ fetchTranscript: conversation })

    const roles = [...screen.getAllByTestId('turn')].map((turn) => turn.getAttribute('data-role'))
    expect(roles).toEqual(['user', 'assistant'])
    expect(screen.getByTestId('drawer-conversation').className).toContain('flex-1')
  })
})

/**
 * MAIN, THE PSEUDO-LANE (prd6 ruling 5) — the root-mass opens the same drawer.
 *
 * The claims worth pinning are the ones that would rot quietly: that this is
 * genuinely the *same* frame and the *same* conversation component rather than
 * a second panel that looks similar, that every figure in it is the one the
 * burn strip would print, and that an uninstrumented conductor produces the gap
 * voice rather than a blank pane.
 */
describe('LaneDrawer — MAIN, the conductor', () => {
  const CONDUCTOR_DIR = '/conductor-home'
  const LANDED = '/repo-wt/103-landed'

  /** A session with a conductor in it, a lane, a landing and a commit home. */
  function mainHistory(): RhizomorphEvent[] {
    const f = createEventFactory({ startTs: NOW - 60_000, stepMs: 1_000 })
    return [
      f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
      f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
      f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-84', isMain: false }),
      f.worktreeDiscovered({ path: LANDED, branch: '103-landed', head: 'sha-103', isMain: false }),
      f.paneDiscovered({
        paneId: '%1',
        sessionName: 'rhizomorph',
        windowName: 'conductor',
        windowIndex: 0,
        currentPath: CONDUCTOR_DIR,
        worktreePath: CONDUCTOR_DIR,
      }),
      // `model` is pinned to an id no vendored pricing pattern covers (prd9
      // ruling 7): both tests reading this fixture's dollars mean "nobody
      // instrumented cost telemetry here" (law 12 / the conductor gap), and
      // the real default model (`claude-opus-5`) is now a real vendored
      // entry that would earn a selector-side estimate instead of a gap.
      f.llmUsage({
        lane: LANE,
        branch: LANE,
        worktreePath: WORKTREE,
        sessionId: 'sess-84',
        model: 'test-model-unpriced',
        tokens: { input: 10, output: 4_200, cacheRead: 90_000, cacheCreation: 1_000 },
      }),
      f.llmUsage({
        lane: 'conductor',
        role: 'conductor',
        branch: null,
        worktreePath: CONDUCTOR_DIR,
        sessionId: 'sess-conductor',
        model: 'test-model-unpriced',
        tokens: { input: 40, output: 12_000, cacheRead: 5_000, cacheCreation: 0 },
      }),
      f.commitLanded({
        branch: 'main',
        sha: 'ma1n0001',
        message: 'conductor: prd6 waves',
        files: [{ path: 'docs/prd6.md', status: 'added' }],
        insertions: 12,
        deletions: 0,
        worktreePath: '/repo',
      }),
      f.worktreeRemoved({ path: LANDED }),
    ]
  }

  /** What the conductor's own transcript route answers with, when it has one. */
  const conductorSession: FetchLike = async () => ({
    ok: true,
    json: async () => ({
      available: true,
      lane: 'main',
      sessionId: 'sess-conductor',
      offset: 0,
      nextOffset: 90,
      size: 90,
      eof: true,
      restarted: false,
      entries: [
        { role: 'user', blocks: [{ kind: 'text', text: 'dispatch wave 1' }] },
        {
          role: 'assistant',
          blocks: [
            { kind: 'text', text: 'Three briefs written.' },
            { kind: 'tool_use', name: 'Bash', hint: 'workmux new 107-main-node' },
          ],
        },
      ],
    }),
  })

  async function renderMain(options: Omit<HarnessOptions, 'selected'> = {}) {
    return renderDrawer({ events: mainHistory(), ...options, selected: MAIN_SELECTION })
  }

  it('opens on the root-mass, headed MAIN and the branch it is', async () => {
    await renderMain({ fetchTranscript: conductorSession })

    const drawer = screen.getByTestId('lane-drawer')
    expect(drawer.getAttribute('data-lane')).toBe('main')
    expect(drawer.textContent).toContain('Main')
    expect(screen.getByTestId('drawer-main-branch').textContent).toBe('main')
    // Not the lane reading: main is not in `fleet.lanes` and must not be
    // reported as a lane that went away.
    expect(screen.queryByTestId('drawer-unknown-lane')).toBeNull()
    expect(screen.queryByTestId('drawer-vitals')).toBeNull()
  })

  it('shows main\'s own vitals — branch, landings, commits home, and the session burn', async () => {
    await renderMain({ fetchTranscript: conductorSession })

    const vitals = screen.getByTestId('drawer-main-vitals')
    expect(vitals.textContent).toContain('branch')
    expect(vitals.textContent).toContain('main')
    // One worktree removed, one commit on main, and the two lanes' output
    // summed by the fleet object rather than by this drawer: 4.2K + 12K.
    expect(vitals.textContent).toContain('landings')
    expect(vitals.textContent).toContain('1')
    expect(vitals.textContent).toContain('16.2K')
  })

  it('prints the figures the burn strip prints — the same formatters, not a second sum', async () => {
    await renderMain({ fetchTranscript: conductorSession })

    const fleet = buildFleet(mainHistory().reduce(reduce, initialSessionState()), { now: NOW })
    const vitals = screen.getByTestId('drawer-main-vitals')

    expect(vitals.textContent).toContain(formatTokens(fleet.burn.outputTokens))
    expect(screen.getByTitle(outputHoverTitle(fleet.burn.tokens))).toBeTruthy()
    // No OTel in this fixture, so dollars are unknown — an em dash carrying the
    // strip's own gap sentence, never `$0.00` (law 12).
    const figureUnder = (title: string) =>
      screen.getByTitle(title).querySelector('dd')?.textContent
    expect(figureUnder(formatDollarsOrGap(fleet.burn))).toBe('—')
    expect(figureUnder(formatOverheadOrGap(fleet.burn))).toBe('—')
  })

  it('says the conductor\'s burn is unknown, not zero, when nobody instrumented it', async () => {
    await renderMain({ fetchTranscript: conductorSession })

    expect(screen.getByTestId('drawer-main-evidence').textContent).toContain(
      'conductor not instrumented — its burn is unknown, not zero',
    )
  })

  it('reads the conductor\'s own session, in the component a lane\'s turns use', async () => {
    const urls: string[] = []
    const fetchTranscript: FetchLike = async (input) => {
      urls.push(input)
      return conductorSession(input)
    }

    await renderMain({ fetchTranscript })

    // #134: the conversation opens at the tail, not offset zero.
    expect(urls).toEqual(['/api/transcript/main?tail=1'])
    const body = screen.getByTestId('conversation-body')
    expect(body.textContent).toContain('dispatch wave 1')
    expect(body.textContent).toContain('Three briefs written.')
    expect(screen.getByTestId('tool-call').textContent).toContain('Bash')
    // The same section, keeping the same share of the drawer it has for a lane.
    expect(screen.getByTestId('drawer-conversation').className).toContain('flex-1')
  })

  it('says what is missing, why, and the command — never a blank conversation', async () => {
    const gap =
      "CONDUCTOR NOT INSTRUMENTED — nothing in this session's event log was recorded against " +
      'role: conductor, so the orchestrator has no session for this drawer to read — ' +
      'run: `rhizomorph --extra-sessions <dir>:conductor`'
    const uninstrumented: FetchLike = async () => ({
      ok: false,
      json: async () => ({ available: false, lane: 'main', reason: gap }),
    })

    await renderMain({ fetchTranscript: uninstrumented })

    expect(screen.getByTestId('drawer-conversation').textContent).toContain(gap)
    expect(screen.queryByTestId('conversation-body')).toBeNull()
  })

  it('copies the conductor\'s own pane, and still only ever copies', async () => {
    const copied: string[] = []
    await renderMain({
      fetchTranscript: conductorSession,
      onCopy: async (text) => {
        copied.push(text)
      },
    })

    fireEvent.click(screen.getByTestId('attach-copy'))

    expect(screen.getByTestId('attach-command').textContent).toBe(
      'tmux attach -t rhizomorph \\; select-window -t 0',
    )
    expect(copied).toEqual(['tmux attach -t rhizomorph \\; select-window -t 0'])
  })

  it('offers no command at all, with the reason, when no pane is on record', async () => {
    const withoutPane = mainHistory().filter((event) => event.type !== 'pane.discovered')

    await renderDrawer({
      events: withoutPane,
      selected: MAIN_SELECTION,
      fetchTranscript: conductorSession,
    })

    expect(screen.queryByTestId('attach-copy')).toBeNull()
    expect(screen.getByTestId('drawer-attach').textContent).toContain('NO PANE ON RECORD')
    // Never `workmux open main`: main is not a workmux lane, and a command that
    // would make one is worse than admitting there is no address.
    expect(screen.getByTestId('drawer-attach').textContent).not.toContain('workmux')
  })

  it('closes on Esc, exactly as a lane\'s does', async () => {
    await renderMain({ fetchTranscript: conductorSession })
    expect(screen.getByTestId('lane-drawer')).toBeTruthy()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(screen.queryByTestId('lane-drawer')).toBeNull()
  })
})

describe('LaneDrawer — ATTACH (it copies, it never executes)', () => {
  it('copies the exact tmux command when the lane\'s pane is on record', async () => {
    const copied: string[] = []
    await renderDrawer({ onCopy: async (text) => void copied.push(text) })

    expect(screen.getByTestId('attach-command').textContent).toBe(
      'tmux attach -t rhizomorph \\; select-window -t 3',
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('attach-copy'))
    })

    expect(copied).toEqual(['tmux attach -t rhizomorph \\; select-window -t 3'])
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
