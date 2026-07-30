import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createEvent, createIdFactory } from '@observatory/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.js'
import type { EventSourceLike } from './hooks/useEventStream.js'

// App renders these behind React.lazy(() => import(...)). Even with the
// module pre-warmed in vitest's cache, the dynamic import() call is spec'd to
// always resolve via a queued promise job, so the shell still suspends for at
// least one tick — and under CPU contention (several suites' processes
// fighting for the same cores) that tick's actual wall-clock cost is whatever
// the OS scheduler feels like, which can occasionally outrun findByText's
// window no matter how generous. Stubbing these to render synchronously
// removes the dynamic import — and therefore the promise-resolution tick —
// entirely, so there's nothing left to race: this test is about the shell's
// composition (does each Suspense slot host the right panel?), not the real
// panels' internals, which each have their own direct-import test file.
vi.mock('./panels/worktrees/index.js', () => ({ default: () => <h2>Worktrees</h2> }))
vi.mock('./panels/collisions/index.js', () => ({ default: () => <h2>Collisions</h2> }))
vi.mock('./panels/ticker/index.js', () => ({ default: () => <div>Commit ticker</div> }))
vi.mock('./replay/index.js', () => ({ default: () => <div>Replay stub</div> }))
vi.mock('./scene/index.js', () => ({ default: () => <div>Scene stub</div> }))

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

/** jsdom has no `EventSource` global, so every render needs a mock source injected. */
function renderApp() {
  let source: FakeEventSource | undefined
  const utils = render(
    <App
      createSource={(url) => {
        expect(url).toBe('/api/stream')
        source = new FakeEventSource()
        return source
      }}
    />,
  )
  return { ...utils, source: () => source }
}

const nextId = createIdFactory('evt')

function fixtureEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'observatory', mainBranch: 'main' },
      { id: nextId(), ts: 1 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: 'sha-0', isMain: true },
      { id: nextId(), ts: 2 },
    ),
  ]
}

describe('App', () => {
  it('renders the instrument shell — scene slot, panel grid, replay bar', async () => {
    renderApp()

    expect(screen.getByText('THE OBSERVATORY')).toBeInTheDocument()
    expect(screen.getByText('connecting…')).toBeInTheDocument()
    // Panels are still React.lazy (mocked above), so the boundary still
    // suspends for a tick — but resolving a mocked, already-in-memory module
    // is fixed, negligible work with nothing left to transform on demand.
    expect(await screen.findByText('Worktrees')).toBeInTheDocument()
    expect(await screen.findByText('Collisions')).toBeInTheDocument()
    expect(await screen.findByText('Commit ticker')).toBeInTheDocument()
  })

  it('surfaces connection state and folds fixture events from a mock stream', async () => {
    const { source } = renderApp()

    act(() => source()?.open())
    await waitFor(() => expect(screen.getByText('live')).toBeInTheDocument())

    for (const event of fixtureEvents()) {
      act(() => source()?.emit(event))
    }

    // Stub panels don't read stream state yet — this proves the hook folded
    // the events without the shell crashing or losing the connection badge.
    await waitFor(() => expect(screen.getByText('live')).toBeInTheDocument())
  })

  it('can collapse and re-expand the scene slot', async () => {
    renderApp()
    const toggle = screen.getByRole('button', { name: /collapse scene/i })

    act(() => toggle.click())
    expect(await screen.findByRole('button', { name: /expand scene/i })).toBeInTheDocument()
  })
})
