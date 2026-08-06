import { describe, expect, it, vi } from 'vitest'
import { LAUNCH_URL, requestLaunch, type LaunchFetchLike, type LaunchOutcome } from './launch.js'

/**
 * The app's third mutating call. Same discipline as `replay/rotate.test.ts`
 * and `recordings/label.test.ts`: never believe an answer it doesn't
 * recognise, and never throw away a partial outcome — arms that already
 * dispatched already spent real money.
 */

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
  it('asks the one route, with the one verb, a JSON body naming lane, checkpointId and arms', async () => {
    const fetchImpl = vi.fn(answering(OUTCOME))
    const request = { lane: 'feature', checkpointId: 'ckpt-1', arms: [{ model: 'opus', brief: 'try X' }] }

    const outcome = await requestLaunch(request, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(LAUNCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    expect(outcome).toEqual(OUTCOME)
  })

  it("surfaces the instrument's own refusal, so the launch dialog can show it", async () => {
    const fetchImpl = answering({ error: 'this server is replaying a session record' }, 409)
    await expect(requestLaunch({ lane: 'x', checkpointId: 'y', arms: [{}] }, fetchImpl)).rejects.toThrow(
      'could not launch — this server is replaying a session record',
    )
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
