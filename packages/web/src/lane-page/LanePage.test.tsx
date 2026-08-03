import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createEventFactory, fixtureTraceSpans, type RhizomorphEvent } from '@rhizomorph/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { ModeProvider, useReplay } from '../app/ModeContext.js'
import { StreamProvider } from '../app/StreamContext.js'
import { FleetProvider } from '../fleet/FleetContext.js'
import type { FetchLike } from '../fleet/manifest.js'
import { SelectionProvider } from '../fleet/selection.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import type { FetchLike as ReplayFetchLike } from '../replay/api.js'
import { LanePage } from './LanePage.js'

afterEach(cleanup)

/** Pinned, so the fixture and every age string in the header/spend are still. */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

const LANE = '135-lane-page'
const WORKTREE = '/repo-wt/135-lane-page'

const noTranscript: FetchLike = async () => ({
  ok: false,
  json: async () => ({ available: false, lane: LANE, reason: 'NO SESSION LOG for this fixture' }),
})

class ScriptedEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

/** One lane's history: a worker on a fenced branch, with tokens, a thread split and a trace. */
function laneHistory(): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: NOW - 40_000, stepMs: 2_000 })
  return [
    f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha-135', isMain: false }),
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'sess-135',
      model: 'test-model-unpriced',
      thread: 'main',
      tokens: { input: 10, output: 4_200, cacheRead: 90_000, cacheCreation: 1_000 },
    }),
    f.llmUsage({
      lane: LANE,
      branch: LANE,
      worktreePath: WORKTREE,
      sessionId: 'sess-135',
      model: 'test-model-unpriced',
      thread: 'subagent',
      tokens: { input: 2, output: 800, cacheRead: 12_000, cacheCreation: 200 },
    }),
    f.toolActivity({ lane: LANE, branch: LANE, worktreePath: WORKTREE, sessionId: 'sess-135', tool: 'Read' }),
    f.commitLanded({
      branch: LANE,
      sha: 'abc1234def5678',
      message: 'feat(lane-page): the lane page',
      files: [{ path: 'packages/web/src/lane-page/LanePage.tsx', status: 'added' }],
      insertions: 90,
      deletions: 0,
      worktreePath: WORKTREE,
    }),
    ...fixtureTraceSpans({ lane: LANE, sessionId: 'sess-135' }),
  ]
}

interface HarnessOptions {
  handle?: string
  events?: RhizomorphEvent[]
  fetchTranscript?: FetchLike
}

async function renderLanePage(options: HarnessOptions = {}) {
  const events = options.events ?? laneHistory()
  let source: ScriptedEventSource | null = null

  const utils = render(
    <StreamProvider
      url="/api/stream"
      now={NOW}
      createSource={() => {
        source = new ScriptedEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={async () => ({ ok: false, json: async () => null })}>
        <SelectionProvider>
          <LanePage
            handle={options.handle ?? LANE}
            fetchTranscript={options.fetchTranscript ?? noTranscript}
            transcriptPollMs={0}
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

  return utils
}

describe('LanePage — cold deep link', () => {
  it('renders a working page for a lane the fleet knows about', async () => {
    await renderLanePage()

    expect(screen.getByTestId('lane-page')).toBeTruthy()
    expect(screen.queryByTestId('lane-page-unknown')).toBeNull()
  })

  it('says the honest gap for a handle no lane in this session carries', async () => {
    await renderLanePage({ handle: 'never-existed' })

    const gap = screen.getByTestId('lane-page-unknown')
    expect(gap.textContent).toContain('NO LANE')
    expect(gap.textContent).toContain('never-existed')
    expect(gap.textContent).toContain('this session')
    expect(screen.queryByTestId('lane-page-header')).toBeNull()
  })

  it("the header names the handle, role, state glyph and branch — the fleet table's own object", async () => {
    await renderLanePage()

    const header = screen.getByTestId('lane-page-header')
    expect(header.textContent).toContain(LANE)
    expect(header.querySelector('svg[data-sigil]')).toBeTruthy()
    expect(screen.getByTestId('lane-page-role').textContent).toBe('worker')
    expect(screen.getByTestId('lane-page-branch').textContent).toBe(LANE)
  })
})

describe('LanePage — reuse, not a fork', () => {
  it("renders the drawer's own Conversation component", async () => {
    await renderLanePage()
    expect(screen.getByTestId('drawer-conversation')).toBeTruthy()
  })

  it("renders #132's own TraceTree, with its gantt affordance available", async () => {
    await renderLanePage()

    expect(screen.getByTestId('trace-tree')).toBeTruthy()

    fireEvent.click(screen.getByTestId('lane-page-trace-toggle'))
    expect(screen.getByTestId('trace-gantt')).toBeTruthy()
  })

  it('renders the shared activity ledger', async () => {
    await renderLanePage()
    expect(screen.getByTestId('drawer-activity')).toBeTruthy()
  })
})

describe('LanePage — spend detail', () => {
  it("shows output-led tokens and the gap-honest dollar cell, per the fleet table's own rules", async () => {
    await renderLanePage()

    const spend = screen.getByTestId('lane-page-spend')
    const cellByLabel = (label: string) =>
      [...spend.querySelectorAll('div')].find((cell) => cell.querySelector('dt')?.textContent === label)

    // Both usage events summed for the lane's one telemetry handle: 4,200 + 800.
    expect(cellByLabel('output')?.querySelector('dd')?.textContent).toBe('5K')
    // No cost telemetry reached this lane (the model is deliberately unpriced) —
    // the gap-honest `—`, never an invented `$0.00`.
    expect(cellByLabel('$')?.querySelector('dd')?.textContent).toBe('—')
  })

  it("renders the lane's thread sub-rows, unambiguous because it has exactly one telemetry handle", async () => {
    await renderLanePage()

    // main, subagent, and the unattributed bucket the untagged tool call falls into.
    const threads = screen.getAllByTestId('lane-page-spend-thread')
    expect(threads).toHaveLength(3)
    const bodies = threads.map((row) => row.textContent ?? '')
    expect(bodies.some((text) => text.includes('main') && text.includes('4.2K'))).toBe(true)
    expect(bodies.some((text) => text.includes('sub') && text.includes('800'))).toBe(true)
  })
})

describe('LanePage — the conductor’s own page (#138)', () => {
  /**
   * The conductor's own telemetry: `role: 'conductor'` is what keeps
   * `buildFleet` from ever claiming it into a `Lane` (`fleet/buildFleet.ts`'s
   * `isRootSpend`), matching the real CLI's own attribution
   * (`fleet/fixtures.ts`'s `conductorBurn`) — no worktree, no branch of its
   * own, a bare telemetry lane named `conductor`.
   */
  function conductorHistory(): RhizomorphEvent[] {
    const f = createEventFactory({ startTs: NOW - 40_000, stepMs: 2_000 })
    return [
      f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
      f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
      f.llmUsage({
        lane: 'conductor',
        role: 'conductor',
        branch: null,
        worktreePath: null,
        sessionId: 'sess-conductor',
        model: 'test-model-unpriced',
        thread: 'main',
        tokens: { input: 8, output: 4_200, cacheRead: 90_000, cacheCreation: 1_000 },
      }),
      f.llmCost({
        lane: 'conductor',
        role: 'conductor',
        branch: null,
        worktreePath: null,
        sessionId: 'sess-conductor',
        model: 'test-model-unpriced',
        costUsd: 0.32,
        authoritative: true,
      }),
    ]
  }

  it('"main" resolves to the conductor’s own page — transcript, spend, and the honest trace gap', async () => {
    await renderLanePage({ handle: 'main', events: conductorHistory() })

    expect(screen.queryByTestId('lane-page-unknown')).toBeNull()

    const header = screen.getByTestId('lane-page-header')
    expect(header.textContent).toContain('Main')
    expect(header.textContent).toContain('the conductor')
    expect(screen.getByTestId('lane-page-role').textContent).toBe('conductor')
    // No branch chip invented from the repo's own main branch — the honest gap dash.
    expect(screen.getByTestId('lane-page-branch').textContent).toBe('—')

    const spend = screen.getByTestId('lane-page-spend')
    const cellByLabel = (label: string) =>
      [...spend.querySelectorAll('div')].find((cell) => cell.querySelector('dt')?.textContent === label)
    expect(cellByLabel('output')?.querySelector('dd')?.textContent).toBe('4.2K')
    expect(cellByLabel('$')?.querySelector('dd')?.textContent).toBe('$0.32')

    // No trace.span for the conductor's telemetry lane yet — its CLI is not
    // relaunched with the env block — so the existing honest-gap copy shows,
    // not a blank panel.
    expect(screen.getByText(/NO TRACE TELEMETRY/)).toBeTruthy()
  })

  it('"conductor" redirects client-side to "main" — the telemetry lane finds the same page', async () => {
    window.history.replaceState(null, '', '/lane/conductor')
    await renderLanePage({ handle: 'conductor', events: conductorHistory() })

    expect(window.location.pathname).toBe('/lane/main')
    window.history.replaceState(null, '', '/')
  })

  it('an unknown handle still gaps honestly', async () => {
    await renderLanePage({ handle: 'no-such-lane', events: conductorHistory() })

    const gap = screen.getByTestId('lane-page-unknown')
    expect(gap.textContent).toContain('no-such-lane')
    expect(screen.queryByTestId('lane-page-header')).toBeNull()
  })
})

describe('LanePage — Esc returns to the balcony', () => {
  it('navigates to / on Escape', async () => {
    window.history.replaceState(null, '', `/lane/${LANE}`)
    await renderLanePage()

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(window.location.pathname).toBe('/')
    window.history.replaceState(null, '', '/')
  })

  it('the "← balcony" control does the same', async () => {
    window.history.replaceState(null, '', `/lane/${LANE}`)
    await renderLanePage()

    await act(async () => {
      fireEvent.click(screen.getByTestId('lane-page-back'))
    })

    expect(window.location.pathname).toBe('/')
    window.history.replaceState(null, '', '/')
  })
})

describe('LanePage — replay-safe by construction', () => {
  const REPLAY_LANE = '135-replay'
  const REPLAY_WT = '/repo-wt/135-replay'
  const REPLAY_START = NOW - 20 * 60_000

  /** Two usage events, ~20 minutes apart, so a scrub between them is a real fold boundary. */
  function replayEvents(): RhizomorphEvent[] {
    const f = createEventFactory({ startTs: REPLAY_START, stepMs: 1_000 })
    const early = [
      f.sessionStarted({ repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' }),
      f.worktreeDiscovered({ path: '/repo', branch: 'main', head: 'sha-main', isMain: true }),
      f.worktreeDiscovered({ path: REPLAY_WT, branch: REPLAY_LANE, head: 'sha-r', isMain: false }),
      f.llmUsage({
        lane: REPLAY_LANE,
        branch: REPLAY_LANE,
        worktreePath: REPLAY_WT,
        sessionId: 'sess-replay',
        model: 'test-model-unpriced',
        tokens: { input: 1, output: 1_000, cacheRead: 0, cacheCreation: 0 },
      }),
    ]
    const late = [
      f.llmUsage(
        {
          lane: REPLAY_LANE,
          branch: REPLAY_LANE,
          worktreePath: REPLAY_WT,
          sessionId: 'sess-replay',
          model: 'test-model-unpriced',
          tokens: { input: 1, output: 9_000, cacheRead: 0, cacheCreation: 0 },
        },
        { ts: NOW },
      ),
    ]
    return [...early, ...late]
  }

  const sessionsFetch: ReplayFetchLike = (async (input: string | URL | Request) => {
    const href = String(input)
    if (href === '/api/sessions') {
      return {
        ok: true,
        json: async () => ({
          sessions: [{ id: 'replay-1', fileName: 'session-replay-1.jsonl', startedAt: REPLAY_START, sizeBytes: 10 }],
        }),
      }
    }
    if (href === '/api/sessions/replay-1/events') {
      return { ok: true, json: async () => ({ events: replayEvents() }) }
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as ReplayFetchLike

  function ReplayHarness({ children }: { children: ReactNode }) {
    return (
      <ModeProvider fetchImpl={sessionsFetch}>
        <StreamProvider url="/api/stream" now={NOW} createSource={() => new ScriptedEventSource()}>
          <FleetProvider now={NOW} fetchLanes={async () => ({ ok: false, json: async () => null })}>
            <SelectionProvider>{children}</SelectionProvider>
          </FleetProvider>
        </StreamProvider>
      </ModeProvider>
    )
  }

  it('folds only the events at or before the scrub time, exactly like the balcony', async () => {
    let session: ReturnType<typeof useReplay> | null = null

    function Probe() {
      session = useReplay()
      return <LanePage handle={REPLAY_LANE} fetchTranscript={noTranscript} transcriptPollMs={0} />
    }

    render(
      <ReplayHarness>
        <Probe />
      </ReplayHarness>,
    )

    await act(async () => {
      session?.selectSession('replay-1')
    })
    // Let the session's events resolve and the scrubber reset to its start.
    await act(async () => {})

    // Scrub to just after the FIRST usage event only.
    await act(async () => {
      session?.playback.seek(REPLAY_START + 5_000)
    })

    let outputCell = [...screen.getByTestId('lane-page-spend').querySelectorAll('div')].find(
      (cell) => cell.querySelector('dt')?.textContent === 'output',
    )
    expect(outputCell?.querySelector('dd')?.textContent).toBe('1K')

    // Scrub past both events.
    await act(async () => {
      session?.playback.seek(NOW)
    })

    outputCell = [...screen.getByTestId('lane-page-spend').querySelectorAll('div')].find(
      (cell) => cell.querySelector('dt')?.textContent === 'output',
    )
    expect(outputCell?.querySelector('dd')?.textContent).toBe('10K')
  })
})
