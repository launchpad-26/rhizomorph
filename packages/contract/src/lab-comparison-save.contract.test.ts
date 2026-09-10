import { saveComparison } from '@rhizomorph/web/lab/compare/save'
import { missingTokenMessage } from '@rhizomorph/web/recordings/capability-guidance'
import { fetchComparison } from '@rhizomorph/web/recordings/comparisons'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

const INPUT = { arms: [{ id: 'a1', model: 'opus', brief: 'x', runs: [{ id: 'r1', status: 'complete' as const, verdict: 'pass' as const, value: 4 }] }] }

/**
 * `POST /api/lab/comparisons`'s contract test (prd-14 ruling 5, #214) — the
 * app's seventh mutating call, and the first web caller either comparison
 * route has ever had. The same three proofs the launch and measure contracts
 * give, because it is the same kind of door: a gated mutation the console
 * reaches through exactly one module (`replay/mutating-calls-law.test.ts`).
 */
describe('contract: saving a comparison (prd-14 ruling 5)', () => {
  let h: ContractHarness
  let restoreFetch: () => void

  beforeEach(async () => {
    h = await buildContractHarness()
    restoreFetch = routeGlobalFetchThroughHarness(h.fetch)
  })

  afterEach(async () => {
    restoreFetch()
    await h.close()
  })

  it('the token the server stamped is the token the client sends and the gate accepts — the write really lands', async () => {
    const outcome = await saveComparison(INPUT, h.fetch)

    expect(outcome.id).toEqual(expect.any(String))
    expect(outcome.savedAt).toEqual(expect.any(String))

    // Reads back through the real read route and the real read client, not
    // merely "the write returned 200" — the round trip this issue exists to
    // complete.
    const read = await fetchComparison(outcome.id)
    expect(read).toEqual({ id: outcome.id, available: true, artifact: { version: 1, savedAt: outcome.savedAt, input: INPUT } })
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back, with the #406 remedy appended", async () => {
    tamperCapabilityToken()

    await expect(saveComparison(INPUT, h.fetch)).rejects.toThrow(/missing or invalid x-rhizomorph-capability/)
    await expect(saveComparison(INPUT, h.fetch)).rejects.toThrow(/reload this page/i)
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    stripCapabilityToken()
    const transport = vi.fn(h.fetch)

    await expect(saveComparison(INPUT, transport)).rejects.toThrow(missingTokenMessage('save this comparison'))
    expect(transport).not.toHaveBeenCalled()
  })
})
