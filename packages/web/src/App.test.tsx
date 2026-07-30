import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createEvent, createIdFactory } from '@observatory/core'
import { afterEach, describe, expect, it } from 'vitest'
import { App } from './App.js'
import type { EventSourceLike } from './hooks/useEventStream.js'
// App renders these behind React.lazy(). Importing them statically here warms
// vitest's module cache before the test runs, so the dynamic import() that
// lazy() fires on first render resolves off an already-loaded module instead
// of transforming it on demand — otherwise that on-demand transform's cost
// varies with machine load and can occasionally outrun findByText's default
// 1000ms timeout (the "1 failed | 329 passed" flake seen on CI).
import './panels/worktrees/index.js'
import './panels/collisions/index.js'
import './panels/ticker/index.js'
import './replay/index.js'
import './scene/index.js'

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
    // Panels are React.lazy — they resolve after a microtask.
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
