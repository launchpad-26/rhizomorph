import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  FIXTURE_START_TS,
  createEventFactory,
  fixtureTelemetrySession,
  reduceAll,
  selectSpendByBranch,
} from '@rhizomorph/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discloseText } from '../../disclosure/testing.js'
import { ModeProvider, useReplay } from '../../app/ModeContext.js'
import { requestPanelFocus } from '../../app/panelPrefs.js'
import { StreamProvider } from '../../app/StreamContext.js'
import { FleetProvider } from '../../fleet/FleetContext.js'
import type { FetchLike } from '../../fleet/manifest.js'
import { SelectionProvider, useSelection } from '../../fleet/selection.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import { formatTokenBreakdown, formatTokens, formatUsd } from '../../lib/format.js'
import type { FetchLike as ReplayFetchLike } from '../../replay/api.js'
import LedgerPanel from './index.js'

/**
 * #158's counting law: how many times each selector actually ran, wrapped
 * rather than mocked away — `vi.mock`'s factory is hoisted above the imports
 * above, so the counters live in `vi.hoisted` and every module (this file's
 * own top-level imports included) sees the same wrapped function.
 */
const calls = vi.hoisted(() => ({ spend: 0, usage: 0, exemplar: 0 }))

vi.mock('@rhizomorph/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rhizomorph/core')>()
  return {
    ...actual,
    selectSpendByBranch: (...args: Parameters<typeof actual.selectSpendByBranch>) => {
      calls.spend++
      return actual.selectSpendByBranch(...args)
    },
  }
})

vi.mock('./sparkline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sparkline.js')>()
  return {
    ...actual,
    usageEventsByBranch: (...args: Parameters<typeof actual.usageEventsByBranch>) => {
      calls.usage++
      return actual.usageEventsByBranch(...args)
    },
  }
})

vi.mock('./exemplar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./exemplar.js')>()
  return {
    ...actual,
    heaviestLlmRequestSpanByLane: (
      ...args: Parameters<typeof actual.heaviestLlmRequestSpanByLane>
    ) => {
      calls.exemplar++
      return actual.heaviestLlmRequestSpanByLane(...args)
    },
  }
})

afterEach(cleanup)

const noLaneManifest: FetchLike = async () => ({ ok: false, json: async () => null })

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

/** Matches the moment `core`'s own spend fixtures were authored against. */
const NOW = FIXTURE_START_TS + 10 * 60_000

/** Test-only witness for the exemplar jump's `select` call. */
function SelectionProbe() {
  const { selectedId } = useSelection()
  return <div data-testid="selection-probe">{selectedId ?? ''}</div>
}

async function renderPanel(events: readonly unknown[] = [], open = true) {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <SelectionProvider>
          <LedgerPanel now={NOW} />
        </SelectionProvider>
      </FleetProvider>
    </StreamProvider>,
  )
  if (open) act(() => source?.open())
  await act(async () => {
    for (const event of events) source?.emit(event)
  })
  return {
    ...utils,
    /** Emits one more event after mount — for tests that measure a render caused by a single event. */
    emit: async (event: unknown) => {
      await act(async () => {
        source?.emit(event)
      })
    },
  }
}

describe('LedgerPanel', () => {
  it('renders a waiting state before any connection or data — and no heading of its own (#552)', () => {
    render(
      <StreamProvider url="/api/stream" createSource={() => new FakeEventSource()}>
        <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
          <SelectionProvider>
            <LedgerPanel now={NOW} />
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>,
    )
    // The dock's tab strip names this surface (SPEND); a second name inside it
    // would be the duplication prd-32 ruling 5 removed.
    expect(screen.queryByText('Ledger')).not.toBeInTheDocument()
    expect(screen.getByText('Waiting for the stream…')).toBeInTheDocument()
  })

  it('shows a calm empty state once connected with events but no branch telemetry', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'empty' })
    f.sessionStarted()
    await renderPanel(f.all())

    expect(screen.getByText('No branch spend recorded yet this session.')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for the stream…')).not.toBeInTheDocument()
  })

  it('renders one row per branch the swarm fixture saw, dearest first, all live', async () => {
    const session = reduceAll(fixtureTelemetrySession())
    const rows = selectSpendByBranch(session)

    await renderPanel(fixtureTelemetrySession())

    const rendered = screen.getAllByTestId('ledger-row')
    expect(rendered).toHaveLength(rows.length)
    rendered.forEach((row, index) => {
      const expected = rows[index]!
      expect(row).toHaveTextContent(expected.branch)
      expect(row).toHaveTextContent('Live')
      if (expected.issue !== null) expect(row).toHaveTextContent(`#${expected.issue}`)
    })
    // Worker branch names double as the fenced-issue number in this fixture.
    expect(rows[0]!.branch).not.toBe('main')
    expect(screen.getByTestId('ledger-honesty')).toHaveTextContent('Dollars are notional')
  })

  it('flags a branch Landed once its worktree has been removed, and keeps its cost', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'land' })
    const branch = '48-branch-ledger'
    const path = '/repo/rhizomorph-wt/48-branch-ledger'
    f.sessionStarted()
    f.worktreeDiscovered({ path, branch, head: 'sha-0', isMain: false })
    f.llmUsage({
      lane: branch,
      branch,
      worktreePath: path,
      tokens: { input: 2, output: 500, cacheRead: 40_000, cacheCreation: 1_000 },
    })
    f.llmCost({ lane: branch, branch, worktreePath: path, costUsd: 0.75, authoritative: true })
    f.worktreeRemoved({ path })

    await renderPanel(f.all())

    const session = reduceAll(f.all())
    const row = selectSpendByBranch(session).find((entry) => entry.branch === branch)
    expect(row?.landed).toBe(true)

    const rendered = screen.getAllByTestId('ledger-row')
    const landedRow = rendered.find((el) => el.textContent?.includes(branch))
    expect(landedRow).toHaveTextContent('Landed')
    expect(landedRow).toHaveTextContent('#48')
    expect(landedRow).toHaveTextContent(formatUsd(0.75))
  })

  it('keeps a still-live branch Live, distinct from a landed one', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'live' })
    const branch = '9-still-going'
    const path = '/repo/rhizomorph-wt/9-still-going'
    f.sessionStarted()
    f.worktreeDiscovered({ path, branch, head: 'sha-0', isMain: false })
    f.llmUsage({ lane: branch, branch, worktreePath: path, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } })

    await renderPanel(f.all())

    const rendered = screen.getAllByTestId('ledger-row')
    const liveRow = rendered.find((el) => el.textContent?.includes(branch))
    expect(liveRow).toHaveTextContent('Live')
    expect(liveRow).not.toHaveTextContent('Landed')
  })

  it('flags an estimated cost with "est." and shows tokens only when no cost telemetry exists', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'mix' })
    f.sessionStarted()
    f.llmUsage({
      lane: 'estimated-branch',
      branch: 'estimated-branch',
      tokens: { input: 1, output: 100, cacheRead: 0, cacheCreation: 0 },
    })
    f.llmCost({
      lane: 'estimated-branch',
      branch: 'estimated-branch',
      costUsd: 0.05,
      authoritative: false,
      estimateSource: 'pricing-table@litellm',
    })
    f.llmUsage({
      lane: 'tokens-only-branch',
      branch: 'tokens-only-branch',
      // Cache-read-heavy on purpose: output (2_000) and the all-tier total
      // (52_001) must render as visibly different figures.
      tokens: { input: 1, output: 2_000, cacheRead: 50_000, cacheCreation: 0 },
    })

    await renderPanel(f.all())

    const rendered = screen.getAllByTestId('ledger-row')
    const estimatedRow = rendered.find((el) => el.textContent?.includes('estimated-branch'))
    expect(estimatedRow).toHaveTextContent(formatUsd(0.05))
    expect(estimatedRow).toHaveTextContent('est.')

    const tokensOnlyRow = rendered.find((el) => el.textContent?.includes('tokens-only-branch'))
    // Output-led (2_000), never the unlabelled all-tier sum (52_001).
    expect(tokensOnlyRow).toHaveTextContent(formatTokens(2_000))
    expect(tokensOnlyRow).not.toHaveTextContent(formatTokens(52_001))
    expect(tokensOnlyRow).not.toHaveTextContent('est.')
  })

  it('shows the TOKENS column as an output-led figure with the four-tier breakdown in its title', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'tokcol' })
    f.sessionStarted()
    f.llmUsage({
      lane: 'tokcol-branch',
      branch: 'tokcol-branch',
      tokens: { input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400 },
    })
    f.llmCost({ lane: 'tokcol-branch', branch: 'tokcol-branch', costUsd: 0.42, authoritative: true })

    await renderPanel(f.all())

    const row = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes('tokcol-branch'))!
    const tokensCell = within(row).getByTestId('ledger-tokens')
    // Output-led (3_100), never the unlabelled all-tier sum (189_504).
    expect(tokensCell).toHaveTextContent(formatTokens(3_100))
    expect(tokensCell).not.toHaveTextContent(formatTokens(189_504))
    expect(discloseText(tokensCell)).toContain(
      formatTokenBreakdown({ input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400, total: 189_504 }),
    )
  })

  it('renders collapsed thread sub-rows for a mixed-thread lane that sum to its parent', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'threads' })
    f.sessionStarted()
    f.llmUsage({
      lane: 'threaded',
      branch: 'threaded',
      thread: 'main',
      tokens: { input: 1, output: 100, cacheRead: 0, cacheCreation: 0 },
    })
    f.llmCost({
      lane: 'threaded',
      branch: 'threaded',
      thread: 'main',
      costUsd: 0.1,
      authoritative: true,
    })
    f.llmUsage({
      lane: 'threaded',
      branch: 'threaded',
      thread: 'subagent',
      tokens: { input: 1, output: 50, cacheRead: 0, cacheCreation: 0 },
    })
    f.llmCost({
      lane: 'threaded',
      branch: 'threaded',
      thread: 'subagent',
      costUsd: 0.05,
      authoritative: true,
    })

    await renderPanel(f.all())

    const threadedRow = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes('threaded'))!
    expect(threadedRow).toHaveTextContent(formatUsd(0.15))
    // Output-led (150 = 100 + 50), never the unlabelled all-tier sum (152).
    expect(threadedRow).toHaveTextContent(formatTokens(150))

    // Collapsed by default: the toggle is there, but no sub-rows have rendered yet.
    const toggle = within(threadedRow).getByTestId('ledger-thread-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByTestId('ledger-subrow')).toHaveLength(0)

    fireEvent.click(toggle)

    const subrows = screen.getAllByTestId('ledger-subrow')
    expect(subrows).toHaveLength(2)
    expect(subrows[0]).toHaveTextContent('main')
    expect(subrows[0]).toHaveTextContent(formatUsd(0.1))
    expect(subrows[0]).toHaveTextContent(formatTokens(100))
    expect(subrows[1]).toHaveTextContent('subagent')
    expect(subrows[1]).toHaveTextContent(formatUsd(0.05))
    expect(subrows[1]).toHaveTextContent(formatTokens(50))

    // The sub-rows partition the parent's own numbers exactly.
    const session = reduceAll(f.all())
    const parent = selectSpendByBranch(session).find((row) => row.branch === 'threaded')!
    expect(0.1 + 0.05).toBeCloseTo(parent.costUsd, 6)
    expect(101 + 51).toBe(parent.tokens.total)

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryAllByTestId('ledger-subrow')).toHaveLength(0)
  })

  it('renders no sub-rows and no toggle for a lane with no thread data', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'nothread' })
    f.sessionStarted()
    f.llmUsage({
      lane: 'plain',
      branch: 'plain',
      tokens: { input: 1, output: 10, cacheRead: 0, cacheCreation: 0 },
    })

    await renderPanel(f.all())

    const plainRow = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes('plain'))!
    expect(within(plainRow).queryByTestId('ledger-thread-toggle')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('ledger-subrow')).toHaveLength(0)
  })

  it('does not leak expand/collapse state between lanes', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'leak' })
    f.sessionStarted()
    f.llmUsage({
      lane: 'alpha',
      branch: 'alpha',
      thread: 'main',
      tokens: { input: 1, output: 10, cacheRead: 0, cacheCreation: 0 },
    })
    f.llmUsage({
      lane: 'alpha',
      branch: 'alpha',
      thread: 'subagent',
      tokens: { input: 1, output: 20, cacheRead: 0, cacheCreation: 0 },
    })
    f.llmUsage({
      lane: 'beta',
      branch: 'beta',
      thread: 'main',
      tokens: { input: 1, output: 30, cacheRead: 0, cacheCreation: 0 },
    })
    f.llmUsage({
      lane: 'beta',
      branch: 'beta',
      thread: 'auxiliary',
      tokens: { input: 1, output: 40, cacheRead: 0, cacheCreation: 0 },
    })

    await renderPanel(f.all())

    const rows = () => screen.getAllByTestId('ledger-row')
    const alphaToggle = within(rows().find((el) => el.textContent?.includes('alpha'))!).getByTestId(
      'ledger-thread-toggle',
    )
    const betaToggle = within(rows().find((el) => el.textContent?.includes('beta'))!).getByTestId(
      'ledger-thread-toggle',
    )

    // Expanding alpha must not open beta's sub-rows.
    fireEvent.click(alphaToggle)
    expect(screen.getAllByTestId('ledger-subrow')).toHaveLength(2)
    expect(betaToggle).toHaveAttribute('aria-expanded', 'false')

    // Expanding beta afterwards leaves alpha's own state untouched.
    fireEvent.click(betaToggle)
    expect(screen.getAllByTestId('ledger-subrow')).toHaveLength(4)
    expect(alphaToggle).toHaveAttribute('aria-expanded', 'true')

    // Collapsing alpha leaves beta expanded — its rows, not alpha's stale ones.
    fireEvent.click(alphaToggle)
    const remaining = screen.getAllByTestId('ledger-subrow')
    expect(remaining).toHaveLength(2)
    expect(remaining.some((row) => row.textContent?.includes('auxiliary'))).toBe(true)
    expect(remaining.some((row) => row.textContent?.includes('subagent'))).toBe(false)
    expect(betaToggle).toHaveAttribute('aria-expanded', 'true')
  })
})

// ── connective tissue (#159) ────────────────────────────────────────────────

describe('LedgerPanel — row drill-down (issue #159)', () => {
  it('links a branch row to its own deep-linkable page', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'drilldown' })
    const branch = '77-drilldown'
    f.sessionStarted()
    f.llmUsage({ lane: branch, branch, tokens: { input: 1, output: 10, cacheRead: 0, cacheCreation: 0 } })

    await renderPanel(f.all())

    const row = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes(branch))!
    const link = within(row).getByTestId('ledger-row-open')
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe(`/lane/${branch}`)
  })

  it('navigates the SPA in place on a plain click', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'drilldownclick' })
    const branch = '78-drilldown-click'
    f.sessionStarted()
    f.llmUsage({ lane: branch, branch, tokens: { input: 1, output: 10, cacheRead: 0, cacheCreation: 0 } })

    await renderPanel(f.all())
    window.history.replaceState(null, '', '/')

    const row = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes(branch))!
    const link = within(row).getByTestId('ledger-row-open')

    act(() => {
      fireEvent.click(link, { button: 0 })
    })

    expect(window.location.pathname).toBe(`/lane/${branch}`)
    window.history.replaceState(null, '', '/')
  })
})

describe('LedgerPanel — TOKENS sparkline (issue #159)', () => {
  it('draws a spark once the branch has at least three honest buckets of history', async () => {
    const branch = '79-sparkline'
    const f = createEventFactory({ startTs: NOW - 30 * 60_000, idPrefix: 'sparkline' })
    f.sessionStarted()
    // Three requests, well apart, so they land in three distinct 3-minute buckets.
    f.llmUsage(
      { lane: branch, branch, tokens: { input: 1, output: 100, cacheRead: 0, cacheCreation: 0 } },
      { ts: NOW - 25 * 60_000 },
    )
    f.llmUsage(
      { lane: branch, branch, tokens: { input: 1, output: 200, cacheRead: 0, cacheCreation: 0 } },
      { ts: NOW - 15 * 60_000 },
    )
    f.llmUsage(
      { lane: branch, branch, tokens: { input: 1, output: 300, cacheRead: 0, cacheCreation: 0 } },
      { ts: NOW - 1_000 },
    )

    await renderPanel(f.all())

    const row = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes(branch))!
    const tokensCell = within(row).getByTestId('ledger-tokens')
    const spark = tokensCell.querySelector('svg[data-testid="sparkline"]')

    expect(spark).not.toBeNull()
    expect(spark?.getAttribute('aria-hidden')).toBe('true')
    expect(tokensCell.textContent).toContain(formatTokens(600))
  })

  it('draws nothing for a branch too young to have three honest buckets', async () => {
    const branch = '80-too-young'
    const f = createEventFactory({ startTs: NOW - 60_000, idPrefix: 'tooyoung' })
    f.sessionStarted()
    f.llmUsage({ lane: branch, branch, tokens: { input: 1, output: 50, cacheRead: 0, cacheCreation: 0 } })

    await renderPanel(f.all())

    const row = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes(branch))!
    const tokensCell = within(row).getByTestId('ledger-tokens')

    expect(tokensCell.querySelector('svg[data-testid="sparkline"]')).toBeNull()
    expect(tokensCell.textContent).toContain(formatTokens(50))
  })
})

describe('LedgerPanel — the exemplar jump (issue #159)', () => {
  it('offers no jump for a branch with no trace spans behind it', async () => {
    const branch = '81-no-trace'
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'notrace' })
    f.sessionStarted()
    f.llmUsage({ lane: branch, branch, tokens: { input: 1, output: 10, cacheRead: 0, cacheCreation: 0 } })

    await renderPanel(f.all())

    const row = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes(branch))!
    expect(within(row).queryByTestId('ledger-exemplar-jump')).toBeNull()
  })

  it('selects the lane and navigates to its run view, where the trace now lives (#562)', async () => {
    const branch = '82-exemplar'
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'exemplar' })
    f.sessionStarted()
    f.llmUsage({ lane: branch, branch, tokens: { input: 1, output: 10, cacheRead: 0, cacheCreation: 0 } })
    f.traceSpan({
      lane: branch, branch, traceId: 'trace-82', spanId: 'span-82',
      tokens: { input: 5, output: 200, cacheRead: 0, cacheCreation: 0 },
    })

    let source: FakeEventSource | undefined
    render(
      <StreamProvider
        url="/api/stream"
        createSource={() => {
          source = new FakeEventSource()
          return source
        }}
      >
        <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
          <SelectionProvider>
            <SelectionProbe />
            <LedgerPanel now={NOW} />
          </SelectionProvider>
        </FleetProvider>
      </StreamProvider>,
    )
    act(() => source?.open())
    await act(async () => {
      for (const event of f.all()) source?.emit(event)
    })

    const row = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes(branch))!
    const jump = within(row).getByTestId('ledger-exemplar-jump')
    expect(discloseText(jump)).toContain(formatTokens(205))

    // prd-36 ruling 2 cut FOCUS TRACE, so this jump follows the trace to the
    // surface that kept it. The selection is still written first, so the fleet
    // behind the navigation agrees about which lane was opened.
    try {
      fireEvent.click(jump)

      expect(window.location.pathname).toBe(`/lane/${branch}`)
      expect(screen.getByTestId('selection-probe').textContent).toBe(branch)

      // …and the channel it used to call has nothing listening for `trace`
      // any more — a request for it reaches nobody rather than silently
      // focusing something else.
      expect(() => requestPanelFocus('trace')).not.toThrow()
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })
})

// ── the one clock rule (#155) ───────────────────────────────────────────────

describe('LedgerPanel — replay clock', () => {
  /** Long before this suite runs, so a wall-clock leak reads as ages, not seconds. */
  const T0 = Date.UTC(2020, 0, 1)
  const BRANCH = 'ledger-lawlane'
  const PATH = `/repo-wt/${BRANCH}`

  function replayEvents() {
    const f = createEventFactory({ startTs: T0, idPrefix: 'ledgerlaw' })
    f.sessionStarted()
    f.at(T0 + 1_000).worktreeDiscovered({ path: PATH, branch: BRANCH, head: 'sha-0', isMain: false })
    f.at(T0 + 5_000).llmUsage({ lane: BRANCH, branch: BRANCH, worktreePath: PATH })
    // Far past the work event, giving the scrubber room to seek in between.
    f.at(T0 + 900_000).llmUsage({ lane: BRANCH, branch: BRANCH, worktreePath: PATH })
    return f.all()
  }

  function replayFetch(): ReplayFetchLike {
    return (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/sessions') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sessions: [{ id: 'law', fileName: 'law.jsonl', startedAt: T0, sizeBytes: 100 }],
          }),
        } as unknown as Response
      }
      if (href === '/api/sessions/law/events') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ events: replayEvents() }),
        } as unknown as Response
      }
      throw new Error(`unexpected fetch: ${href}`)
    }) as unknown as ReplayFetchLike
  }

  /** Selects the one recorded session and scrubs to 10s after its work event. */
  function ReplayDriver() {
    const { sessions, selectSession, playback } = useReplay()
    return (
      <div>
        <button onClick={() => selectSession(sessions[0]?.id ?? null)}>select session</button>
        <button onClick={() => playback.seek(T0 + 15_000)}>seek</button>
      </div>
    )
  }

  it('reads "last seen" against the scrub position, not the wall clock (no `now` override)', async () => {
    await act(async () => {
      render(
        <ModeProvider fetchImpl={replayFetch()}>
          <StreamProvider url="/api/stream" createSource={() => new FakeEventSource()}>
            <FleetProvider fetchLanes={noLaneManifest}>
              <SelectionProvider>
                <ReplayDriver />
                <LedgerPanel />
              </SelectionProvider>
            </FleetProvider>
          </StreamProvider>
        </ModeProvider>,
      )
    })

    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })
    act(() => {
      fireEvent.click(screen.getByText('seek'))
    })

    const row = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes(BRANCH))!
    // Judged against the scrub position (10s after the work event), FIRST
    // SEEN and LAST SEEN both read "just now". Judged against the real wall
    // clock instead — the exact reported bug — this T0-relative branch would
    // read as years stale ("…d ago"), never "just now".
    expect(row).toHaveTextContent('just now')
    expect(row).not.toHaveTextContent('ago')
  })
})

// ── selector keys (#158) ─────────────────────────────────────────────────────

describe('LedgerPanel — selector keys (#158)', () => {
  /** Spend across two branches, plus one trace span so the exemplar map is non-empty. */
  function selectorKeyEvents(idPrefix: string) {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix })
    f.sessionStarted()
    f.llmUsage({
      lane: 'branch-a',
      branch: 'branch-a',
      tokens: { input: 1, output: 100, cacheRead: 0, cacheCreation: 0 },
    })
    f.llmCost({ lane: 'branch-a', branch: 'branch-a', costUsd: 0.1, authoritative: true })
    f.llmUsage({
      lane: 'branch-b',
      branch: 'branch-b',
      tokens: { input: 1, output: 200, cacheRead: 0, cacheCreation: 0 },
    })
    f.llmCost({ lane: 'branch-b', branch: 'branch-b', costUsd: 0.2, authoritative: true })
    // Its own traceId/spanId: the factory's default trace.span payload reuses
    // the same ids on every call, and the reducer treats a repeat spanId as
    // already-seen — returning `state` untouched rather than a fresh
    // `state.traces` reference. Every span emitted in this describe block
    // needs an id no other span here shares, or the exemplar memo has nothing
    // to actually recompute against.
    f.traceSpan({
      lane: 'branch-a',
      traceId: `${idPrefix}-trace-0`,
      spanId: `${idPrefix}-span-0`,
      tokens: { input: 1, output: 50, cacheRead: 0, cacheCreation: 0 },
    })
    return f
  }

  /** Row branch names and total-tokens text, for the "nothing on screen moved" check. */
  function tableSnapshot() {
    return screen.getAllByTestId('ledger-row').map((row) => row.textContent)
  }

  it('a trace.span moves only the exemplars', async () => {
    const f = selectorKeyEvents('key-1')
    const panel = await renderPanel(f.all())
    calls.spend = 0
    calls.usage = 0
    calls.exemplar = 0

    await panel.emit(
      f.traceSpan({
        lane: 'branch-b',
        traceId: 'key-1-trace-1',
        spanId: 'key-1-span-1',
        tokens: { input: 1, output: 60, cacheRead: 0, cacheCreation: 0 },
      }),
    )

    expect(calls.exemplar).toBe(1)
    expect(calls.spend).toBe(0)
    expect(calls.usage).toBe(0)
  })

  it('a tool.activity moves the spend rows (toolCounts is part of BranchSpend) but not the sparklines or the exemplars', async () => {
    // The plan's own draft expected tool.activity to skip the spend scan too —
    // wrong: `groupSpendBy` (`spend-cursor.ts:624-638`) folds `state.telemetry
    // .tools` into every `BranchSpend.toolCounts`, so a tool call genuinely is
    // spend input, and `state.telemetry`'s own reference moves on every
    // telemetry event regardless of which nested array changed
    // (`withTelemetry`, `reduce.ts:1108`, always rebuilds the outer object).
    // What tool.activity actually leaves alone is `telemetry.usage` — the
    // *nested* array `withTelemetry`'s `tools` append never touches — and
    // `traces`, untouched by definition. That is the real skip this test
    // proves; see the positive control below for what a genuine miss looks
    // like on `calls.spend` itself.
    const f = selectorKeyEvents('key-2')
    const panel = await renderPanel(f.all())
    calls.spend = 0
    calls.usage = 0
    calls.exemplar = 0

    await panel.emit(f.toolActivity({ lane: 'branch-a', branch: 'branch-a' }))

    expect(calls.spend).toBe(1)
    expect(calls.usage).toBe(0)
    expect(calls.exemplar).toBe(0)
  })

  it('an llm.usage moves the spend rows and the sparklines, not the exemplars — the positive control', async () => {
    // Without this, every skip assertion above would pass on a panel that
    // never recomputes anything at all.
    const f = selectorKeyEvents('key-3')
    const panel = await renderPanel(f.all())
    calls.spend = 0
    calls.usage = 0
    calls.exemplar = 0

    await panel.emit(
      f.llmUsage({
        lane: 'branch-a',
        branch: 'branch-a',
        tokens: { input: 1, output: 10, cacheRead: 0, cacheCreation: 0 },
      }),
    )

    expect(calls.spend).toBe(1)
    expect(calls.usage).toBe(1)
    expect(calls.exemplar).toBe(0)
  })

  it('the skip is per event, not a one-shot (repetition)', async () => {
    const f = selectorKeyEvents('key-4')
    const panel = await renderPanel(f.all())
    calls.spend = 0
    calls.usage = 0
    calls.exemplar = 0

    // 'rep-' rather than reusing 'key-4-trace-0': `selectorKeyEvents` already
    // seeded a span under that exact id, and a repeated id is exactly the
    // no-op the reducer's dedup returns `state` unchanged for (the trap this
    // whole `describe` had to learn once already, in the trace.span test above).
    for (let i = 0; i < 3; i++) {
      await panel.emit(
        f.traceSpan({
          lane: 'branch-a',
          traceId: `key-4-rep-trace-${i}`,
          spanId: `key-4-rep-span-${i}`,
          tokens: { input: 1, output: 10 + i, cacheRead: 0, cacheCreation: 0 },
        }),
      )
    }

    expect(calls.exemplar).toBe(3)
    expect(calls.spend).toBe(0)
  })

  it('nothing on screen moved across any of the ignorable events above', async () => {
    const f = selectorKeyEvents('key-5')
    const panel = await renderPanel(f.all())
    const before = tableSnapshot()

    await panel.emit(f.traceSpan({ lane: 'branch-a', tokens: { input: 1, output: 5, cacheRead: 0, cacheCreation: 0 } }))
    await panel.emit(f.toolActivity({ lane: 'branch-a', branch: 'branch-a' }))

    // A memo key that is too narrow is a stale-render bug, and this is the
    // case that would catch it: the rows and their totals must read exactly
    // as they did before, not merely "the same count of rows".
    expect(tableSnapshot()).toEqual(before)
  })

  it('an ignorable event does not disturb the empty state (failure path)', async () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'key-6' })
    f.sessionStarted()
    const panel = await renderPanel(f.all())

    expect(screen.getByText('No branch spend recorded yet this session.')).toBeInTheDocument()

    await panel.emit(f.traceSpan({ lane: 'nobody', tokens: { input: 1, output: 5, cacheRead: 0, cacheCreation: 0 } }))

    expect(screen.getByText('No branch spend recorded yet this session.')).toBeInTheDocument()
  })
})
