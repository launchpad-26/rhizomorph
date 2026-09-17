/**
 * The fleet derivation (issue #246): one derived fleet object, composed
 * entirely from this package's own selectors over `SessionState`.
 *
 * Every prd3 web surface (#77–#84) and every non-browser consumer (`server`,
 * a future CLI or doctor check) reads the same `buildFleet` from here, so a
 * lane's diagnosis can never disagree between two callers.
 */

export * from './buildFleet.js'
export * from './colony-attention.js'
export * from './fences.js'
export * from './fixtures.js'
