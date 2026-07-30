import { createEvent, createIdFactory } from '@observatory/core'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamProvider } from '../app/StreamContext.js'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import Scene from './index.js'

/**
 * Proves the one integration that matters: the scene reads the shell's event
 * stream — the same log the panels fold — and nothing else.
 */

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

function renderScene() {
  let source: FakeEventSource | undefined
  render(
    <StreamProvider
      url="/api/stream"
      createSource={() => {
        source = new FakeEventSource()
        return source
      }}
    >
      <Scene />
    </StreamProvider>,
  )
  return () => source
}

const nextId = createIdFactory('live')

describe('Scene', () => {
  it('shows fixture data until the stream produces its first event', () => {
    renderScene()

    expect(screen.getByText('demo data — awaiting stream')).toBeInTheDocument()
    expect(screen.getByText('observatory')).toBeInTheDocument()
  })

  it('switches to live stream data as soon as an event lands', async () => {
    const source = renderScene()

    act(() => {
      source()?.emit(
        createEvent(
          'session.started',
          { sessionId: 's1', repoPath: '/repo', repoName: 'live-repo', mainBranch: 'main' },
          { id: nextId(), ts: 1 },
        ),
      )
      source()?.emit(
        createEvent(
          'worktree.discovered',
          { path: '/repo/wt/a', branch: 'feat-a', head: 'h1', isMain: false },
          { id: nextId(), ts: 2 },
        ),
      )
    })

    await waitFor(() => expect(screen.getByText('live-repo')).toBeInTheDocument())
    expect(screen.queryByText('demo data — awaiting stream')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /feat-a/ })).toBeInTheDocument()
  })
})
