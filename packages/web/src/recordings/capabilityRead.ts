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
 * inventing one. The header rides on `init` only when the token is present,
 * and never overwrites a caller's other init fields.
 */
export const capabilityRead: typeof fetch = (input, init) => {
  const token = readCapabilityToken()
  if (token === null) return globalThis.fetch(input, init)
  return globalThis.fetch(input, { ...init, headers: { [CAPABILITY_TOKEN_HEADER]: token } })
}
