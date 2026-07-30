import { createEvent, createIdFactory } from '@observatory/core'
import { describe, expect, it, vi } from 'vitest'
import { fetchSessionEvents, fetchSessions, type FetchLike } from './api.js'

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response
}

describe('fetchSessions', () => {
  it('requests /api/sessions and returns well-formed entries', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe('/api/sessions')
      return jsonResponse({
        sessions: [{ id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 42 }],
      })
    }) as unknown as FetchLike

    const sessions = await fetchSessions(fetchImpl)
    expect(sessions).toEqual([
      { id: '1000', fileName: 'session-1000.jsonl', startedAt: 1000, sizeBytes: 42 },
    ])
  })

  it('drops malformed entries instead of throwing', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ sessions: [{ id: '1' }, 'garbage', null] }),
    ) as unknown as FetchLike

    expect(await fetchSessions(fetchImpl)).toEqual([])
  })

  it('surfaces a non-ok response as a rejected promise', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false)) as unknown as FetchLike
    await expect(fetchSessions(fetchImpl)).rejects.toThrow()
  })
})

const nextId = createIdFactory('evt')

describe('fetchSessionEvents', () => {
  it('requests the session-scoped url and validates events', async () => {
    const event = createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'observatory', mainBranch: 'main' },
      { id: nextId(), ts: 1 },
    )
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe('/api/sessions/s1/events')
      return jsonResponse({ events: [event, { garbage: true }] })
    }) as unknown as FetchLike

    const events = await fetchSessionEvents('s1', fetchImpl)
    expect(events).toEqual([event])
  })

  it('URL-encodes the session id', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe('/api/sessions/has%20space/events')
      return jsonResponse({ events: [] })
    }) as unknown as FetchLike

    await fetchSessionEvents('has space', fetchImpl)
  })
})
