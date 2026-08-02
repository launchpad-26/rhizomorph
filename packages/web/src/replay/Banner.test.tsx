import { createEvent, createIdFactory } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ModeProvider, useReplay } from '../app/ModeContext.js'
import { ReplayBanner } from './Banner.js'
import type { FetchLike } from './api.js'

afterEach(cleanup)

const nextId = createIdFactory('evt')

function sessionEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: 1_000 },
    ),
    createEvent(
      'worktree.discovered',
      { path: '/repo', branch: 'main', head: 'sha-0', isMain: true },
      { id: nextId(), ts: 4_000 },
    ),
  ]
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function makeFetch(): FetchLike {
  return (async (url: string | URL | Request) => {
    const href = String(url)
    if (href === '/api/sessions') {
      return jsonResponse({
        sessions: [{ id: 's1', fileName: 'session-1000.jsonl', startedAt: 1_000, sizeBytes: 100 }],
      })
    }
    if (href === '/api/sessions/s1/events') {
      return jsonResponse({ events: sessionEvents() })
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as unknown as FetchLike
}

/** Drives session selection the same way the real replay controls do. */
function ReplayDriver() {
  const { sessions, selectSession } = useReplay()
  return <button onClick={() => selectSession(sessions[0]?.id ?? null)}>select session</button>
}

async function renderBanner() {
  await act(async () => {
    render(
      <ModeProvider fetchImpl={makeFetch()}>
        <ReplayBanner />
        <ReplayDriver />
      </ModeProvider>,
    )
  })
  await act(async () => {
    fireEvent.click(screen.getByText('select session'))
  })
}

describe('ReplayBanner', () => {
  it('states the past directly rather than through color', async () => {
    await renderBanner()
    expect(screen.getByText('Replay')).toBeInTheDocument()
    expect(screen.getByText(/viewing a recorded past/i)).toBeInTheDocument()
  })

  it('shows the timestamp being viewed, as an absolute wall clock', async () => {
    await renderBanner()
    // Playback starts at the session's first event, ts 1000ms.
    expect(screen.getByTitle('timestamp being viewed')).toHaveTextContent('1970-01-01 00:00:01')
  })

  it('shows session identity — repo and recording file', async () => {
    await renderBanner()
    const identity = screen.getByTitle('session identity')
    expect(identity).toHaveTextContent('rhizomorph')
    expect(identity).toHaveTextContent('session-1000.jsonl')
  })

  it('exits to live cleanly on click', async () => {
    await renderBanner()
    expect(screen.getByText('rhizomorph')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Exit to live' }))
    })

    expect(screen.queryByTitle('session identity')).not.toBeInTheDocument()
  })

  it('never reaches for a ladder hue — the mode shift is chrome, not a status', async () => {
    await renderBanner()
    const banner = screen.getByRole('status')
    // Law 9: none of the four alarm-ladder colour tokens may appear anywhere
    // in the banner's tree — a mode is not a status.
    for (const ladderHue of ['calm', 'notice', 'needs-you', 'broken']) {
      expect(banner.innerHTML).not.toContain(`-${ladderHue}`)
    }
  })
})
