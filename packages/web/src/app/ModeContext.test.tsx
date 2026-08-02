import { createEvent, createIdFactory } from '@rhizomorph/core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchLike } from '../replay/api.js'
import { ModeProvider, REPLAY_CHROME_CLASSES, useReplay } from './ModeContext.js'

afterEach(cleanup)

const nextId = createIdFactory('evt')

function sessionEvents() {
  return [
    createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: 1_000 },
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

function ReplayDriver() {
  const { sessions, selectSession } = useReplay()
  return (
    <>
      <button onClick={() => selectSession(sessions[0]?.id ?? null)}>select session</button>
      <button onClick={() => selectSession(null)}>exit to live</button>
    </>
  )
}

describe('ModeProvider — shell-level frame and tint', () => {
  it('carries no mode-tint classes on the body while live', () => {
    render(
      <ModeProvider fetchImpl={makeFetch()}>
        <ReplayDriver />
      </ModeProvider>,
    )

    expect(document.body.dataset.mode).toBe('live')
    for (const cls of REPLAY_CHROME_CLASSES) expect(document.body.classList.contains(cls)).toBe(false)
  })

  it('applies the tint/frame classes to the body once replay is entered', async () => {
    await act(async () => {
      render(
        <ModeProvider fetchImpl={makeFetch()}>
          <ReplayDriver />
        </ModeProvider>,
      )
    })

    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })

    expect(document.body.dataset.mode).toBe('replay')
    for (const cls of REPLAY_CHROME_CLASSES) expect(document.body.classList.contains(cls)).toBe(true)
  })

  it('removes the tint/frame classes on exit to live', async () => {
    await act(async () => {
      render(
        <ModeProvider fetchImpl={makeFetch()}>
          <ReplayDriver />
        </ModeProvider>,
      )
    })
    await act(async () => {
      fireEvent.click(screen.getByText('select session'))
    })
    expect(document.body.dataset.mode).toBe('replay')

    await act(async () => {
      fireEvent.click(screen.getByText('exit to live'))
    })

    expect(document.body.dataset.mode).toBe('live')
    for (const cls of REPLAY_CHROME_CLASSES) expect(document.body.classList.contains(cls)).toBe(false)
  })

  it('cleans up body classes on unmount so a later mount starts clean', async () => {
    const utils = render(
      <ModeProvider fetchImpl={makeFetch()}>
        <ReplayDriver />
      </ModeProvider>,
    )
    utils.unmount()
    expect(document.body.dataset.mode).toBeUndefined()
    for (const cls of REPLAY_CHROME_CLASSES) expect(document.body.classList.contains(cls)).toBe(false)
  })
})
