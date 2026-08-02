import { createEvent, createIdFactory } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../replay/api.js'
import { ConnectionBadge } from './ConnectionBadge.js'
import { ModeProvider, useReplay } from './ModeContext.js'

afterEach(cleanup)

const nextId = createIdFactory('evt')

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
        <ConnectionBadge status="open" />
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
          <ConnectionBadge status="open" />
          <ReplayDriver />
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
})
