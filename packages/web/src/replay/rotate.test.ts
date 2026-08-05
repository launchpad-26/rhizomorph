import { describe, expect, it, vi } from 'vitest'
import { requestRotation, ROTATE_URL, type RotateFetchLike } from './rotate.js'

/**
 * The app's one mutating call. What it must never do is believe an answer it
 * doesn't recognise: a rotation the operator was told happened, but didn't,
 * would send them looking in the picker for a recording that isn't there.
 */

const ROTATION = {
  closed: { sessionId: '1000', filePath: '/data/repo/session-1000.jsonl', eventCount: 1234 },
  opened: { sessionId: '5000', filePath: '/data/repo/session-5000.jsonl', startedAt: 5000 },
}

function answering(payload: unknown, status = 200): RotateFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

describe('requestRotation', () => {
  it('asks the one route, with the one verb, and returns both sides of the boundary', async () => {
    const fetchImpl = vi.fn(answering(ROTATION))

    const rotation = await requestRotation(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(ROTATE_URL, { method: 'POST' })
    expect(rotation).toEqual({
      closed: { sessionId: '1000', eventCount: 1234 },
      opened: { sessionId: '5000' },
    })
  })

  it("surfaces the instrument's own refusal, so the button can show it", async () => {
    const fetchImpl = answering({ error: 'this server is replaying a session record' }, 409)

    await expect(requestRotation(fetchImpl)).rejects.toThrow(
      'could not end the session — this server is replaying a session record',
    )
  })

  it('falls back to the status when a refusal carries no message', async () => {
    await expect(requestRotation(answering(null, 500))).rejects.toThrow('the server answered 500')
  })

  it('says the instrument is unreachable rather than swallowing a network failure', async () => {
    const fetchImpl: RotateFetchLike = async () => {
      throw new Error('NetworkError')
    }

    await expect(requestRotation(fetchImpl)).rejects.toThrow('could not reach the instrument: NetworkError')
  })

  it('refuses to report a rotation from an answer that is not one', async () => {
    for (const payload of [{}, { closed: { sessionId: '1000' } }, { closed: {}, opened: {} }, 'ok']) {
      await expect(requestRotation(answering(payload))).rejects.toThrow(
        'the instrument answered something other than a rotation',
      )
    }
  })
})
