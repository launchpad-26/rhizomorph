import { beforeAll, describe, expect, it, vi } from 'vitest'
import { missingTokenMessage, staleTokenMessage } from './capability-guidance.js'
import { CAPABILITY_META_NAME } from './capability.js'
import { LABEL_URL, requestLabel, type LabelFetchLike } from './label.js'

/**
 * The app's second mutating call. Same discipline as `replay/rotate.test.ts`:
 * never believe an answer it doesn't recognise, so a rename the operator was
 * told saved, but didn't, would send them back to a listing still showing
 * the old title.
 */

const TEST_TOKEN = 'test-capability-token'

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', TEST_TOKEN)
  document.head.appendChild(meta)
})

function answering(payload: unknown, status = 200): LabelFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

describe('requestLabel', () => {
  it('asks the one route, with the one verb, a JSON body naming sessionId and label, and the capability header', async () => {
    const fetchImpl = vi.fn(answering({ sessionId: '1000', label: 'the morning run' }))

    const outcome = await requestLabel('1000', 'the morning run', fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(LABEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rhizomorph-capability': TEST_TOKEN },
      body: JSON.stringify({ sessionId: '1000', label: 'the morning run' }),
    })
    expect(outcome).toEqual({ sessionId: '1000', label: 'the morning run' })
  })

  it("surfaces the instrument's own refusal, so the rename control can show it", async () => {
    const fetchImpl = answering({ error: 'no session with id "1000"' }, 404)

    await expect(requestLabel('1000', 'x', fetchImpl)).rejects.toThrow(
      'could not save the label — no session with id "1000"',
    )
  })

  it('falls back to the status when a refusal carries no message', async () => {
    await expect(requestLabel('1000', 'x', answering(null, 500))).rejects.toThrow('the server answered 500')
  })

  it('says the instrument is unreachable rather than swallowing a network failure', async () => {
    const fetchImpl: LabelFetchLike = async () => {
      throw new Error('NetworkError')
    }

    await expect(requestLabel('1000', 'x', fetchImpl)).rejects.toThrow('could not reach the instrument: NetworkError')
  })

  it('refuses to report a save from an answer that is not one', async () => {
    for (const payload of [{}, { sessionId: '1000' }, { label: 'x' }, 'ok']) {
      await expect(requestLabel('1000', 'x', answering(payload))).rejects.toThrow(
        'the instrument answered something other than a saved label',
      )
    }
  })

  it('refuses to save without ever calling fetch, when the page has no capability token (#249)', async () => {
    const meta = document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)
    meta?.remove()
    try {
      const fetchImpl = vi.fn(answering({ sessionId: '1000', label: 'x' }))
      // #406: the refusal names the remedy, not only the problem. Asserted
      // against the shared copy rather than a literal, so this test cannot
      // drift out of agreement with the two sibling callers.
      await expect(requestLabel('1000', 'x', fetchImpl)).rejects.toThrow(missingTokenMessage('save the label'))
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      if (meta) document.head.appendChild(meta)
    }
  })

  /**
   * #406. The stale-token path — a tab left open across a server restart —
   * is the failure an operator is most likely to hit, and until now it fell
   * into the generic `!response.ok` branch and produced a true, useless
   * sentence about a header they never knew existed.
   *
   * Two assertions, because either alone is survivable: that the server's own
   * account still crosses back verbatim, AND that the remedy was added after
   * it. A test asserting only "reload this page" would pass on a branch that
   * threw the guidance away and lost what the instrument actually said.
   */
  it('turns a 401 into something an operator can act on, without discarding the server\'s own sentence (#406)', async () => {
    const fetchImpl = answering({ error: 'missing or invalid x-rhizomorph-capability header' }, 401)

    await expect(requestLabel('1000', 'x', fetchImpl)).rejects.toThrow(
      staleTokenMessage('save the label', 'missing or invalid x-rhizomorph-capability header'),
    )
    await expect(requestLabel('1000', 'x', fetchImpl)).rejects.toThrow(/missing or invalid x-rhizomorph-capability/)
    await expect(requestLabel('1000', 'x', fetchImpl)).rejects.toThrow(/reload this page/i)
  })

  it('leaves every other refusal on the generic branch — the 401 case is specific, not a catch-all (#406)', async () => {
    // The sibling case for the branch above: a 403 or a 500 must NOT be
    // dressed up as an expired token, or the guidance becomes noise that
    // sends operators to reload a page over an unrelated failure.
    for (const status of [403, 404, 500]) {
      await expect(requestLabel('1000', 'x', answering({ error: 'nope' }, status))).rejects.toThrow(
        'could not save the label — nope',
      )
      await expect(requestLabel('1000', 'x', answering({ error: 'nope' }, status))).rejects.not.toThrow(
        /reload this page/i,
      )
    }
  })
})
