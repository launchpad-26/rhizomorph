import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createEventFactory, type ObservatoryEvent } from '@observatory/core'
import { StreamProvider } from '../../app/StreamContext.js'
import { FleetProvider } from '../../fleet/FleetContext.js'
import type { FetchLike } from '../../fleet/manifest.js'
import { SelectionProvider } from '../../fleet/selection.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import ActivityFeed from './index.js'

afterEach(cleanup)

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const REPO = '/repo/observatory'
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
    emit: (event: ObservatoryEvent) => act(() => source?.emit(event)),
    open: () => act(() => source?.open()),
  }
}

/** Two lanes, one landing, one lane restart, and both flavours of collector trouble. */
function scenarioEvents(): ObservatoryEvent[] {
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
  f.collectorError({ collector: 'tmux', message: 'capture-pane timed out' })

  return f.all()
}

describe('ActivityFeed', () => {
  it('shows a waiting-for-stream placeholder before any connection or events', () => {
    renderFeed()
    expect(screen.getByText('Waiting for the stream…')).toBeInTheDocument()
  })

  it('shows a calm empty state once connected with events but no activity', () => {
    const { emit, open } = renderFeed()
    open()
    emit(createEventFactory({ startTs: NOW }).sessionStarted())

    expect(screen.getByText('No activity yet this session.')).toBeInTheDocument()
    expect(screen.queryByText('Waiting for the stream…')).not.toBeInTheDocument()
  })

  it('folds commits, landings, lane starts/stops and collector events into one feed, newest first', () => {
    const { emit } = renderFeed()
    for (const event of scenarioEvents()) emit(event)

    const rows = screen.getAllByTestId('feed-entry')
    const kinds = rows.map((row) => row.dataset.kind)

    expect(new Set(kinds)).toEqual(new Set(['commit', 'landing', 'lane', 'collector']))
    // Newest first: the tmux collector error was the very last thing to happen.
    expect(rows[0]?.dataset.kind).toBe('collector')
    expect(rows[0]).toHaveTextContent('tmux')
  })

  it('filters by kind when a kind tag is toggled off', () => {
    const { emit } = renderFeed()
    for (const event of scenarioEvents()) emit(event)

    expect(screen.getAllByTestId('feed-entry').some((row) => row.dataset.kind === 'collector')).toBe(
      true,
    )

    fireEvent.click(screen.getByTestId('feed-kind-collector'))

    for (const row of screen.getAllByTestId('feed-entry')) {
      expect(row.dataset.kind).not.toBe('collector')
    }
    expect(screen.getByTestId('feed-kind-collector')).toHaveAttribute('aria-pressed', 'false')
  })

  it('filters to the selected lane, using the fleet-resolved lane id', () => {
    const { emit } = renderFeed('42-lane')
    for (const event of scenarioEvents()) emit(event)

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
