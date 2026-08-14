
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../../recordings/capability.js'
import { LAUNCH_URL, type LaunchFetchLike, type LaunchOutcome, requestLaunch } from './launch.js'

/**
 * The app's third mutating call. Same discipline as `replay/rotate.test.ts`
 * and `recordings/label.test.ts`: never believe an answer it doesn't
 * recognise, and never throw away a partial outcome — arms that already
 * dispatched already spent real money.
 *
 * Since #234 it must also carry the per-process capability token, because the
 * route now requires it. The last block is the seam test that keeps that
 * widening honest: real served page, real client, real gate — the arrangement
 * whose absence let #249 ship a route no caller could authenticate to.
 */

const TEST_TOKEN = 'test-capability-token'

/** Stands in for what `server/static.ts` stamps into `index.html` on a real boot (#249, ADR-0012). */
beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', TEST_TOKEN)
  document.head.appendChild(meta)
})

function answering(payload: unknown, status = 200): LaunchFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

const OUTCOME: LaunchOutcome = {
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      model: 'opus',
      briefProvided: true,
      forkId: 'fork-abc',
      laneHandle: 'fork-abc-arm-1',
      worktreePath: '/data/lab/worktrees/fork-abc-arm-1',
      launched: true,
    },
  ],
  failed: null,
}

describe('requestLaunch', () => {
  it('asks the one route, with the one verb, a JSON body naming lane, checkpointId and arms, and the capability header', async () => {
    const fetchImpl = vi.fn(answering(OUTCOME))
    const request = { lane: 'feature', checkpointId: 'ckpt-1', arms: [{ model: 'opus', brief: 'try X' }] }

    const outcome = await requestLaunch(request, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(LAUNCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rhizomorph-capability': TEST_TOKEN },
      body: JSON.stringify(request),
    })
    expect(outcome).toEqual(OUTCOME)
  })

  /**
   * ADR-0012's known dev-mode gap, made honest rather than closed. Under `npm
   * run dev:web` vite serves `index.html` itself, so the injection never runs
   * and this page has no token. The operator must read what is missing and
   * what to run — especially here, where the alternative is a launch dialog
   * showing a bare 401 about a header they cannot supply.
   */
  it('refuses before the wire when the page carries no token, naming what is missing and what to run', async () => {
    const meta = document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)
    const content = meta?.getAttribute('content') ?? null
    meta?.remove()
    const fetchImpl = vi.fn(answering(OUTCOME))

    try {
      const failure = await requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, fetchImpl).catch(
        (err: unknown) => err,
      )

      expect(failure).toBeInstanceOf(Error)
      const message = (failure as Error).message
      expect(message).toContain('this page carries no capability token')
      expect(message).toContain('dev:web')
      expect(message).toContain('npm run build')
      // Nothing was dispatched — a launch that cannot be authorised is not sent.
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      const restored = document.createElement('meta')
      restored.setAttribute('name', CAPABILITY_META_NAME)
      restored.setAttribute('content', content ?? TEST_TOKEN)
      document.head.appendChild(restored)
    }
  })

  it("surfaces the instrument's own refusal, so the launch dialog can show it", async () => {
    const fetchImpl = answering({ error: 'this server is replaying a session record' }, 409)
    await expect(requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, fetchImpl)).rejects.toThrow(
      'could not launch — this server is replaying a session record',
    )
  })

  /**
   * Same staleness as `replay/rotate.ts`, and it costs more here: by the time
   * this refusal appears the operator has configured every arm and read a
   * spend estimate, so a message that doesn't say "reload" makes them do all
   * of it again to find out.
   */
  it('tells the operator to reload when the token on this page outlived the server that minted it', async () => {
    const fetchImpl = answering(
      { error: 'missing or invalid x-rhizomorph-capability header — this route requires the per-process capability token' },
      401,
    )

    const failure = await requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, fetchImpl).catch(
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain('missing or invalid x-rhizomorph-capability')
    expect(message).toMatch(/reload this page/i)
    expect(message).toMatch(/every time it starts/i)
  })

  it('falls back to the status when a refusal carries no message', async () => {
    await expect(
      requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, answering(null, 500)),
    ).rejects.toThrow('the server answered 500')
  })

  it('says the instrument is unreachable rather than swallowing a network failure', async () => {
    const fetchImpl: LaunchFetchLike = async () => {
      throw new Error('NetworkError')
    }
    await expect(requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, fetchImpl)).rejects.toThrow(
      'could not reach the instrument: NetworkError',
    )
  })

  it('refuses to report a launch from an answer that is not one', async () => {
    for (const payload of [{}, { parentLane: 'x' }, 'ok', { parentLane: 'x', checkpointId: 'y', arms: 'nope', failed: null }]) {
      await expect(requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, answering(payload))).rejects.toThrow(
        'the instrument answered something other than a launch result',
      )
    }
  })

  it('reports a partial outcome (some arms dispatched, one failed) rather than throwing it away', async () => {
    const partial: LaunchOutcome = {
      ...OUTCOME,
      failed: { arm: 2, error: 'workmux add fork-abc-arm-2 -b failed: tmux server not running' },
    }
    const outcome = await requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}, {}] }, answering(partial))
    expect(outcome.arms).toHaveLength(1)
    expect(outcome.failed).toEqual({ arm: 2, error: 'workmux add fork-abc-arm-2 -b failed: tmux server not running' })
  })
})

// The launch seam block moved to packages/contract/src/launch.contract.test.ts
// (prd-24 ruling 1, #310) — claims intact, through the shared harness.

