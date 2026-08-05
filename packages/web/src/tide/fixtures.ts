/**
 * Shared constants for the TIDE's remaining property-style laws
 * (`chapters.test.ts`). The seeded event-log generator that used to live here
 * alongside these (issue #167, for the density band's own property tests)
 * went with the band when prd13 ruling 13 cut it (issue #194) — every
 * consumer of `generateEventLog` was a band-only test file, deleted with it.
 * `chapters.test.ts` keeps its own local generator (extended with
 * `session.started` and `tool_blocked` spans the band generator never
 * produced) rather than sharing this one.
 */

export const TIDE_START_TS = Date.UTC(2026, 7, 4, 14, 0, 0)

/** Four handles, so ordering and coalescing have something to chew on. */
export const TIDE_LANES = ['ke5', 'm2', 'q9', 'w1'] as const
