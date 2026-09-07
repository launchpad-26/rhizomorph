import { requestMeasure } from '@rhizomorph/web/lab/measure'
import { missingTokenMessage } from '@rhizomorph/web/recordings/capability-guidance'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContractHarness, type ContractHarness, stripCapabilityToken, tamperCapabilityToken } from './harness.js'

/**
 * The measure route's contract (prd53 ruling 3): the same three proofs the
 * launch contract gives, because it is the same kind of door — a gated
 * mutation the console reaches through exactly one module. A MALFORMED body
 * is deliberate: the server's validation refuses it, so a **400 proves the
 * token was accepted** — the gate runs as a `preHandler`, strictly before the
 * handler that answers 400 can.
 */
describe('contract: laboratory measure (prd53 ruling 3)', () => {
  const MALFORMED = { forkId: '' }

  let h: ContractHarness

  beforeEach(async () => {
    h = await buildContractHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  it('the token the server stamped is the token the client sends and the gate accepts — the request reaches the handler', async () => {
    await expect(requestMeasure(MALFORMED, h.fetch)).rejects.toThrow(/could not measure — .*forkId/)
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back, with the #406 remedy appended", async () => {
    tamperCapabilityToken()

    await expect(requestMeasure(MALFORMED, h.fetch)).rejects.toThrow(/missing or invalid x-rhizomorph-capability/)
    await expect(requestMeasure(MALFORMED, h.fetch)).rejects.toThrow(/reload this page/i)
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    stripCapabilityToken()
    const transport = vi.fn(h.fetch)

    await expect(requestMeasure(MALFORMED, transport)).rejects.toThrow(missingTokenMessage('measure'))
    expect(transport).not.toHaveBeenCalled()
  })
})
