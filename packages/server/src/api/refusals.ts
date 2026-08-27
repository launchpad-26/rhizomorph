/**
 * The neutral home for the retarget/rotate refusal vocabulary (#91, prd-42
 * ruling 5's "no second refusal vocabulary").
 *
 * `api/retarget.ts` and `api/rotate.ts` both answer 409 with
 * `code: 'retarget-in-flight'` when the recorder is found already mid-boundary
 * (#49, #14) — one refusal, reachable from two routes. `retarget-law.test.ts`'s
 * "exactly one file imports it directly, and it is the route registrar" clause
 * forbids any production file but `api/index.ts` from importing
 * `api/retarget.ts`, and its static check does not distinguish `import type`
 * from a value import — so the shared value cannot live in the route itself.
 * This module imports neither route, so it does not engage that clause, and
 * both routes may import it freely.
 *
 * (Kept clear of naming either route's boundary-entry function by name in
 * prose: `recorder/namespace-law.test.ts`'s reachability check greps raw
 * source text, comments included, for those identifiers — a module outside
 * `recorder/` that merely *mentions* one in a doc comment reads as a new
 * caller. This module calls neither; it only names the refusal code both
 * routes already answer with.)
 */
/**
 * Which check refused. One code per distinguishable operator situation —
 * three of them are `validateRetargetTarget`'s own reasons, passed through by
 * `api/retarget.ts` unchanged so the route never re-words a refusal the
 * module below it owns.
 */
export type RetargetRefusalCode =
  | 'not-found'
  | 'not-a-repo'
  | 'writer-alive'
  | 'already-watching'
  | 'retarget-in-flight'

/** The one code both routes answer with when a boundary is already held. */
export const RETARGET_IN_FLIGHT_CODE: RetargetRefusalCode = 'retarget-in-flight'
