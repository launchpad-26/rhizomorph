
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../recordings/capability.js'
import { ROTATE_URL, type RotateFetchLike, requestRotation } from './rotate.js'

/**
 * The app's first mutating call. What it must never do is believe an answer it
 * doesn't recognise: a rotation the operator was told happened, but didn't,
 * would send them looking in the picker for a recording that isn't there.
 *
 * Since #234 it must also carry the per-process capability token, because the
 * route now requires it — the reason that widening is here, in the same commit
 * as the gate, is #249: `/api/label` was gated with no way for its caller to
 * authenticate and 401ed on every boot for weeks, looking like a UI bug. The
 * last block of this file is the seam test that makes the same mistake
 * impossible on this route: real served page, real client, real gate.
 */

const ROTATION = {
  closed: { sessionId: '1000', filePath: '/data/repo/session-1000.jsonl', eventCount: 1234 },
  opened: { sessionId: '5000', filePath: '/data/repo/session-5000.jsonl', startedAt: 5000 },
}

const TEST_TOKEN = 'test-capability-token'

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249, ADR-0012). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', TEST_TOKEN)
  document.head.appendChild(meta)
})

function answering(payload: unknown, status = 200): RotateFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

describe('requestRotation', () => {
  it('asks the one route, with the one verb, carrying the capability token, and returns both sides of the boundary', async () => {
    const fetchImpl = vi.fn(answering(ROTATION))

    const rotation = await requestRotation(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(ROTATE_URL, {
      method: 'POST',
      headers: { 'x-rhizomorph-capability': TEST_TOKEN },
    })
    expect(rotation).toEqual({
      closed: { sessionId: '1000', eventCount: 1234 },
      opened: { sessionId: '5000' },
    })
  })

  /**
   * ADR-0012's known dev-mode gap, made honest rather than closed (closing it
   * needs a vite plugin and proxy config, which is out of #234's scope). Under
   * `npm run dev:web` vite serves `index.html` itself, so the server's
   * injection never runs and this page has no token. The operator must read
   * what is missing and what to run — a bare 401 about a header they cannot
   * supply is the failure mode that hid #249 for weeks.
   */
  it('refuses before the wire when the page carries no token, naming what is missing and what to run', async () => {
    const meta = document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)
    const content = meta?.getAttribute('content') ?? null
    meta?.remove()
    const fetchImpl = vi.fn(answering(ROTATION))

    try {
      const failure = await requestRotation(fetchImpl).catch((err: unknown) => err)

      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain('this page carries no capability token')
      expect(message).toContain('dev:web')
      expect(message).toContain('npm run build')
      // Nothing was sent — a request that cannot be authorised is not made.
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      const restored = document.createElement('meta')
      restored.setAttribute('name', CAPABILITY_META_NAME)
      restored.setAttribute('content', content ?? TEST_TOKEN)
      document.head.appendChild(restored)
    }
  })

  it("surfaces the instrument's own refusal, so the button can show it", async () => {
    const fetchImpl = answering({ error: 'this server is replaying a session record' }, 409)

    await expect(requestRotation(fetchImpl)).rejects.toThrow(
      'could not end the session — this server is replaying a session record',
    )
  })

  /**
   * The token is minted per server process and stamped into the page at serve
   * time, so a tab left open across a restart holds one that no longer
   * exists. The up-front check cannot catch that — there IS a token on the
   * page, it is simply dead — so the only place to say so is here, on the
   * 401. The server's own sentence names a header, which is true and useless
   * to someone looking at a button; it is kept, and what to do is added.
   */
  it('tells the operator to reload when the token on this page outlived the server that minted it', async () => {
    const fetchImpl = answering(
      { error: 'missing or invalid x-rhizomorph-capability header — this route requires the per-process capability token' },
      401,
    )

    const failure = await requestRotation(fetchImpl).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    // The server's own sentence still crosses back…
    expect(message).toContain('missing or invalid x-rhizomorph-capability')
    // …and the operator is told what to actually do about it.
    expect(message).toMatch(/reload this page/i)
    expect(message).toMatch(/every time it starts/i)
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

// The rotation seam block moved to packages/contract/src/rotate.contract.test.ts
// (prd-24 ruling 1, #310) — claims intact, through the shared harness.

