import { createEvent, createIdFactory } from '@rhizomorph/core'
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

/** An entry the way a NEWER instrument would serve it — prd17 ruling 1's own families. */
const FUTURE_ENTRY = {
  id: 'evt-future-1',
  ts: 5,
  source: 'system',
  type: 'summons.raised',
  payload: { lane: 'a' },
}

describe('fetchSessionEvents', () => {
  it('requests the session-scoped url and validates events', async () => {
    const event = createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: 1 },
    )
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe('/api/sessions/s1/events')
      return jsonResponse({ events: [event, { garbage: true }] })
    }) as unknown as FetchLike

    const read = await fetchSessionEvents('s1', fetchImpl)
    expect(read.events).toEqual([event])
    // `{ garbage: true }` is not an event at all — no envelope, no timestamp —
    // so it is still dropped, not dressed up as a newer era.
    expect(read.unknown).toEqual([])
  })

  it('URL-encodes the session id', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(url).toBe('/api/sessions/has%20space/events')
      return jsonResponse({ events: [] })
    }) as unknown as FetchLike

    await fetchSessionEvents('has space', fetchImpl)
  })

  /**
   * prd17 ruling 3, item 1. This used to `parseEvent` each entry and drop the
   * failures on the floor, so a bundle older than the server it is talking to
   * folded a quietly shorter history — a cached page, a tab left open across a
   * deploy, or a foreign actor's record served through `rhizomorph replay`.
   */
  it('counts an event from a newer era instead of dropping it', async () => {
    const event = createEvent(
      'session.started',
      { sessionId: 's1', repoPath: '/repo', repoName: 'rhizomorph', mainBranch: 'main' },
      { id: nextId(), ts: 1 },
    )
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ events: [event, FUTURE_ENTRY] }),
    ) as unknown as FetchLike

    const read = await fetchSessionEvents('s1', fetchImpl)
    expect(read.events).toEqual([event])
    expect(read.unknown).toHaveLength(1)
    expect(read.unknown[0]?.type).toBe('summons.raised')
    expect(read.unknown[0]?.ts).toBe(5)
    // Preserved — what the API served, which is all this surface ever had.
    expect(JSON.parse(read.unknown[0]?.line ?? 'null')).toEqual(FUTURE_ENTRY)
  })

  it('counts every unknown, not just the first', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        events: [
          FUTURE_ENTRY,
          { ...FUTURE_ENTRY, id: 'evt-future-2', type: 'operator.ack' },
          { ...FUTURE_ENTRY, id: 'evt-future-3' },
        ],
      }),
    ) as unknown as FetchLike

    const read = await fetchSessionEvents('s1', fetchImpl)
    expect(read.events).toEqual([])
    expect(read.unknown.map((entry) => entry.type)).toEqual([
      'summons.raised',
      'operator.ack',
      'summons.raised',
    ])
  })
})
