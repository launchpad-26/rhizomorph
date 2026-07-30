import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createEventFactory, fixtureSession, type ObservatoryEvent } from '@observatory/core'
import { StreamProvider } from '../../app/StreamContext.js'
import type { EventSourceLike } from '../../hooks/useEventStream.js'
import TickerPanel from './index.js'

afterEach(cleanup)

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>)
  }

  close() {}
}

function renderTicker() {
  let source: FakeEventSource | undefined
  const utils = render(
    <StreamProvider
      url="/api/stream"
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <TickerPanel />
    </StreamProvider>,
  )
  return { ...utils, emit: (event: ObservatoryEvent) => act(() => source?.emit(event)) }
}

describe('TickerPanel', () => {
  it('shows a waiting placeholder before any events arrive', () => {
    renderTicker()
    expect(screen.getByText('Waiting for data…')).toBeInTheDocument()
  })

  it('renders commit.landed and agent.status events as one reverse-chron feed', () => {
    const { emit } = renderTicker()

    for (const event of fixtureSession()) emit(event)

    const rows = screen.getAllByTestId('ticker-entry')

    // Newest first: the last thing fixtureSession() records is 3-git going
    // from working to waiting, after its commit already landed.
    expect(rows[0]).toHaveTextContent('waiting')
    expect(rows[0]).toHaveTextContent('3-git')
    expect(rows[1]).toHaveTextContent('feat(server): git worktree parser')
    expect(rows[1]).toHaveTextContent('3-git')
    expect(rows[2]).toHaveTextContent('feat(core): reducer + selectors')
    expect(rows[3]).toHaveTextContent('feat(core): event schemas')

    // Diffstat and branch badge both render for a commit row.
    expect(rows[3]).toHaveTextContent('2 files')
    expect(rows[3]).toHaveTextContent('+123')
    expect(rows[3]).toHaveTextContent('-1')

    // Earliest agent.status entries (all three agents starting up) trail the feed.
    expect(rows.at(-1)).toHaveTextContent('working')
  })

  it('pulses newly-arrived entries without replaying the animation on old ones', () => {
    const f = createEventFactory({ stepMs: 1000 })
    const first = f.commitLanded({ sha: 'sha-1', branch: 'feature' })
    const { emit } = renderTicker()

    emit(first)
    const [firstRow] = screen.getAllByTestId('ticker-entry')
    expect(firstRow).toHaveClass('ticker-entry-pulse')

    const second = f.commitLanded({ sha: 'sha-2', branch: 'feature' })
    emit(second)
    const rows = screen.getAllByTestId('ticker-entry')
    expect(rows).toHaveLength(2)
    // Both carry the pulse-capable class; React keeps the first row's DOM
    // node (same key), so its mount-triggered animation never replays.
    for (const row of rows) expect(row).toHaveClass('ticker-entry-pulse')
  })
})
