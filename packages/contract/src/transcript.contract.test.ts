import { useTranscript } from '@rhizomorph/web/drawer/useTranscript'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

const LANE = 'no-such-lane-xyz'

/**
 * `/api/transcript/:lane`'s contract test (prd-29 w3, #61) — `useTranscript`
 * is a React hook, so this drives it through `@testing-library/react`'s
 * `renderHook` rather than calling it directly. The REAL served page, the
 * REAL `capabilityRead`, the REAL `useTranscript`, the REAL gate — `h.fetch`
 * routed in as `globalThis.fetch`.
 *
 * The `swallows` shape, with a wrinkle worth naming rather than guessing at:
 * `useTranscript`'s own `fetchJson` never checks `response.ok` at all — it
 * calls `.json()` unconditionally (`drawer/useTranscript.ts`) — so even a 401
 * folds through `foldChunk` into `status: 'absent'`, exactly like a genuine
 * "no such lane" answer does. What DOES distinguish them, observed by running
 * this file in isolation before writing the assertions below: the REASON
 * text. A real 404 for an unknown lane carries the server's own `reason`
 * field verbatim (`"NO SUCH LANE ... run: \`rhizomorph doctor\`"`,
 * `api/transcript.ts`'s `missingLaneGap`). A 401 body carries `{ error: ... }`
 * instead — no `reason` key at all — so `foldChunk` falls back to its own
 * generic default ("NO TRANSCRIPT — the server gave no reason, which is
 * itself the bug"). That fallback text is therefore the tell that the gate
 * refused the request before it ever reached `readTranscript`, and the direct
 * `h.app.inject` 401 check below is what actually proves it, since the
 * client's own return value alone cannot.
 */
describe('contract: the transcript tail is gated (prd-29 ruling 1)', () => {
  let h: ContractHarness
  let restoreFetch: () => void

  beforeEach(async () => {
    h = await buildContractHarness()
    restoreFetch = routeGlobalFetchThroughHarness(h.fetch)
  })

  afterEach(async () => {
    cleanup()
    restoreFetch()
    await h.close()
  })

  it('succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    const { result } = renderHook(() => useTranscript(LANE, { pollMs: 0 }))

    await waitFor(() => expect(result.current.status).toBe('absent'))
    // The server's own, real answer for an unknown lane — reached because
    // the gate accepted the request, not the gate's own generic fallback.
    expect(result.current.reason).toBe(
      `NO SUCH LANE "${LANE}" — nothing in this session's event log names it, so there is no ` +
        'transcript to tail — run: `rhizomorph doctor`',
    )
  })

  it('a tampered token is refused by the real gate — the hook folds it to the gate\'s own generic fallback, and the server itself answers 401', async () => {
    tamperCapabilityToken()

    const { result } = renderHook(() => useTranscript(LANE, { pollMs: 0 }))
    await waitFor(() => expect(result.current.status).toBe('absent'))
    expect(result.current.reason).toBe(
      'NO TRANSCRIPT — the server gave no reason, which is itself the bug — run: `rhizomorph doctor`',
    )

    const direct = await h.app.inject({
      method: 'GET',
      url: `/api/transcript/${LANE}?tail=1`,
      headers: { 'x-rhizomorph-capability': '0'.repeat(64) },
    })
    expect(direct.statusCode).toBe(401)
  })

  it('a page served without the token still reaches the wire bare — the hook folds it to the gate\'s own generic fallback, and the server itself answers 401', async () => {
    stripCapabilityToken()

    const { result } = renderHook(() => useTranscript(LANE, { pollMs: 0 }))
    await waitFor(() => expect(result.current.status).toBe('absent'))
    expect(result.current.reason).toBe(
      'NO TRANSCRIPT — the server gave no reason, which is itself the bug — run: `rhizomorph doctor`',
    )

    const direct = await h.app.inject({ method: 'GET', url: `/api/transcript/${LANE}?tail=1` })
    expect(direct.statusCode).toBe(401)
  })
})
