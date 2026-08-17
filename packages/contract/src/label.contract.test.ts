import { readSessionLabel } from '@rhizomorph/server/log/label'
import { CAPABILITY_TOKEN_HEADER } from '@rhizomorph/web/recordings/capability'
import { missingTokenMessage } from '@rhizomorph/web/recordings/capability-guidance'
import { requestLabel } from '@rhizomorph/web/recordings/label'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContractHarness, type ContractHarness, stripCapabilityToken, tamperCapabilityToken } from './harness.js'

/**
 * `/api/label`'s contract test (prd-24 ruling 1) — the rename seam, moved here
 * from `web/src/recordings/label-seam.test.ts` verbatim in its claims: the
 * REAL served page, the REAL `readCapabilityToken`, the REAL `requestLabel`,
 * the REAL gate. The transport decides nothing.
 */
describe('contract: rename-in-place (#249, #310)', () => {
  let h: ContractHarness

  beforeEach(async () => {
    h = await buildContractHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  it('succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    const outcome = await requestLabel('1000', 'the morning run', h.fetch)

    expect(outcome).toEqual({ sessionId: '1000', label: 'the morning run' })
    // The rename really landed server-side: sidecar written, listing updated.
    expect(await readSessionLabel(h.sessionDir, '1000')).toBe('the morning run')
    // `/api/sessions` is a gated-read since prd-29 wave 1 (#442) — this
    // server-side verification of the effect carries the same token the served
    // page stamped, exactly as the client's own read seam does.
    const listing = (
      await h.app.inject({
        method: 'GET',
        url: '/api/sessions',
        headers: { [CAPABILITY_TOKEN_HEADER]: h.app.capabilityToken },
      })
    ).json() as {
      sessions: Array<Record<string, unknown>>
    }
    expect(listing.sessions[0]).toMatchObject({ id: '1000', label: 'the morning run' })
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back, with the #406 remedy appended", async () => {
    tamperCapabilityToken()

    // The server's phrase, not the client's — and since #406 the client wraps
    // it with the reload guidance rather than replacing it.
    await expect(requestLabel('1000', 'renamed', h.fetch)).rejects.toThrow(
      /missing or invalid x-rhizomorph-capability/,
    )
    await expect(requestLabel('1000', 'renamed', h.fetch)).rejects.toThrow(/reload this page/i)
    expect(await readSessionLabel(h.sessionDir, '1000')).toBeNull()
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    stripCapabilityToken()
    const transport = vi.fn(h.fetch)

    await expect(requestLabel('1000', 'renamed', transport)).rejects.toThrow(
      missingTokenMessage('save the label'),
    )
    expect(transport).not.toHaveBeenCalled()
  })
})
