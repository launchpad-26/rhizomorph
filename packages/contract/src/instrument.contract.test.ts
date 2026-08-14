import { missingTokenMessage } from '@rhizomorph/web/recordings/capability-guidance'
import { requestInstrument } from '@rhizomorph/web/concierge/instrument'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContractHarness, type ContractHarness, stripCapabilityToken, tamperCapabilityToken } from './harness.js'

/**
 * `/api/concierge/launch`'s contract test (prd-24 ruling 1/2) — the fourth
 * mutating route, and the file `contract-coverage-law.test.ts` names for it.
 * The harness's own docblock predicted this shape: "a fourth mutating route is
 * a new test file with no new scaffolding", and that is exactly what this is.
 *
 * **What it deliberately does NOT do is complete the act.** A completed
 * request here would SPAWN A REAL CONDUCTOR PROCESS on whoever's machine is
 * running the suite and copy a transcript into their own `~/.claude` — the
 * `launch.contract.test.ts` restraint ("that forks a real worktree and
 * dispatches a real agent"), with a sharper edge: the write lands in the
 * operator's home directory, not a temp dir. So every case below stops before
 * the handler can reach `runLaunch`.
 *
 * **What makes that stopping point trustworthy rather than convenient.** The
 * route's first three gates run in a fixed order, all of them strictly BEFORE
 * the body is parsed (`server/src/api/concierge.ts`): the capability
 * `preHandler`, the replay refusal, and the "this server has no known
 * listening port" refusal. The contract harness builds its app without a
 * `port` — it injects rather than listens — so a request that clears the token
 * gate lands on that third refusal, every time, and can no more spawn a
 * process than a 401 can. A 500 naming the port therefore proves precisely
 * what a 400 proves for the laboratory launch: **the token was accepted and
 * the request reached the handler.** The two answers cannot be confused,
 * because the gate is a `preHandler` and runs first.
 *
 * **The `mode: 'resume'` half of the route is a sibling lane's work (#518's
 * server counterpart), and nothing here pins it.** Every assertion below is
 * decided before `parseConciergeLaunchRequestBody` ever sees the body, so this
 * file stays true both today, while the route still refuses `'resume'` as an
 * unknown mode, and after that lane lands. That is deliberate: a contract test
 * that encoded today's 400 would be a landmine timed to the next merge.
 */
describe('contract: the concierge instrument button (#518)', () => {
  /** A session the harness's own event log recorded — the client sends the id, never a path. */
  const SESSION = { sessionId: '1000' }

  let h: ContractHarness

  beforeEach(async () => {
    h = await buildContractHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  it('the token the server stamped is the token the client sends and the gate accepts — the request reaches the handler', async () => {
    const failure = await requestInstrument(SESSION, h.fetch).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    // Not the gate's refusal: nothing here is about the header, which is the
    // whole claim of this test. Asserted as an absence as well as a presence,
    // so a future refusal that happened to mention a port could not stand in
    // for a 401 quietly.
    expect(message).not.toMatch(/x-rhizomorph-capability|capability token/)
    // …and it IS the handler's own pre-body refusal, in the client's grammar.
    expect(message).toMatch(/^could not instrument this session — .*listening port/)
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back, with the #406 remedy appended", async () => {
    tamperCapabilityToken()

    await expect(requestInstrument(SESSION, h.fetch)).rejects.toThrow(/missing or invalid x-rhizomorph-capability/)
    await expect(requestInstrument(SESSION, h.fetch)).rejects.toThrow(/reload this page/i)
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    stripCapabilityToken()
    const transport = vi.fn(h.fetch)

    await expect(requestInstrument(SESSION, transport)).rejects.toThrow(
      missingTokenMessage('instrument this session'),
    )
    // Nothing was sent, so nothing was spawned and nothing was copied into
    // anyone's `~/.claude` on the strength of a header the page never had.
    expect(transport).not.toHaveBeenCalled()
  })
})
