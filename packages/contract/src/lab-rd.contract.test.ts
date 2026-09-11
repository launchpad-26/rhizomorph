import { type RdRunRequest, requestRd } from '@rhizomorph/web/lab/rd'
import { missingTokenMessage } from '@rhizomorph/web/recordings/capability-guidance'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContractHarness, type ContractHarness, stripCapabilityToken, tamperCapabilityToken } from './harness.js'

/**
 * `/api/lab/rd`'s contract test (prd-55 ruling 1) — moved here from #412 per
 * this wave's fence, through the web client this wave writes (`lab/rd/rd.ts`,
 * exported as `./lab/rd`).
 *
 * Like its siblings (`launch.contract.test.ts`, `lab-measure.contract.test.ts`)
 * this test never spends real money on a real model call — that is not a
 * thing a test suite may do. What it DOES exercise for real, end to end,
 * through the real running server (`buildContractHarness`'s real `buildApp`,
 * never a stub):
 *
 * - **the gate**: a malformed body proves the token was accepted — a 400 the
 *   route's own validation gives, strictly AFTER the `preHandler` gate runs,
 *   so the two answers can never be confused;
 * - **the schema refusal**: a blank `"model"` is the request-body validation
 *   `parseRdRequestBody` (`packages/server/src/api/lab.ts`) itself refuses,
 *   in ruling 1's own words — "a call that spends real money does not choose
 *   its own model";
 * - **the run, and the no-CLI sentence, together and for real**: a
 *   well-formed body naming a deliberately-absent `agentCommand` reaches the
 *   real engine (`server/src/lab/rd.ts`'s `runRdHand`, invoked in-process via
 *   `runCli` — `runLabCliOnce`'s own doc), which really spawns
 *   `<agentCommand> --version`, gets a real ENOENT (no machine has a binary
 *   by this name, by construction — nothing here depends on what this box
 *   actually has on PATH, only on what it does not), and answers 200 with
 *   `available: false` and `RD_NO_CLI_SENTENCE`, verbatim. Cheap and
 *   side-effect free: ruling 1's own doc says the PATH answer comes before
 *   the corpus is even read.
 *
 * **Not covered here, named rather than silently absent: the override
 * record.** `packages/server/src/lab/rd.ts`'s `recordRdOverride` has no HTTP
 * caller anywhere in this tree — `grep -rn recordRdOverride packages/server/src`
 * finds only its own declaration — so there is no route this test, or the web
 * client, could reach to record one. `RdTab` (`packages/web/src/lab/rd/
 * RdTab.tsx`) detects an operator changing the checkpoint pick and SHOWS the
 * override sentence, but cannot record `rd.override` durably. This wave's
 * report carries the gap as a widening: wiring a route is
 * `packages/server/src/api/lab.ts`, out of this fence.
 */
describe('contract: laboratory R&D (prd-55 ruling 1, moved from #412)', () => {
  const MALFORMED: RdRunRequest = { lane: '', model: 'sonnet', corpus: 'local' }
  const NO_MODEL: RdRunRequest = { lane: 'feature', model: '', corpus: 'local' }

  let h: ContractHarness

  beforeEach(async () => {
    h = await buildContractHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  it('the token the server stamped is the token the client sends and the gate accepts — the request reaches the handler', async () => {
    // Not a 401: the gate passed, and what came back is the handler's own
    // complaint about the lane. That is the whole claim of this test.
    await expect(requestRd(MALFORMED, h.fetch)).rejects.toThrow(/could not read and propose — .*lane/)
  })

  it('the schema refusal: a blank model is the handler answering, in ruling 1\'s own words', async () => {
    await expect(requestRd(NO_MODEL, h.fetch)).rejects.toThrow(/does not choose its own model/)
  })

  it('the run, for real: a deliberately-absent agentCommand reaches the real engine and answers the no-CLI sentence, verbatim', async () => {
    const run = await requestRd(
      { lane: 'feature', model: 'sonnet', corpus: 'local', agentCommand: 'rhizomorph-w6-413-no-such-binary' },
      h.fetch,
    )
    expect(run.available).toBe(false)
    expect(run.reason).toBe("no claude on this machine's PATH — the R&D hand is your CLI, installed by you")
    expect(run.patterns).toEqual([])
    expect(run.proposals).toEqual([])
    expect(run.provenance).toBeNull()
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back, with the #406 remedy appended", async () => {
    tamperCapabilityToken()

    await expect(requestRd(MALFORMED, h.fetch)).rejects.toThrow(/missing or invalid x-rhizomorph-capability/)
    await expect(requestRd(MALFORMED, h.fetch)).rejects.toThrow(/reload this page/i)
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    stripCapabilityToken()
    const transport = vi.fn(h.fetch)

    await expect(requestRd(MALFORMED, transport)).rejects.toThrow(missingTokenMessage('read and propose'))
    expect(transport).not.toHaveBeenCalled()
  })
})
