/**
 * THE WIRE — prd-51 ruling 3 and ADR-0033, as code a stranger can import.
 *
 * Three pieces, and each one exists because a spike got it wrong first:
 *
 * - `protocol.ts` — the v1 request and response envelopes, and the
 *   `(project, actorInstance, n)` key. `n` is a **ledger position**; keying on
 *   the event id discarded 74.5 % of a real ledger, because event ids restart
 *   on session resume.
 * - `reserialize.ts` — one ledger line → the line `buildRecord` would
 *   serialize. Shipping the ledger's raw bytes instead put a field the schema
 *   no longer declares on 30,627 wire events.
 * - `split.ts` — the byte scan that produces `n` and the cursor. Decoding
 *   first and indexing the string shipped 25,005 rows for a 25,000-line file.
 *
 * **Not re-exported from `../index.ts`.** Import by path —
 * `@rhizomorph/core/src/wire/index.js` — the way `record/` is imported. The
 * package barrel is a shared surface and this module has no business widening
 * it before a consumer exists.
 */

export * from './protocol.js'
export * from './reserialize.js'
export * from './split.js'
