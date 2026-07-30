import { createEvent, createIdFactory } from '@observatory/core'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('ReplayControls', () => {
  it('shows a session picker and stays idle until one is chosen', async () => {
    render(<ReplayControls fetchImpl={makeFetch(fixtureEvents())} />)

    expect(await screen.findByText('Live mode')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(await screen.findByRole('option', { name: /^1970-01-01T00:00:01/ })).toBeInTheDocument()
  })

  it('loads a session and folds state up to the scrubber position', async () => {
    render(<ReplayControls fetchImpl={makeFetch(fixtureEvents())} />)

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
    render(<ReplayControls fetchImpl={makeFetch(fixtureEvents())} />)

    const select = await screen.findByLabelText('session')
    fireEvent.change(select, { target: { value: 's1' } })
    await waitFor(() => expect(screen.getByText('Replay mode')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /return to live/i }))

    await waitFor(() => expect(screen.getByText('Live mode')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })

  it('play/pause toggles the transport button label', async () => {
    render(<ReplayControls fetchImpl={makeFetch(fixtureEvents())} />)

    const select = await screen.findByLabelText('session')
    fireEvent.change(select, { target: { value: 's1' } })
    await waitFor(() => expect(screen.getByText('Replay mode')).toBeInTheDocument())

    const transport = screen.getByRole('button', { name: 'Play' })
    fireEvent.click(transport)
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })
})
