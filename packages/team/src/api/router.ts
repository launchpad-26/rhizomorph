/**
 * THE ROUTE TABLE, AS A PURE FUNCTION (prd-51 ruling 14).
 *
 * `./http.ts` used to decide its one route with a negated conditional —
 * `if (path !== INGEST_PATH) 404`. That shape has exactly one route in it, and
 * four separate pieces of wave-7/8 work each want to add to it. This module is
 * the replacement: a declared table, an exact match on `(method, path)`, and
 * two refusal bodies derived from the table rather than written beside it.
 *
 * **Adding a route is adding a row**, and a row is two literals plus the
 * sentence a 405 needs. No prefixes, no path parameters, no regex: a matcher
 * that can be surprising is a matcher whose 404 is a guess.
 *
 * **Why this is separate from the adapter.** Everything here is a value in and
 * a value out, so "break the table and watch a test go red" needs no socket —
 * which is the mutation the issue's Definition of done requires, run at the
 * layer where it is one line.
 */

export type HttpMethod = 'GET' | 'POST'

export interface RouteDeclaration {
  readonly method: HttpMethod
  readonly path: string
  /** Completes "<METHOD> is not allowed on <path>; …" in the 405. */
  readonly methodHint: string
}

export type RouteMatch<R extends RouteDeclaration> =
  | { readonly kind: 'matched'; readonly route: R }
  | { readonly kind: 'method-not-allowed'; readonly allow: readonly HttpMethod[]; readonly methodHint: string }
  | { readonly kind: 'not-found' }

/**
 * Exact `===` on both `method` and `path`.
 *
 * `method-not-allowed` only when **some** row's path matches and **no** row's
 * `(method, path)` does — so an unmatched path is a 404 and never a 405 that
 * implies a route exists. `allow` is every method declared for that path, in
 * table order; the hint is the first such row's.
 */
export function matchRoute<R extends RouteDeclaration>(
  table: readonly R[],
  method: string | undefined,
  path: string,
): RouteMatch<R> {
  for (const route of table) {
    if (route.path === path && route.method === method) return { kind: 'matched', route }
  }

  const sharePath = table.filter((route) => route.path === path)
  const first = sharePath[0]
  if (first === undefined) return { kind: 'not-found' }

  return {
    kind: 'method-not-allowed',
    allow: sharePath.map((route) => route.method),
    methodHint: first.methodHint,
  }
}

/**
 * The 404, enumerated from the table.
 *
 * The sentence this replaces ended *"this server serves /v1/rhizomorph/ingest
 * only"* — a claim this commit makes false by adding routes, which is exactly
 * what ruling 12 forbids shipping. The enumeration is derived from `table`, so
 * a row added and forgotten in the prose is not a thing that can happen.
 */
export function notFoundBody(path: string, table: readonly RouteDeclaration[]): { error: string } {
  const routes = table.map((route) => `${route.method} ${route.path}`).join(', ')
  return { error: `no route ${JSON.stringify(path)}; this server serves ${routes}` }
}

/** Today's 405 sentence, character for character — the ingest hint is `a batch is POSTed`. */
export function methodNotAllowedBody(
  method: string | undefined,
  path: string,
  hint: string,
): { error: string } {
  return { error: `${method ?? 'that method'} is not allowed on ${path}; ${hint}` }
}
