import { fetchSessionPreview } from '@rhizomorph/web/connect/meta'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContractHarness,
  type ContractHarness,
  routeGlobalFetchThroughHarness,
  stripCapabilityToken,
  tamperCapabilityToken,
} from './harness.js'

const SESSION_ID = 'otel-preview-session'

/**
 * `/api/session-preview/:sessionId`'s contract test (prd-29 w3, #61). The
 * `swallows` shape: `fetchSessionPreview` never throws — its `readJson`
 * helper collapses every failure (no fetch, a rejected request, a non-2xx, an
 * unparsable body) onto the same `null`, so a 401 and a real "nothing to
 * preview" answer are otherwise indistinguishable from the return value
 * alone. Coverage needs a real 200 (so `readJson` actually parses a body) to
 * tell them apart, plus a DIRECT `h.app.inject` 401 check on the refusal path.
 *
 * Getting a real 200 for an UNKNOWN session id is itself a 404 here
 * (`unknownSessionId`), which `readJson` also folds to `null` — so the happy
 * path first attributes this session id for real, the same way the real
 * `sessionlog`/`otel` collectors do: one `llm.usage` OTLP metric, posted to
 * the real, ungated `POST /v1/metrics` (prd-23 ruling 6), naming
 * `session.id` in its datapoint attributes. That is exactly what
 * `transcript-attribution.ts`'s `findSessionAttribution` reads, so this
 * session id is then genuinely KNOWN — its transcript is simply not on disk
 * anywhere this harness's fixture repo would have one (no `worktreePath`
 * ever attributed to it), which is the real, honest `available: false`
 * "vanished" case, not the "unknown identifier" 404.
 */
function otlpUsageMetric(sessionId: string, instance: string): Record<string, unknown> {
  return {
    resourceMetrics: [
      {
        // `api/otel.ts`'s `INSTANCE_ATTRIBUTE`: an export declaring no
        // instance — or a foreign one — is refused 403 ("one repo, one
        // Rhizomorph") before it is ever parsed into events. This addresses
        // THIS harness's own instrument, exactly as a real exporter's
        // `rhizomorph env` or `rhizomorph enlist` stamping would.
        //
        // The INSTALLATION id since prd-57 ruling 7, taken off the harness
        // rather than named here: the harness reads it from the same file the
        // booted server reads, so this is the server's own answer and not this
        // test's guess at it. It was `HARNESS_LIVE_SESSION_ID`, and that value
        // is now exactly what the inbox refuses.
        resource: { attributes: [{ key: 'instance', value: { stringValue: instance } }] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  dataPoints: [
                    {
                      attributes: [
                        { key: 'session.id', value: { stringValue: sessionId } },
                        { key: 'model', value: { stringValue: 'claude-opus-5' } },
                        { key: 'type', value: { stringValue: 'input' } },
                      ],
                      asInt: '4',
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  }
}

describe('contract: a session preview is gated (prd-29 ruling 1)', () => {
  let h: ContractHarness
  let restoreFetch: () => void

  beforeEach(async () => {
    h = await buildContractHarness()
    restoreFetch = routeGlobalFetchThroughHarness(h.fetch)

    // Attribute SESSION_ID for real, via the real OTLP receiver — see the
    // file doc for why this is what makes the happy path a genuine 200.
    const attributed = await h.app.inject({
      method: 'POST',
      url: '/v1/metrics',
      payload: otlpUsageMetric(SESSION_ID, h.installationId),
    })
    expect(attributed.statusCode).toBe(200)
  })

  afterEach(async () => {
    restoreFetch()
    await h.close()
  })

  it('succeeds end to end: the token the server stamped is the token the client sends and the gate accepts', async () => {
    const preview = await fetchSessionPreview(SESSION_ID)

    // A real, non-null answer — the session IS known, it simply has no
    // transcript on disk anywhere this harness ever attributed a worktree
    // for, which is a real fact the route computed, not a refusal.
    expect(preview).not.toBeNull()
    expect(preview?.sessionId).toBe(SESSION_ID)
    expect(preview?.text).toBeNull()
    expect(preview?.reason).toMatch(/NO TRANSCRIPT for session/)
  })

  it('a tampered token is refused by the real gate — the client swallows it to null, and the server itself answers 401', async () => {
    tamperCapabilityToken()

    await expect(fetchSessionPreview(SESSION_ID)).resolves.toBeNull()

    const direct = await h.app.inject({
      method: 'GET',
      url: `/api/session-preview/${SESSION_ID}`,
      headers: { 'x-rhizomorph-capability': '0'.repeat(64) },
    })
    expect(direct.statusCode).toBe(401)
  })

  it('a page served without the token still reaches the wire bare — the client swallows it to null, and the server itself answers 401', async () => {
    stripCapabilityToken()

    await expect(fetchSessionPreview(SESSION_ID)).resolves.toBeNull()

    const direct = await h.app.inject({ method: 'GET', url: `/api/session-preview/${SESSION_ID}` })
    expect(direct.statusCode).toBe(401)
  })
})
