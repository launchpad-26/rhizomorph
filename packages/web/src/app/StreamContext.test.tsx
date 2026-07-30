import { createEvent, createIdFactory, reduceAll } from '@observatory/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import type { FetchLike } from '../replay/api.js'
import { ModeProvider, useReplay } from './ModeContext.js'
import { StreamProvider, useStream } from './StreamContext.js'

afterEach(cleanup)

const nextId = createIdFactory('evt')

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

/** The live SSE stream discovers only the main worktree. */
function liveWorktreeEvent() {
  return createEvent(
    'worktree.discovered',
    { path: '/repo', branch: 'main', head: 'sha-live', isMain: true },
    { id: nextId(), ts: 9000 },
  )
}

/** A recorded session whose worktree lands after `session.started`, at ts 2000. */
function replaySessionEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'observatory', mainBranch: 'main' },
      { id: nextId(), ts: 1000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo-wt/replay', branch: 'replay', head: 'sha-replay', isMain: false },
      { id: nextId(), ts: 2000 },
    ),
  ]
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function makeFetch(events: ReturnType<typeof replaySessionEvents>): FetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return jsonResponse({
        sessions: [{ id: 's1', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 100 }],
      })
    }
    if (href === '/api/sessions/s1/events') {
      return jsonResponse({ events })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

/** Stands in for a real panel: reads only `useStream`, never the mode/replay hooks. */
function PanelLikeConsumer() {
  const { state } = useStream()
  const session = reduceAll(state.events)
  return <div data-testid="worktree-paths">{Object.keys(session.worktrees).sort().join(',')}</div>
}

/** Stands in for the replay controls: the only thing that drives session/scrub selection. */
function ReplayDriver() {
  const { sessions, selectSession, playback } = useReplay()
  return (
    <div>
      <button onClick={() => selectSession(sessions[0]?.id ?? null)}>select session</button>
      <button onClick={() => playback.seek(2000)}>seek</button>
      <button onClick={() => selectSession(null)}>return to live</button>
      {/* Exposes the scrubber clock so the test can wait for the "jump to
          session start" reset (usePlayback's `[start, end]` effect, which
          fires once the fetched log lands) to actually settle before it
          drives a seek — otherwise the seek can race that reset and be
          silently clobbered by it. */}
      <span data-testid="scrub-ts">{playback.currentTs}</span>
    </div>
  )
}

function renderApp() {
  let source: FakeEventSource | undefined
  const utils = render(
    <ModeProvider fetchImpl={makeFetch(replaySessionEvents())}>
      <StreamProvider
        url="/api/stream"
        createSource={() => {
          source = new FakeEventSource()
          return source
        }}
      >
        <PanelLikeConsumer />
        <ReplayDriver />
      </StreamProvider>
    </ModeProvider>,
  )
  return { ...utils, getSource: () => source }
}

describe('StreamContext driven by mode', () => {
  it('serves live state while live, the replay fold while replaying, and live again after returning', async () => {
    const { getSource } = renderApp()

    act(() => getSource()?.open())
    act(() => getSource()?.emit(liveWorktreeEvent()))
    expect(screen.getByTestId('worktree-paths').textContent).toBe('/repo')

    fireEvent.click(await screen.findByText('select session'))
    // Wait for the fetched log to land AND the scrubber's reset-to-start
    // effect to have actually committed (`currentTs` reads back the
    // session's first event, ts 1000) before driving a seek below — this is
    // the deterministic condition to wait on, not a fixed delay.
    await waitFor(() => expect(screen.getByTestId('scrub-ts').textContent).toBe('1000'))
    // Scrub time starts at the session's first event (ts 1000): the worktree
    // (ts 2000) has not "happened" yet — panels must show that, not the
    // live `/repo` worktree, and not a preview of the whole replay log.
    expect(screen.getByTestId('worktree-paths').textContent).toBe('')

    fireEvent.click(screen.getByText('seek'))
    await waitFor(() =>
      expect(screen.getByTestId('worktree-paths').textContent).toBe('/repo-wt/replay'),
    )

    fireEvent.click(screen.getByText('return to live'))
    await waitFor(() => expect(screen.getByTestId('worktree-paths').textContent).toBe('/repo'))
  })
})
