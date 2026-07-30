import { createEvent, createIdFactory } from '@observatory/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ModeProvider } from '../app/ModeContext.js'
import ReplayControls from './index.js'
import type { FetchLike } from './api.js'

afterEach(cleanup)

const nextId = createIdFactory('evt')

function fixtureEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'observatory', mainBranch: 'main' },
      { id: nextId(), ts: 1000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: 'sha-0', isMain: true },
      { id: nextId(), ts: 2000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo-wt/a', branch: 'a', head: 'sha-0', isMain: false },
      { id: nextId(), ts: 3000 },
    ),
  ]
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function makeFetch(events: ReturnType<typeof fixtureEvents>): FetchLike {
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

/**
 * Two sessions: a tiny 1-event restart stub (`stub`, small `sizeBytes`) and a
 * richer session (`rich`) with more events and a bigger `sizeBytes` — the one
 * "replay this session's birth" should pick over the merely-oldest session.
 */
function makeMultiSessionFetch(): FetchLike {
  const stubEvents = [
    createEvent(
      'session.started',
      { sessionId: 'stub', repoPath: '/repo', repoName: 'observatory', mainBranch: 'main' },
      { id: nextId(), ts: 500 },
    ),
  ]
  const richEvents = fixtureEvents()

  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return jsonResponse({
        sessions: [
          { id: 'stub', fileName: 'session-500.jsonl', startedAt: 500, sizeBytes: 20 },
          { id: 'rich', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 500 },
        ],
      })
    }
    if (href === '/api/sessions/stub/events') return jsonResponse({ events: stubEvents })
    if (href === '/api/sessions/rich/events') return jsonResponse({ events: richEvents })
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

describe('ReplayControls', () => {
  it('shows a session picker and stays idle until one is chosen', async () => {
    render(
      <ModeProvider fetchImpl={makeFetch(fixtureEvents())}>
        <ReplayControls />
      </ModeProvider>,
    )

    expect(await screen.findByText('Live mode')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(await screen.findByRole('option', { name: /^1970-01-01T00:00:01/ })).toBeInTheDocument()
  })

  it('loads a session and folds state up to the scrubber position', async () => {
    render(
      <ModeProvider fetchImpl={makeFetch(fixtureEvents())}>
        <ReplayControls />
      </ModeProvider>,
    )

    const select = await screen.findByLabelText('session')
    fireEvent.change(select, { target: { value: 's1' } })

    await waitFor(() => expect(screen.getByText('Replay mode')).toBeInTheDocument())

    const scrubber = screen.getByLabelText('Replay scrubber')
    fireEvent.change(scrubber, { target: { value: '2000' } })
    await waitFor(() => expect(screen.getByText(/^1 worktrees/)).toBeInTheDocument())

    fireEvent.change(scrubber, { target: { value: '3000' } })
    await waitFor(() => expect(screen.getByText(/^2 worktrees/)).toBeInTheDocument())
  })

  it('returning to live clears the session and disables the transport', async () => {
    render(
      <ModeProvider fetchImpl={makeFetch(fixtureEvents())}>
        <ReplayControls />
      </ModeProvider>,
    )

    const select = await screen.findByLabelText('session')
    fireEvent.change(select, { target: { value: 's1' } })
    await waitFor(() => expect(screen.getByText('Replay mode')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /return to live/i }))

    await waitFor(() => expect(screen.getByText('Live mode')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })

  it('play/pause toggles the transport button label', async () => {
    render(
      <ModeProvider fetchImpl={makeFetch(fixtureEvents())}>
        <ReplayControls />
      </ModeProvider>,
    )

    const select = await screen.findByLabelText('session')
    fireEvent.change(select, { target: { value: 's1' } })
    await waitFor(() => expect(screen.getByText('Replay mode')).toBeInTheDocument())

    const transport = screen.getByRole('button', { name: 'Play' })
    fireEvent.click(transport)
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('invites session selection instead of reading as a dead status strip', async () => {
    render(
      <ModeProvider fetchImpl={makeFetch(fixtureEvents())}>
        <ReplayControls />
      </ModeProvider>,
    )

    expect(await screen.findByText('Live mode')).toBeInTheDocument()
    expect(screen.getByText('Replay')).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Replay a recorded session…' }),
    ).toBeInTheDocument()
  })

  it("Play explains why it's disabled before a session is chosen", async () => {
    render(
      <ModeProvider fetchImpl={makeFetch(fixtureEvents())}>
        <ReplayControls />
      </ModeProvider>,
    )

    const play = await screen.findByRole('button', { name: 'Play' })
    expect(play).toBeDisabled()
    expect(play).toHaveAttribute('title', expect.stringMatching(/session/i))
  })

  it("replaying this session's birth picks the richest session and starts playing", async () => {
    render(
      <ModeProvider fetchImpl={makeMultiSessionFetch()}>
        <ReplayControls />
      </ModeProvider>,
    )

    const birthButton = await screen.findByRole('button', {
      name: "Replay this session's birth",
    })
    expect(birthButton).toBeEnabled()
    fireEvent.click(birthButton)

    await waitFor(() => expect(screen.getByText('Replay mode')).toBeInTheDocument())
    expect(screen.getByLabelText('session')).toHaveValue('rich')
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('shows the real duration once a session is loaded, not 0:00 / 0:00', async () => {
    render(
      <ModeProvider fetchImpl={makeFetch(fixtureEvents())}>
        <ReplayControls />
      </ModeProvider>,
    )

    const select = await screen.findByLabelText('session')
    fireEvent.change(select, { target: { value: 's1' } })

    await waitFor(() => expect(screen.getByText('Replay mode')).toBeInTheDocument())
    // Fixture events span ts 1000..3000 — a 2 second session, not an empty one.
    expect(await screen.findByText('0:02')).toBeInTheDocument()
  })
})
