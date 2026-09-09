/**
 * THE FIFTH HAND (ADR-0034) — the shipper, off by default, outbound only.
 *
 * A barrel over the six modules beside it and nothing more. It is imported
 * from exactly one file in this codebase, `cli/connect-team.ts`, which is the
 * single entry in `hand-law.test.ts`'s `DECLARED_IMPORTERS` (prd-51 ruling
 * 14). A second importer is not a widening of this barrel — it is a widening
 * of ADR-0034's clause-3 seam, which is the one thing the law exists to keep
 * narrow, so `doctor` reaches these facts THROUGH `connect-team.ts` rather
 * than by importing this directory.
 *
 * Not re-exported from `../index.ts`: the package barrel is a shared surface,
 * and a hand that anything can reach by accident is not bounded by anything.
 */

export * from './config.js'
export * from './cursor.js'
export * from './key.js'
export * from './loop.js'
export * from './post.js'
export * from './ship.js'
