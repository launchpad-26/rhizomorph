import { createEvent, createIdFactory } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { EventSourceLike } from '../hooks/useEventStream.js'
import type { FetchLike } from '../replay/api.js'
import { ConnectionBadge } from './ConnectionBadge.js'
import { ModeProvider, useReplay } from './ModeContext.js'
import { StreamProvider } from './StreamContext.js'

afterEach(cleanup)

const nextId = createIdFactory('evt')

/** Pinned so a fixture's history folds deterministically and its tick timer never arms (`StreamContext.tsx`'s `useFixtureStream`). */
const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)

/** The badge never opens or emits on this — it only needs `StreamProvider`'s live branch to exist as a fallback while `source === 'live'`. */
class InertEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close() {}
}

function replaySessionEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: 1000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: 'sha-0', isMain: true },
      { id: nextId(), ts: 4000 },
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

/** Stands in for the replay controls: the only thing that drives session/scrub selection. */
function ReplayDriver() {
  const { sessions, selectSession } = useReplay()
  return <button onClick={() => selectSession(sessions[0]?.id ?? null)}>select session</button>
}

describe('ConnectionBadge', () => {
  it('reads LIVE with the connection state while live', () => {
    render(
      <ModeProvider fetchImpl={makeFetch(replaySessionEvents())}>
        <StreamProvider url="/api/stream" now={NOW} createSource={() => new InertEventSource()}>
          <ConnectionBadge status="open" />
        </StreamProvider>
      </ModeProvider>,
    )

    expect(screen.getByText('live')).toBeInTheDocument()
    expect(screen.queryByText('replay')).not.toBeInTheDocument()
  })

  it('reads REPLAY with the session timestamp once a session is selected, keeping SSE state visible but secondary', async () => {
    // Selecting a session chains through two mocked fetches (the session
    // list, then that session's events) before `isReplaying` flips. Awaiting
    // an async `act` around mount and around the click each flush their own
    // fetch's microtasks deterministically, rather than racing both chains
    // against a single waitFor timeout under scheduler load (see #28/#31).
    await act(async () => {
      render(
        <ModeProvider fetchImpl={makeFetch(replaySessionEvents())}>
          <StreamProvider url="/api/stream" now={NOW} createSource={() => new InertEventSource()}>
            <ConnectionBadge status="open" />
            <ReplayDriver />
          </StreamProvider>
        </ModeProvider>,
      )
    })

    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })

    expect(screen.getByText('replay')).toBeInTheDocument()
    // Scrub time starts at the session's first event (ts 1000); the last
    // event lands at ts 4000, so total elapsed is 3s.
    expect(screen.getByText('0:00 / 0:03')).toBeInTheDocument()
    expect(screen.queryByText('live')).not.toBeInTheDocument()

    const sse = screen.getByTitle('Stream: live')
    expect(sse).toHaveTextContent('sse')
  })

  // prd-19 ruling 6 / #254: a fixture must never pass as live data.
  describe('fixture provenance (#254)', () => {
    it('renders the provenance string and never "live" while source is fleet20, restoring on return to live', async () => {
      await act(async () => {
        render(
          <ModeProvider fetchImpl={makeFetch(replaySessionEvents())}>
            <StreamProvider url="/api/stream" now={NOW} createSource={() => new InertEventSource()}>
              <ConnectionBadge status="open" />
            </StreamProvider>
          </ModeProvider>,
        )
      })

      expect(screen.getByText('live')).toBeInTheDocument()

      // Key 2 (`STREAM_SOURCE_KEYS` in StreamContext.tsx) selects the fleet20
      // fixture — the same binding the operator's own keyboard uses.
      fireEvent.keyDown(window, { key: '2' })

      const fleet20Badge = await screen.findByText(/synthetic/)
      expect(fleet20Badge.textContent).toContain('synthetic')
      expect(fleet20Badge.textContent).not.toContain('live')
      expect(screen.queryByText('live')).not.toBeInTheDocument()

      // Key 1 returns to live: the badge must read exactly as it did before
      // any fixture was ever selected.
      fireEvent.keyDown(window, { key: '1' })

      await waitFor(() => expect(screen.getByText('live')).toBeInTheDocument())
      expect(screen.queryByText(/synthetic/)).not.toBeInTheDocument()
    })

    it('renders the provenance string and never "live" while source is pathology (key 3)', async () => {
      await act(async () => {
        render(
          <ModeProvider fetchImpl={makeFetch(replaySessionEvents())}>
            <StreamProvider url="/api/stream" now={NOW} createSource={() => new InertEventSource()}>
              <ConnectionBadge status="open" />
            </StreamProvider>
          </ModeProvider>,
        )
      })

      fireEvent.keyDown(window, { key: '3' })

      const pathologyBadge = await screen.findByText(/synthetic/)
      expect(pathologyBadge.textContent).toContain('synthetic')
      expect(pathologyBadge.textContent).not.toContain('live')
      expect(screen.queryByText('live')).not.toBeInTheDocument()
    })
  })
})
