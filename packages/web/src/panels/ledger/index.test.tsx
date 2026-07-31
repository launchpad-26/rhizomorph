import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  FIXTURE_START_TS,
  createEventFactory,
  fixtureTelemetrySession,
  reduceAll,
  selectSpendByBranch,
} from '@observatory/core'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamProvider } from '../../app/StreamContext.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import { formatTokenBreakdown, formatTokens, formatUsd } from '../../lib/format.js'
import LedgerPanel from './index.js'

afterEach(cleanup)

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

function renderPanel(events: readonly unknown[] = [], open = true) {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <LedgerPanel now={NOW} />
    </StreamProvider>,
  )
  if (open) act(() => source?.open())
  act(() => {
    for (const event of events) source?.emit(event)
  })
  return utils
}

describe('LedgerPanel', () => {
  it('renders a header and a waiting state before any connection or data', () => {
    render(
      <StreamProvider url="/api/stream" createSource={() => new FakeEventSource()}>
        <LedgerPanel now={NOW} />
      </StreamProvider>,
    )
    expect(screen.getByText('Ledger')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the stream…')).toBeInTheDocument()
  })

  it('shows a calm empty state once connected with events but no branch telemetry', () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'empty' })
    f.sessionStarted()
    renderPanel(f.all())

    expect(screen.getByText('No branch spend recorded yet this session.')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for the stream…')).not.toBeInTheDocument()
  })

  it('renders one row per branch the swarm fixture saw, dearest first, all live', () => {
    const session = reduceAll(fixtureTelemetrySession())
    const rows = selectSpendByBranch(session)

    renderPanel(fixtureTelemetrySession())

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

  it('flags a branch Landed once its worktree has been removed, and keeps its cost', () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'land' })
    const branch = '48-branch-ledger'
    const path = '/repo/observatory-wt/48-branch-ledger'
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

    renderPanel(f.all())

    const session = reduceAll(f.all())
    const row = selectSpendByBranch(session).find((entry) => entry.branch === branch)
    expect(row?.landed).toBe(true)

    const rendered = screen.getAllByTestId('ledger-row')
    const landedRow = rendered.find((el) => el.textContent?.includes(branch))
    expect(landedRow).toHaveTextContent('Landed')
    expect(landedRow).toHaveTextContent('#48')
    expect(landedRow).toHaveTextContent(formatUsd(0.75))
  })

  it('keeps a still-live branch Live, distinct from a landed one', () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'live' })
    const branch = '9-still-going'
    const path = '/repo/observatory-wt/9-still-going'
    f.sessionStarted()
    f.worktreeDiscovered({ path, branch, head: 'sha-0', isMain: false })
    f.llmUsage({ lane: branch, branch, worktreePath: path, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 } })

    renderPanel(f.all())

    const rendered = screen.getAllByTestId('ledger-row')
    const liveRow = rendered.find((el) => el.textContent?.includes(branch))
    expect(liveRow).toHaveTextContent('Live')
    expect(liveRow).not.toHaveTextContent('Landed')
  })

  it('flags an estimated cost with "est." and shows tokens only when no cost telemetry exists', () => {
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

    renderPanel(f.all())

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

  it('shows the TOKENS column as an output-led figure with the four-tier breakdown in its title', () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'tokcol' })
    f.sessionStarted()
    f.llmUsage({
      lane: 'tokcol-branch',
      branch: 'tokcol-branch',
      tokens: { input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400 },
    })
    f.llmCost({ lane: 'tokcol-branch', branch: 'tokcol-branch', costUsd: 0.42, authoritative: true })

    renderPanel(f.all())

    const row = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes('tokcol-branch'))!
    const tokensCell = within(row).getByTestId('ledger-tokens')
    // Output-led (3_100), never the unlabelled all-tier sum (189_504).
    expect(tokensCell).toHaveTextContent(formatTokens(3_100))
    expect(tokensCell).not.toHaveTextContent(formatTokens(189_504))
    expect(tokensCell.getAttribute('title')).toBe(
      formatTokenBreakdown({ input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400, total: 189_504 }),
    )
  })

  it('renders collapsed thread sub-rows for a mixed-thread lane that sum to its parent', () => {
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

    renderPanel(f.all())

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

  it('renders no sub-rows and no toggle for a lane with no thread data', () => {
    const f = createEventFactory({ startTs: FIXTURE_START_TS, idPrefix: 'nothread' })
    f.sessionStarted()
    f.llmUsage({
      lane: 'plain',
      branch: 'plain',
      tokens: { input: 1, output: 10, cacheRead: 0, cacheCreation: 0 },
    })

    renderPanel(f.all())

    const plainRow = screen.getAllByTestId('ledger-row').find((el) => el.textContent?.includes('plain'))!
    expect(within(plainRow).queryByTestId('ledger-thread-toggle')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('ledger-subrow')).toHaveLength(0)
  })

  it('does not leak expand/collapse state between lanes', () => {
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

    renderPanel(f.all())

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
