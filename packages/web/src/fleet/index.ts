/**
 * The instrument's presentation layer: one glyph alphabet, one lane
 * selection, and the React wiring around the derived fleet object.
 *
 * The fleet object itself — `buildFleet`, its manifest/fence types and the
 * fixtures that prove the detectors work — moved to `@rhizomorph/core` in
 * issue #246, since nothing about deriving it is browser-specific and
 * `server` needed it too. Re-exported here so every existing `from
 * '../fleet'` import in this package keeps resolving unchanged.
 *
 * Every prd3 surface (#77–#84) imports from here. Nothing in this directory
 * imports a panel, and nothing outside it re-derives a lane's state.
 */

// Wholesale, not "the moved surface" (review of #499, item 1): this line
// re-exports ALL of @rhizomorph/core, so `import { reduceAll } from '../fleet'`
// resolves anywhere in web. Not a defect today -- any genuine name collision
// with the local exports below is a TS2308 typecheck error, not a silent
// shadow -- but the width is deliberate-by-simplicity, not an accident, and
// this comment exists so the next reader trusts the line over any prose
// claiming otherwise. Narrowing to an explicit list is fine if it ever bites.
export * from '@rhizomorph/core'
export * from './FleetContext.js'
export * from './manifest.js'
export * from './selection.js'
export * from './sigils.js'
export * from './strokes.js'
