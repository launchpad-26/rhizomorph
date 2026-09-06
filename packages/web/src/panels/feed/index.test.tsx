import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createEventFactory, type AgentStatusWitness, type RhizomorphEvent } from '@rhizomorph/core'
import { StreamProvider } from '../../app/StreamContext.js'
import { FleetProvider } from '../../fleet/FleetContext.js'
import { INFERRED_MARK } from '../../fleet/index.js'
import type { FetchLike } from '../../fleet/manifest.js'
import { SelectionProvider } from '../../fleet/selection.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import { formatClock } from './format.js'
import ActivityFeed from './index.js'

afterEach(cleanup)

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const REPO = '/repo/rhizomorph'
const WT = (name: string) => `${REPO}-wt/${name}`

/** A server that has not shipped `.swarm/lanes.json` — off-fence is not this test's concern. */
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

function renderFeed(initialSelectedId: string | null = null) {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      now={NOW}
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <FleetProvider now={NOW} fetchLanes={noLaneManifest}>
        <SelectionProvider initialSelectedId={initialSelectedId}>
          <ActivityFeed />
        </SelectionProvider>
      </FleetProvider>
    </StreamProvider>,
  )
  return {
    ...utils,
    emit: (event: RhizomorphEvent) => act(async () => source?.emit(event)),
    open: () => act(() => source?.open()),
  }
}

/** Two lanes, one landing, one lane restart, and both flavours of collector trouble. */
function scenarioEvents(): RhizomorphEvent[] {
  const f = createEventFactory({ startTs: NOW - 10 * 60_000, stepMs: 60_000 })

  f.sessionStarted()
  f.worktreeDiscovered({ path: REPO, branch: 'main', head: 'sha-main-0', isMain: true })
  f.worktreeDiscovered({ path: WT('42-lane'), branch: '42-lane', head: 'sha-42-0', isMain: false })
  f.worktreeDiscovered({ path: WT('43-lane'), branch: '43-lane', head: 'sha-43-0', isMain: false })

  f.agentStatus({ handle: '42-lane', status: 'working', worktreePath: WT('42-lane'), branch: '42-lane' })
  f.commitLanded({ sha: 'sha-42-1', branch: '42-lane', message: 'feat(42): land the thing' })
  f.agentStatus({ handle: '42-lane', status: 'done', worktreePath: WT('42-lane'), branch: '42-lane' })
  f.worktreeRemoved({ path: WT('42-lane') })

  f.collectorDisabled({ collector: 'workmux', reason: 'workmux not found on PATH' })
  f.commitLanded({ sha: 'sha-43-1', branch: '43-lane', message: 'feat(43): a second lane' })
  f.agentStatus(
    { handle: '43-lane', status: 'working', worktreePath: WT('43-lane'), branch: '43-lane' },
    { source: 'sessionlog' },
  )
  f.agentStatus(
    {
      handle: '43-lane',
      status: 'waiting',
      worktreePath: WT('43-lane'),
      branch: '43-lane',
      detail: 'WAITING — tail turn-complete, quiet 45s, threshold 30s',
    },
    { source: 'sessionlog' },
  )
  f.collectorError({ collector: 'tmux', message: 'capture-pane timed out' })

  return f.all()
}

/** The `KindTag` a `LaneRow` wears: the span right after the clock's. */
function laneTagTextOf(row: HTMLElement): string {
  return row.querySelectorAll('span')[1]?.textContent ?? ''
}

/**
 * `LaneRow` stamps `data-witness` on its own root, one level under the
 * `feed-entry` `<li>` `screen.getAllByTestId` returns — read it off that
 * inner element rather than the `<li>` itself.
 */
function witnessOf(row: HTMLElement): string | null {
  return row.querySelector<HTMLElement>('[data-witness]')?.dataset.witness ?? null
}

describe('ActivityFeed', () => {
  it('shows a waiting-for-stream placeholder before any connection or events', () => {
    renderFeed()
    expect(screen.getByText('Waiting for the stream…')).toBeInTheDocument()
  })

  it('shows a calm empty state once connected with events but no activity', async () => {
    const { emit, open } = renderFeed()
    open()
    await emit(createEventFactory({ startTs: NOW }).sessionStarted())

    expect(screen.getByText('No activity yet this session.')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for the stream…')).not.toBeInTheDocument()
  })

  it('folds commits, landings, lane starts/stops and collector events into one feed, newest first', async () => {
    const { emit } = renderFeed()
    for (const event of scenarioEvents()) await emit(event)

    const rows = screen.getAllByTestId('feed-entry')
    const kinds = rows.map((row) => row.dataset.kind)

    expect(new Set(kinds)).toEqual(new Set(['commit', 'landing', 'lane', 'collector']))
    // Newest first: the tmux collector error was the very last thing to happen.
    expect(rows[0]?.dataset.kind).toBe('collector')
    expect(rows[0]).toHaveTextContent('tmux')
  })

  it('filters by kind when a kind tag is toggled off', async () => {
    const { emit } = renderFeed()
    for (const event of scenarioEvents()) await emit(event)

    expect(screen.getAllByTestId('feed-entry').some((row) => row.dataset.kind === 'collector')).toBe(
      true,
    )

    fireEvent.click(screen.getByTestId('feed-kind-collector'))

    for (const row of screen.getAllByTestId('feed-entry')) {
      expect(row.dataset.kind).not.toBe('collector')
    }
    expect(screen.getByTestId('feed-kind-collector')).toHaveAttribute('aria-pressed', 'false')
  })

  it('filters to the selected lane, using the fleet-resolved lane id', async () => {
    const { emit } = renderFeed('42-lane')
    for (const event of scenarioEvents()) await emit(event)

    const rows = screen.getAllByTestId('feed-entry')
    expect(rows.length).toBeGreaterThan(0)
    // 42-lane's commit and its landing show; 43-lane's commit and the
    // lane-less collector entries do not.
    expect(rows.some((row) => row.dataset.kind === 'landing')).toBe(true)
    expect(rows.some((row) => row.textContent?.includes('43-lane'))).toBe(false)
    expect(rows.some((row) => row.dataset.kind === 'collector')).toBe(false)

    fireEvent.click(screen.getByTestId('feed-clear-lane'))
    expect(
      screen.getAllByTestId('feed-entry').some((row) => row.dataset.kind === 'collector'),
    ).toBe(true)
  })
})

describe('lane rows name their witness (#290)', () => {
  it('a declared waiting and an inferred waiting render differently, and the difference is the inference mark', async () => {
    const { emit } = renderFeed()
    for (const event of scenarioEvents()) await emit(event)
    // One more, declared: a workmux `waiting` for 42-lane, alongside the
    // scenario's sessionlog `waiting` for 43-lane.
    await emit(
      createEventFactory({ startTs: NOW }).agentStatus(
        { handle: '42-lane', status: 'waiting', worktreePath: WT('42-lane'), branch: '42-lane' },
        { source: 'workmux' },
      ),
    )

    const laneRows = screen
      .getAllByTestId('feed-entry')
      .filter((row) => row.dataset.kind === 'lane' && row.textContent?.includes('waiting'))
    expect(laneRows).toHaveLength(2)

    const workmuxRow = laneRows.find((row) => witnessOf(row) === 'workmux')
    const sessionlogRow = laneRows.find((row) => witnessOf(row) === 'sessionlog')
    expect(workmuxRow).toBeDefined()
    expect(sessionlogRow).toBeDefined()

    const workmuxTag = laneTagTextOf(workmuxRow!)
    const sessionlogTag = laneTagTextOf(sessionlogRow!)
    expect(workmuxTag).not.toBe(sessionlogTag)
    expect(sessionlogTag.startsWith(`${INFERRED_MARK} `)).toBe(true)
    expect(workmuxTag).not.toContain(INFERRED_MARK)
  })

  it('an inferred working is marked too — the mark is about the witness, not the word', async () => {
    const { emit } = renderFeed()
    for (const event of scenarioEvents()) await emit(event)

    // 43-lane carries two sessionlog rows (working, then waiting) — isolate
    // the working one by its tag text, not by handle alone.
    const workingRow = screen
      .getAllByTestId('feed-entry')
      .find(
        (candidate) =>
          candidate.dataset.kind === 'lane' &&
          witnessOf(candidate) === 'sessionlog' &&
          candidate.textContent?.includes('43-lane') &&
          laneTagTextOf(candidate) === `${INFERRED_MARK} working`,
      )
    expect(workingRow).toBeDefined()
    expect(laneTagTextOf(workingRow!)).toBe(`${INFERRED_MARK} working`)
  })

  it('a workmux row renders byte-identically to before the witness existed', async () => {
    const events = scenarioEvents()
    const workmuxWorking = events.find(
      (event): event is Extract<RhizomorphEvent, { type: 'agent.status' }> =>
        event.type === 'agent.status' &&
        event.source === 'workmux' &&
        event.payload.handle === '42-lane' &&
        event.payload.status === 'working',
    )
    expect(workmuxWorking).toBeDefined()

    const { emit } = renderFeed()
    for (const event of events) await emit(event)

    const row = screen
      .getAllByTestId('feed-entry')
      .find(
        (candidate) =>
          candidate.dataset.kind === 'lane' &&
          witnessOf(candidate) === 'workmux' &&
          candidate.textContent?.includes('42-lane') &&
          candidate.textContent?.includes('working'),
      )
    expect(row).toBeDefined()
    // The regression this issue demands: no witness word, no space added —
    // exactly Clock text + tag + handle, the pre-#290 `LaneRow` shape (no
    // ` · branch` because branch equals handle; no detail on this event).
    expect(row!.textContent).toBe(`${formatClock(workmuxWorking!.ts)}working42-lane`)
  })

  it('the tag is total over the witness type', () => {
    const _covered: Record<AgentStatusWitness, true> = { workmux: true, sessionlog: true }
    expect(_covered).toEqual({ workmux: true, sessionlog: true })
  })
})
