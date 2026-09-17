import { describe, expect, it } from 'vitest'
import { CALLBACK_PATH, INGEST_PATH, MINT_PATH, SIGNIN_START_PATH, TABLE, COST_PATH, STUCK_PATH, WHERE_PATH } from './http.js'
import { type RouteDeclaration, matchRoute, methodNotAllowedBody, notFoundBody } from './router.js'

/**
 * THE TABLE, WITHOUT A SOCKET.
 *
 * Everything here is a value in and a value out, which is what makes the
 * Definition of done's required mutation — *"break the route table so a known
 * path falls through, and show the test that should catch it going red"* — one
 * line rather than a server.
 */

describe('matchRoute', () => {
  it('A1 — POST on the ingest path matches the ingest row', () => {
    const match = matchRoute(TABLE, 'POST', INGEST_PATH)
    expect(match.kind).toBe('matched')
    expect(match.kind === 'matched' && match.route.path).toBe(INGEST_PATH)
    expect(match.kind === 'matched' && match.route.method).toBe('POST')
  })

  it('A2 — GET on each sign-in path matches its own row, not the other', () => {
    const callback = matchRoute(TABLE, 'GET', CALLBACK_PATH)
    expect(callback.kind === 'matched' && callback.route.path).toBe(CALLBACK_PATH)
    expect(callback.kind === 'matched' && callback.route.methodHint).toBe('GitHub returns a member here by GET')

    const start = matchRoute(TABLE, 'GET', SIGNIN_START_PATH)
    expect(start.kind === 'matched' && start.route.path).toBe(SIGNIN_START_PATH)
    expect(start.kind === 'matched' && start.route.methodHint).toBe('a member starts sign-in by GET')
  })

  it('A3 — GET on the ingest path is method-not-allowed, and the 405 sentence is TODAY’s, character for character', () => {
    const match = matchRoute(TABLE, 'GET', INGEST_PATH)
    expect(match.kind).toBe('method-not-allowed')
    expect(match.kind === 'method-not-allowed' && match.allow).toEqual(['POST'])
    expect(match.kind === 'method-not-allowed' && match.methodHint).toBe('a batch is POSTed')

    // The string the negated-conditional adapter shipped, reproduced exactly.
    expect(methodNotAllowedBody('GET', INGEST_PATH, 'a batch is POSTed').error).toBe(
      'GET is not allowed on /v1/rhizomorph/ingest; a batch is POSTed',
    )
    expect(methodNotAllowedBody(undefined, INGEST_PATH, 'a batch is POSTed').error).toBe(
      'that method is not allowed on /v1/rhizomorph/ingest; a batch is POSTed',
    )
  })

  it('A4 — POST on the callback is method-not-allowed, allowing GET', () => {
    const match = matchRoute(TABLE, 'POST', CALLBACK_PATH)
    expect(match.kind).toBe('method-not-allowed')
    expect(match.kind === 'method-not-allowed' && match.allow).toEqual(['GET'])
    expect(matchRoute(TABLE, 'POST', SIGNIN_START_PATH).kind).toBe('method-not-allowed')
  })

  it('A5 — an unmatched path is not-found on either method, never a 405 that implies a route', () => {
    expect(matchRoute(TABLE, 'GET', '/').kind).toBe('not-found')
    expect(matchRoute(TABLE, 'POST', '/v1/rhizomorph/nope').kind).toBe('not-found')
    expect(matchRoute(TABLE, 'GET', '/auth/github/callbackx').kind).toBe('not-found')
    expect(matchRoute(TABLE, 'GET', '').kind).toBe('not-found')
  })

  it('A6 — the 404 quotes the path, enumerates EVERY row, and no longer says "only" (ruling 12)', () => {
    const { error } = notFoundBody('/nope', TABLE)
    expect(error).toContain('"/nope"')
    // Against the exported constants, not against `TABLE`'s own rows: an
    // enumeration compared to the table it came from is true whatever the table
    // says, and would survive a row whose path had drifted.
    expect(error).toBe(
      `no route "/nope"; this server serves POST ${INGEST_PATH}, GET ${SIGNIN_START_PATH}, GET ${CALLBACK_PATH}, GET ${WHERE_PATH}, GET ${COST_PATH}, GET ${STUCK_PATH}, GET ${MINT_PATH}, POST ${MINT_PATH}`,
    )
    // Today's sentence ended "…serves /v1/rhizomorph/ingest only", which this
    // commit makes false by adding routes. Ruling 12 forbids shipping that.
    expect(error).not.toContain('only')
  })

  it('A7 — the 404 is DERIVED: a locally built three-row table names all three', () => {
    const local: readonly RouteDeclaration[] = [
      { method: 'GET', path: '/alpha', methodHint: 'alpha is GOT' },
      { method: 'POST', path: '/beta', methodHint: 'beta is POSTed' },
      { method: 'GET', path: '/gamma', methodHint: 'gamma is GOT' },
    ]
    const { error } = notFoundBody('/delta', local)
    expect(error).toBe('no route "/delta"; this server serves GET /alpha, POST /beta, GET /gamma')
    expect(error).not.toContain(INGEST_PATH)
  })

  it('A8 — repetition: three identical calls give three equal verdicts, and TABLE is unchanged', () => {
    const before = structuredClone(TABLE) as unknown
    const verdicts = [
      matchRoute(TABLE, 'GET', INGEST_PATH),
      matchRoute(TABLE, 'GET', INGEST_PATH),
      matchRoute(TABLE, 'GET', INGEST_PATH),
    ]
    expect(verdicts[0]).toEqual(verdicts[1])
    expect(verdicts[1]).toEqual(verdicts[2])
    expect(structuredClone(TABLE) as unknown).toEqual(before)
    // Against the declared order, not just against a snapshot: a matcher that
    // sorts or memoises the shared table is invisible to a snapshot taken after
    // an earlier test in this file already triggered it.
    expect(TABLE.map((route) => route.path)).toEqual([INGEST_PATH, SIGNIN_START_PATH, CALLBACK_PATH, WHERE_PATH, COST_PATH, STUCK_PATH, MINT_PATH, MINT_PATH])
  })

  /**
   * THE FIRST PATH WITH TWO ROWS (#560).
   *
   * The mint is a GET page and a POST that writes, on one address. `matchRoute` already had this
   * grammar — `allow` is every method declared for that path, in table order — so this case is
   * what proves the two rows were declared as two rows rather than as one that answers both.
   */
  it('A10 — the mint path matches GET and POST to DIFFERENT rows, and any other method is a 405 allowing both', () => {
    const get = matchRoute(TABLE, 'GET', MINT_PATH)
    expect(get.kind === 'matched' && get.route.method).toBe('GET')
    expect(get.kind === 'matched' && get.route.methodHint).toBe('a member opens the mint page by GET')

    const post = matchRoute(TABLE, 'POST', MINT_PATH)
    expect(post.kind === 'matched' && post.route.method).toBe('POST')
    expect(post.kind === 'matched' && post.route.methodHint).toBe('a key is minted by POST')

    // Two rows, not one that answers both: the hints differ, so a single row could not produce
    // both of the assertions above.
    expect(get.kind === 'matched' && post.kind === 'matched' && get.route.methodHint).not.toBe(
      post.kind === 'matched' ? post.route.methodHint : '',
    )

    const put = matchRoute(TABLE, 'PUT', MINT_PATH)
    expect(put.kind).toBe('method-not-allowed')
    expect(put.kind === 'method-not-allowed' && put.allow).toEqual(['GET', 'POST'])
  })

  it('A9 — no duplicate (method, path) pair, and no empty path', () => {
    const pairs = TABLE.map((route) => `${route.method} ${route.path}`)
    expect(new Set(pairs).size).toBe(pairs.length)
    for (const route of TABLE) {
      expect(route.path).not.toBe('')
      expect(route.path.startsWith('/')).toBe(true)
      expect(route.methodHint).not.toBe('')
    }
  })
})
