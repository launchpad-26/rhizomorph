import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPABILITY_META_NAME } from '../../recordings/capability.js'
import { missingTokenMessage, staleTokenMessage } from '../../recordings/capability-guidance.js'
import type { LabRdRun } from '../types.js'
import { RD_URL, type RdFetchLike, requestRd } from './rd.js'

/**
 * The app's eighth mutating call, unit-tested in isolation (same discipline
 * `lab/launch/launch.test.ts` and `lab/measure.test.ts` keep): never believe
 * an answer this module doesn't recognise, never throw a graceful
 * `available: false` answer as if it were a failure, and always carry the
 * capability token. `packages/contract/src/lab-rd.contract.test.ts` proves the
 * same client against the REAL server; this file proves the client alone.
 */

const TEST_TOKEN = 'test-capability-token'

beforeAll(() => {
  const meta = document.createElement('meta')
  meta.setAttribute('name', CAPABILITY_META_NAME)
  meta.setAttribute('content', TEST_TOKEN)
  document.head.appendChild(meta)
})

function answering(payload: unknown, status = 200): RdFetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => payload })
}

const LIVE_RUN: LabRdRun = {
  lane: 'feature',
  available: true,
  reason: null,
  corpus: { choice: 'local', digest: 'a'.repeat(64), itemCount: 3, trackerRefusal: null },
  patterns: [{ patternId: 'p1', shape: 'a shape', sourceItems: ['fork.measured/lane@1'], count: 2, heldBack: false }],
  proposals: [
    {
      proposalId: 'proposal-1',
      patternId: 'p1',
      varies: 'model',
      arms: [
        { model: 'sonnet', briefDigest: null, checkpointId: 'ckpt-1', gateCommand: null },
        { model: 'opus', briefDigest: null, checkpointId: 'ckpt-1', gateCommand: null },
      ],
      checkpointPick: { chosenCheckpointId: 'ckpt-1', rejected: [] },
    },
  ],
  refusals: [],
  provenance: {
    model: 'sonnet',
    total_cost_usd: 0.12,
    duration_ms: 4000,
    promptDigest: 'b'.repeat(64),
    corpusDigest: 'c'.repeat(64),
    claudeVersion: '2.1.266',
    corpus: 'local',
  },
  turns: 3,
}

const NO_CLI_RUN: LabRdRun = {
  lane: 'feature',
  available: false,
  reason: "no claude on this machine's PATH — the R&D hand is your CLI, installed by you",
  corpus: { choice: 'local', digest: '', itemCount: 0, trackerRefusal: null },
  patterns: [],
  proposals: [],
  refusals: [],
  provenance: null,
  turns: 0,
}

describe('requestRd', () => {
  it('asks the one route, with the one verb, a JSON body naming lane/model/corpus, and the capability header', async () => {
    const fetchImpl = vi.fn(answering(LIVE_RUN))
    const request = { lane: 'feature', model: 'sonnet', corpus: 'local' as const }

    const run = await requestRd(request, fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(RD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-rhizomorph-capability': TEST_TOKEN },
      body: JSON.stringify(request),
    })
    expect(run).toEqual(LIVE_RUN)
  })

  it('a graceful "no CLI" answer is returned, never thrown — ruling 9 draws it as a state, not a failure', async () => {
    const fetchImpl = answering(NO_CLI_RUN)
    const run = await requestRd({ lane: 'feature', model: 'sonnet', corpus: 'local' }, fetchImpl)
    expect(run.available).toBe(false)
    expect(run.reason).toBe(NO_CLI_RUN.reason)
  })

  it('throws — never silently invents a run — on a non-ok response, naming the server\'s own sentence', async () => {
    const fetchImpl = answering({ error: 'could not read the R&D result for lane feature' }, 500)
    await expect(requestRd({ lane: 'feature', model: 'sonnet', corpus: 'local' }, fetchImpl)).rejects.toThrow(
      'could not read and propose — could not read the R&D result for lane feature',
    )
  })

  it('throws on a response shape it does not recognise, rather than rendering a half-built run', async () => {
    const fetchImpl = answering({ lane: 'feature' })
    await expect(requestRd({ lane: 'feature', model: 'sonnet', corpus: 'local' }, fetchImpl)).rejects.toThrow(
      /instrument answered something other than an R&D result/,
    )
  })

  it('401 crosses the server\'s own sentence back with the reload remedy appended', async () => {
    const fetchImpl = answering({ error: 'missing or invalid x-rhizomorph-capability' }, 401)
    await expect(requestRd({ lane: 'feature', model: 'sonnet', corpus: 'local' }, fetchImpl)).rejects.toThrow(
      staleTokenMessage('read and propose', 'missing or invalid x-rhizomorph-capability'),
    )
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    document.querySelector(`meta[name="${CAPABILITY_META_NAME}"]`)?.remove()
    const fetchImpl = vi.fn(answering(LIVE_RUN))

    await expect(requestRd({ lane: 'feature', model: 'sonnet', corpus: 'local' }, fetchImpl)).rejects.toThrow(
      missingTokenMessage('read and propose'),
    )
    expect(fetchImpl).not.toHaveBeenCalled()

    // restore for any test that runs after this one in the same file
    const meta = document.createElement('meta')
    meta.setAttribute('name', CAPABILITY_META_NAME)
    meta.setAttribute('content', TEST_TOKEN)
    document.head.appendChild(meta)
  })
})
