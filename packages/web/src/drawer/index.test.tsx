import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createEventFactory,
  initialSessionState,
  reduce,
  type RhizomorphEvent,
} from '@rhizomorph/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
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

  it('sits below the conversation — prd4 ruling 4\'s ordering, structurally', async () => {
    await renderDrawer()

    const drawer = screen.getByTestId('lane-drawer')
    const order = [...drawer.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'))
    expect(order.indexOf('drawer-vitals')).toBeLessThan(order.indexOf('drawer-conversation'))
    expect(order.indexOf('drawer-conversation')).toBeLessThan(order.indexOf('drawer-activity'))
    expect(order.indexOf('drawer-activity')).toBeLessThan(order.indexOf('drawer-attach'))
  })

  it('takes a bounded strip, not half the drawer — the conversation is the flex-1 one', async () => {
    await renderDrawer()

    expect(screen.getByTestId('drawer-activity').className).not.toContain('flex-1')
    expect(screen.getByTestId('drawer-conversation').className).toContain('flex-1')
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

    expect(urls).toEqual([`/api/transcript/${LANE}?offset=0`])
    const body = screen.getByTestId('conversation-body')
    expect(body.textContent).toContain('rebuild the drawer')
    expect(body.textContent).toContain('Reading the drawer first.')
    expect(screen.getByTestId('tool-call').textContent).toContain('Read')
  })

  it('is the largest section, with the vitals above it and the ledger below', async () => {
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

    expect(urls).toEqual(['/api/transcript/main?offset=0'])
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
