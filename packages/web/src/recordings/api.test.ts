import { describe, expect, it } from 'vitest'
import { fetchRecordings, type FetchLike } from './api.js'

const RECORDING = {
  id: '1000',
  fileName: 'session-1000.jsonl',
  startedAt: 1000,
  sizeBytes: 4096,
  title: 'the morning run',
  label: 'the morning run',
  lanes: 3,
  landed: 1,
  durationMs: 60_000,
  outputTokens: 12_345,
  costUsd: 1.23,
  costIsAuthoritative: true,
  transcriptCapture: { sessionId: '1000', capturedAt: 2000, complete: true, totalBytes: 512, lanes: [] },
}

function answering(payload: unknown, status = 200): FetchLike {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })) as unknown as FetchLike
}

describe('fetchRecordings', () => {
  it('parses the listing GET /api/sessions already serves, recomputing nothing', async () => {
    const recordings = await fetchRecordings(answering({ sessions: [RECORDING] }))
    expect(recordings).toEqual([RECORDING])
  })

  it('throws with the status on a non-ok response, never a silently empty list', async () => {
    await expect(fetchRecordings(answering({ error: 'nope' }, 500))).rejects.toThrow('/api/sessions responded 500')
  })

  it('drops a malformed entry rather than rendering it half-formed', async () => {
    const recordings = await fetchRecordings(answering({ sessions: [RECORDING, { id: 'bad' }] }))
    expect(recordings).toEqual([RECORDING])
  })

  it('reads a listing built before capture existed — transcriptCapture simply absent', async () => {
    const withoutCapture: Record<string, unknown> = { ...RECORDING }
    delete withoutCapture.transcriptCapture
    const recordings = await fetchRecordings(answering({ sessions: [withoutCapture] }))
    expect(recordings).toEqual([withoutCapture])
    expect(recordings[0]?.transcriptCapture).toBeUndefined()
  })
})
