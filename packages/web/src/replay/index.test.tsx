import { createEvent, createIdFactory, estimateCostUsd } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ModeProvider } from '../app/ModeContext.js'
import ReplayControls from './index.js'
import type { FetchLike } from './api.js'

afterEach(cleanup)

/**
 * `render` only act-wraps the synchronous commit; the session list arrives
 * later via a mocked `fetch().then(...)` chain. Awaiting an async `act`
 * flushes that chain's microtasks before the test's first assertion, so
 * `sessions` is deterministically populated instead of racing a `findBy*`'s
 * default 1000ms timeout against scheduler load (the class of bug from #28,
 * now in this file too — see #31).
 */
async function renderReplay(fetchImpl: FetchLike) {
  let utils!: ReturnType<typeof render>
  await act(async () => {
    utils = render(
      <ModeProvider fetchImpl={fetchImpl}>
        <ReplayControls />
      </ModeProvider>,
    )
  })
  return utils
}

/** Selecting a session (or the "birth" button) kicks off its own mocked fetch chain — flush it the same way. */
async function fireAndFlush(fn: () => void) {
  await act(async () => {
    fn()
  })
}

const nextId = createIdFactory('evt')

function fixtureEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
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
      { sessionId: 'stub', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
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
    await renderReplay(makeFetch(fixtureEvents()))

    expect(screen.getByText('Live mode')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
    expect(screen.getByRole('option', { name: /^1970-01-01T00:00:01/ })).toBeInTheDocument()
  })

  it('loads a session and folds state up to the scrubber position', async () => {
    await renderReplay(makeFetch(fixtureEvents()))

    const select = screen.getByLabelText('session')
    await fireAndFlush(() => fireEvent.change(select, { target: { value: 's1' } }))

    expect(screen.getByText('Replay mode')).toBeInTheDocument()

    const scrubber = screen.getByLabelText('Replay scrubber')
    fireEvent.change(scrubber, { target: { value: '2000' } })
    await waitFor(() => expect(screen.getByText(/^1 worktrees/)).toBeInTheDocument())

    fireEvent.change(scrubber, { target: { value: '3000' } })
    await waitFor(() => expect(screen.getByText(/^2 worktrees/)).toBeInTheDocument())
  })

  it('returning to live clears the session and disables the transport', async () => {
    await renderReplay(makeFetch(fixtureEvents()))

    const select = screen.getByLabelText('session')
    await fireAndFlush(() => fireEvent.change(select, { target: { value: 's1' } }))
    expect(screen.getByText('Replay mode')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /return to live/i }))

    await waitFor(() => expect(screen.getByText('Live mode')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Play' })).toBeDisabled()
  })

  it('play/pause toggles the transport button label', async () => {
    await renderReplay(makeFetch(fixtureEvents()))

    const select = screen.getByLabelText('session')
    await fireAndFlush(() => fireEvent.change(select, { target: { value: 's1' } }))
    expect(screen.getByText('Replay mode')).toBeInTheDocument()

    const transport = screen.getByRole('button', { name: 'Play' })
    fireEvent.click(transport)
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('invites session selection instead of reading as a dead status strip', async () => {
    await renderReplay(makeFetch(fixtureEvents()))

    expect(screen.getByText('Live mode')).toBeInTheDocument()
    expect(screen.getByText('Replay')).toBeInTheDocument()
    expect(
      screen.getByRole('option', { name: 'Replay a recorded session…' }),
    ).toBeInTheDocument()
  })

  it("Play explains why it's disabled before a session is chosen", async () => {
    await renderReplay(makeFetch(fixtureEvents()))

    const play = screen.getByRole('button', { name: 'Play' })
    expect(play).toBeDisabled()
    expect(play).toHaveAttribute('title', expect.stringMatching(/session/i))
  })

  it("replaying this session's birth picks the richest session and starts playing", async () => {
    await renderReplay(makeMultiSessionFetch())

    const birthButton = screen.getByRole('button', { name: "Replay this session's birth" })
    expect(birthButton).toBeEnabled()
    await fireAndFlush(() => fireEvent.click(birthButton))

    expect(screen.getByText('Replay mode')).toBeInTheDocument()
    expect(screen.getByLabelText('session')).toHaveValue('rich')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
  })

  it('shows the real duration once a session is loaded, not 0:00 / 0:00', async () => {
    await renderReplay(makeFetch(fixtureEvents()))

    const select = screen.getByLabelText('session')
    await fireAndFlush(() => fireEvent.change(select, { target: { value: 's1' } }))

    expect(screen.getByText('Replay mode')).toBeInTheDocument()
    // Fixture events span ts 1000..3000 — a 2 second session, not an empty one.
    expect(screen.getByText('0:02')).toBeInTheDocument()
  })
})

describe('ReplayControls — session titles (#156)', () => {
  function makeFetchWithMeta(
    session: Record<string, unknown>,
    events: ReturnType<typeof fixtureEvents> = fixtureEvents(),
  ): FetchLike {
    return (async (url: string | URL | Request) => {
      const href = String(url)
      if (href === '/api/sessions') {
        return jsonResponse({ sessions: [session] })
      }
      if (href === `/api/sessions/${session.id as string}/events`) {
        return jsonResponse({ events })
      }
      throw new Error(`unexpected fetch: ${href}`)
    }) as unknown as FetchLike
  }

  it('shows the auto-title from the server when no label was set', async () => {
    await renderReplay(
      makeFetchWithMeta({
        id: 's1',
        fileName: 'session-1000.jsonl',
        startedAt: 1000,
        sizeBytes: 100,
        title: '2026-08-04 · 6 lanes · 5 landed · #144 #148 #152',
        label: null,
        lanes: 6,
        landed: 5,
      }),
    )

    expect(
      screen.getByRole('option', { name: '2026-08-04 · 6 lanes · 5 landed · #144 #148 #152' }),
    ).toBeInTheDocument()
  })

  it('shows the operator label instead of the auto-title once one is set', async () => {
    await renderReplay(
      makeFetchWithMeta({
        id: 's1',
        fileName: 'session-1000.jsonl',
        startedAt: 1000,
        sizeBytes: 100,
        title: '2026-08-04 · 6 lanes · 5 landed · #144 #148 #152',
        label: 'the scene lands',
        lanes: 6,
        landed: 5,
      }),
    )

    expect(screen.getByRole('option', { name: 'the scene lands' })).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: '2026-08-04 · 6 lanes · 5 landed · #144 #148 #152' }),
    ).not.toBeInTheDocument()
  })

  it('falls back to the raw timestamp when a server has not grown a title yet', async () => {
    await renderReplay(makeFetch(fixtureEvents()))
    expect(screen.getByRole('option', { name: /^1970-01-01T00:00:01/ })).toBeInTheDocument()
  })
})

/** Same shape as `fixtureEvents`, plus one lane's tokens and a dollar cost landing later. */
function moneyEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 'm1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: 1000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: 'sha-0', isMain: true },
      { id: nextId(), ts: 2000 },
    ),
    createEvent(
      'llm.usage',
      {
        lane: 'a',
        role: 'worker',
        model: 'claude-opus-5',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
      },
      { id: nextId(), ts: 3000 },
    ),
    createEvent(
      'llm.cost',
      { lane: 'a', role: 'worker', model: 'claude-opus-5', costUsd: 1.5, authoritative: true },
      { id: nextId(), ts: 4000 },
    ),
  ]
}

function makeMoneyFetch(): FetchLike {
  const events = moneyEvents()
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return jsonResponse({
        sessions: [{ id: 'm1', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 100 }],
      })
    }
    if (href === '/api/sessions/m1/events') return jsonResponse({ events })
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

describe('ReplayControls — spend', () => {
  it('shows a flagged estimate at the scrub point where only tokens have landed (prd9 ruling 7)', async () => {
    // Reconciled for ruling 7: at ts=3000 the `llm.cost` event (ts=4000) has not
    // scrubbed into view yet, so this usage genuinely has no authoritative cost
    // AT THIS SCRUB POINT — exactly the case the vendored pricing table now
    // estimates on read, rather than the pre-pricing "1 tok out" fallback this
    // test used to assert. `formatSpend` does not distinguish authoritative
    // from estimated (see its own doc comment), so the scrub line renders the
    // same tiny dollar figure `estimateCostUsd` would.
    await renderReplay(makeMoneyFetch())

    const select = screen.getByLabelText('session')
    await fireAndFlush(() => fireEvent.change(select, { target: { value: 'm1' } }))

    const scrubber = screen.getByLabelText('Replay scrubber')
    fireEvent.change(scrubber, { target: { value: '3000' } })
    const estimate = estimateCostUsd('claude-opus-5', { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 })
    expect(estimate).not.toBeNull()
    expect(estimate!.costUsd).toBeLessThan(0.01)
    await waitFor(() => expect(screen.getByText(/<\$0\.01 as of scrub time/)).toBeInTheDocument())
  })

  it('switches the scrub line to dollars once an authoritative cost event lands', async () => {
    await renderReplay(makeMoneyFetch())

    const select = screen.getByLabelText('session')
    await fireAndFlush(() => fireEvent.change(select, { target: { value: 'm1' } }))

    const scrubber = screen.getByLabelText('Replay scrubber')
    fireEvent.change(scrubber, { target: { value: '4000' } })
    await waitFor(() => expect(screen.getByText(/\$1\.50 as of scrub time/)).toBeInTheDocument())
  })

  it('shows the whole session total in the picker regardless of scrub position', async () => {
    await renderReplay(makeMoneyFetch())

    const select = screen.getByLabelText('session')
    await fireAndFlush(() => fireEvent.change(select, { target: { value: 'm1' } }))

    const scrubber = screen.getByLabelText('Replay scrubber')
    fireEvent.change(scrubber, { target: { value: '3000' } })
    // The scrub line hasn't reached the cost event yet, but the session total already has.
    await waitFor(() => expect(screen.getByText('total $1.50')).toBeInTheDocument())
  })

  it('has no total badge before a session is selected', async () => {
    await renderReplay(makeMoneyFetch())
    expect(screen.queryByText(/^total /)).not.toBeInTheDocument()
  })
})
