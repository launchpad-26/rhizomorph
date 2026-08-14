import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requestClone, type CloneFetchLike } from '@rhizomorph/web/concierge/clone'
import { missingTokenMessage } from '@rhizomorph/web/recordings/capability-guidance'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildContractHarness, type ContractHarness, stripCapabilityToken, tamperCapabilityToken } from './harness.js'

/**
 * `/api/concierge/clone`'s contract test (prd-24 rulings 1 and 2) — the fifth
 * mutating route, and the file `contract-coverage-law.test.ts` names for it.
 *
 * **What it deliberately does NOT do is complete the act.** A completed request
 * here would run a real `git clone` on whoever's machine is running the suite,
 * over the network, into their own home directory — the sharpest edge in the
 * family: `launch.contract.test.ts` declines to fork a worktree,
 * `instrument.contract.test.ts` declines to spawn a conductor, and this one
 * declines to download a repository. So every case below stops before the
 * handler can reach `runClone`.
 *
 * **What makes that stopping point trustworthy rather than convenient.** The
 * route's gates run in a fixed order (`server/src/api/concierge.ts`), all of
 * them strictly before a byte of `git` output can exist: the capability
 * `preHandler`, the replay refusal, then `parseCloneRequestBody`, then
 * `planClone`. The token gate is a `preHandler` and therefore runs FIRST, so a
 * 400 naming the URL grammar proves precisely what the sibling's 500 naming the
 * port proves: **the token was accepted and the request reached the handler.**
 * The two answers cannot be confused. And a malformed URL is refused by
 * `assertValidCloneUrl` before `planClone` derives a destination, so nothing is
 * created and nothing is fetched — this test touches the network exactly as
 * much as a 401 does, which is not at all.
 *
 * **The transport adapts `h.fetch` rather than replacing it.** The shared
 * harness's `InjectedFetch` answers `{ok, status, json}`, which is every
 * mutating client's shape but this one's: the clone's success body is
 * newline-delimited JSON, so its client also needs a `text()`. The wrapper
 * below adds exactly that, over the same `app.inject` call — method, URL,
 * headers and body still come from the web module and never from this test,
 * which is the harness's whole load-bearing property.
 */
describe('contract: the concierge clone (#266)', () => {
  let h: ContractHarness

  /**
   * Refused by the URL grammar, before a destination is derived or `git` is
   * reached for — and refused by the SCHEME clause specifically, which is why
   * it carries no whitespace and no leading `-`: those trip earlier clauses,
   * and a test that meant to prove "the request reached the handler" would then
   * be proving it through whichever refusal happened to fire first.
   */
  const MALFORMED = { url: 'not-a-repository-url' }

  /**
   * `h.fetch` with the one member the NDJSON body needs. Nothing about the
   * request is composed here — `init` is forwarded verbatim, exactly as the
   * harness forwards it.
   */
  function transport(): CloneFetchLike {
    return async (url, init) => {
      const response = await h.fetch(url, init)
      return {
        ...response,
        // Never reached by the cases below (all of them refuse before a body
        // is streamed); present because the client's type requires it, and
        // honest about what it would return if it ever were.
        text: async () => JSON.stringify(await response.json()),
      }
    }
  }

  beforeEach(async () => {
    h = await buildContractHarness()
  })

  afterEach(async () => {
    await h.close()
  })

  it('the token the server stamped is the token the client sends and the gate accepts — the request reaches the handler', async () => {
    const failure = await requestClone(MALFORMED, transport()).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    // Not the gate's refusal: nothing here is about the header, which is the
    // whole claim of this test. Asserted as an absence as well as a presence,
    // so a future refusal that happened to mention a URL could not stand in
    // for a 401 quietly.
    expect(message).not.toMatch(/x-rhizomorph-capability|capability token/)
    // …and it IS the handler's own body refusal, in the client's grammar.
    expect(message).toMatch(/^could not clone that repository — .*scp-like/)
  })

  it("a tampered token is refused by the real gate, and the server's own sentence crosses back, with the #406 remedy appended", async () => {
    tamperCapabilityToken()

    await expect(requestClone(MALFORMED, transport())).rejects.toThrow(/missing or invalid x-rhizomorph-capability/)
    await expect(requestClone(MALFORMED, transport())).rejects.toThrow(/reload this page/i)
  })

  it('a page served without the token never reaches the wire — the client refuses first, in its own words', async () => {
    stripCapabilityToken()
    const sent = vi.fn(transport())

    await expect(requestClone(MALFORMED, sent)).rejects.toThrow(missingTokenMessage('clone a repository'))
    // Nothing was sent, so nothing was cloned onto anyone's disk on the
    // strength of a header the page never had.
    expect(sent).not.toHaveBeenCalled()
  })

  /**
   * The refusal that is this route's own, and the reason it is worth a contract
   * case rather than a unit test: a URL carrying a credential is refused by the
   * REAL `assertValidCloneUrl`, on the real app, because `url` becomes a literal
   * `git` argv element and would be readable from `/proc/<pid>/cmdline` by every
   * other process on the machine for the clone's whole duration — the exact
   * adversary the capability token exists to defend against, reached around it.
   */
  it('a URL with a credential in it is refused by the real route, not merely by a client-side rule', async () => {
    const failure = await requestClone(
      { url: 'https://ghp_notarealtoken@github.com/owner/repo.git' },
      transport(),
    ).catch((err: unknown) => err)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/must not embed a credential/)
  })
})

const HERE = path.dirname(fileURLToPath(import.meta.url))
// packages/contract/src -> repo root
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const SERVER_ROUTES = path.join(REPO_ROOT, 'packages', 'server', 'src', 'api', 'concierge.ts')
const SERVER_CLONE_MODULE = path.join(REPO_ROOT, 'packages', 'server', 'src', 'concierge', 'clone.ts')
const CLONE_MODULE = path.join(REPO_ROOT, 'packages', 'web', 'src', 'concierge', 'clone.ts')

/** Every `type: '…'` in the server's `CloneEvent` union declaration — the events the stream can carry. */
function serverEventTypes(source: string): string[] {
  const declaration = /export type CloneEvent =([\s\S]*?)\n\n/.exec(source)?.[1] ?? ''
  return [...new Set([...declaration.matchAll(/type: '([a-z-]+)'/g)].map((match) => match[1] as string))].sort()
}

/** Every `event.type === '…'` the client's stream reader compares against. */
function clientRecognisedTypes(source: string): string[] {
  return [...new Set([...source.matchAll(/event\.type === '([a-z-]+)'/g)].map((match) => match[1] as string))].sort()
}

/**
 * THE SHAPE THE REQUEST CASES ABOVE CANNOT REACH.
 *
 * Every case above stops before the stream opens, deliberately and permanently:
 * completing this act downloads a repository. So the one thing no runtime
 * contract test here can check is the thing #532 proved is worth checking on
 * the sibling route — **whether the two sides agree on the vocabulary of the
 * answer.** A client that had never heard of a `progress` event would silently
 * drop `git`'s entire account of a failure; one that had never heard of `done`
 * would tell an operator a finished clone had ended without saying whether the
 * repository arrived.
 *
 * So this reads both modules' source text, the way
 * `instrument.contract.test.ts` reads `launch.ts`'s rather than restating it,
 * and asserts the two enumerations are the same set. It creates no import edge
 * into the concierge (a `readFileSync` is not a reach into the hand, and the
 * server package exports no path to it) and it starts no process.
 */
describe('contract: the clone’s two sides answer in one vocabulary', () => {
  it('every event type the route can stream is one the client can read, and vice versa', () => {
    const declared = serverEventTypes(readFileSync(SERVER_CLONE_MODULE, 'utf8'))
    const recognised = clientRecognisedTypes(readFileSync(CLONE_MODULE, 'utf8'))

    // The floor is derived from the parse, never hardcoded: an empty read
    // would otherwise satisfy an equality of two empty sets.
    expect(declared.length).toBeGreaterThan(2)
    expect(declared).toContain('done')
    expect(recognised).toEqual(declared)
  })

  it('both parsers actually parse — pinned against the shapes they run on', () => {
    expect(
      serverEventTypes(
        "export type CloneEvent =\n  | { type: 'progress'; line: string }\n  | { type: 'done'; path: string }\n\nexport function next() {}",
      ),
    ).toEqual(['done', 'progress'])
    expect(
      clientRecognisedTypes("if (event.type === 'progress') {}\n  if (event.type === 'done') {} else if (event.type === 'error') {}"),
    ).toEqual(['done', 'error', 'progress'])
  })

  it('the client asks the route the server actually registers', () => {
    const routes = readFileSync(SERVER_ROUTES, 'utf8')
    const clientUrl = /export const CLONE_URL = '([^']+)'/.exec(readFileSync(CLONE_MODULE, 'utf8'))?.[1]

    expect(clientUrl).toBe('/api/concierge/clone')
    expect(routes).toContain(`app.post(\n    '${clientUrl as string}'`)
  })
})
