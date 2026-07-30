import { act, cleanup, render, screen } from '@testing-library/react'
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
import { formatTokens, formatUsd } from './format.js'
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
      tokens: { input: 1, output: 2_000, cacheRead: 0, cacheCreation: 0 },
    })

    renderPanel(f.all())

    const rendered = screen.getAllByTestId('ledger-row')
    const estimatedRow = rendered.find((el) => el.textContent?.includes('estimated-branch'))
    expect(estimatedRow).toHaveTextContent(formatUsd(0.05))
    expect(estimatedRow).toHaveTextContent('est.')

    const tokensOnlyRow = rendered.find((el) => el.textContent?.includes('tokens-only-branch'))
    expect(tokensOnlyRow).toHaveTextContent(formatTokens(2_001))
    expect(tokensOnlyRow).not.toHaveTextContent('est.')
  })
})
