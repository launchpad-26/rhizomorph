import { CAPABILITY_TOKEN_HEADER, readCapabilityToken } from './capability.js'

/**
 * THE READ HEADER, sent once, here (prd-29 ruling 1 / ADR-0024). Every SPA
 * read of a `gated-read` route now answers only the capability token's
 * holder, so every read seam sends the token — and does it through this one
 * module rather than each re-deriving the header. It is the read-side
 * counterpart to the five mutating modules' inline header, and
 * `replay/mutating-calls-law.test.ts`'s `READ_MODULES` enumerates exactly
 * this one file as the only read allowed to carry it.
 *
 * Typed as `typeof fetch` so it drops straight into every read seam's
 * `FetchLike` default, of either shape (the `typeof fetch` seams take it as
 * their default parameter; the narrower `(input) => Promise<{ok; json}>`
 * seams hand it back from `defaultFetch()`).
 *
 * When the page carries no token — `vite dev` serves `index.html` with no
 * capability meta tag (ADR-0012's recorded dev-mode gap) — the request goes
 * out bare and the server answers its own honest 401, rather than this
 * inventing one.
 *
 * **THE HEADERS ARE THIS MODULE'S, NOT THE CALLER'S.** Every other `init`
 * field a caller passes survives (`...init`), but the `headers` property is
 * *replaced*, so a caller-supplied header is dropped rather than merged. That
 * is deliberate, and it is forced by the law above: `assertHeaderBlocksExact`
 * refuses a spread inside a header block outright — "a spread inside a headers
 * block can carry a header no regex sees" — so merging the caller's headers in
 * here is exactly the shape the law exists to forbid. A single spread-free
 * literal naming one computed key is what makes the block statically
 * checkable.
 *
 * The consequence is a real constraint on callers, pinned by this module's own
 * test: a read seam that needs its own header cannot get one through here. No
 * seam needs one today — all eight call their `fetchImpl` with a URL and
 * nothing else. The seam that first does needs the law widened alongside it,
 * as a reviewed change, which is the whole point of refusing it silently now.
 */
export const capabilityRead: typeof fetch = (input, init) => {
  const token = readCapabilityToken()
  if (token === null) return globalThis.fetch(input, init)
  return globalThis.fetch(input, { ...init, headers: { [CAPABILITY_TOKEN_HEADER]: token } })
}
