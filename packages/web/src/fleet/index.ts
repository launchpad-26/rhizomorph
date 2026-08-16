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
 * Every prd3 surface (#77–#84) imports from here, and nothing outside this
 * directory re-derives a lane's state.
 *
 * One line of that paragraph used to read "nothing in this directory imports a
 * panel", and prd-36 ruling 1 (#555) spent it deliberately: `FleetSurface.tsx`
 * is the one surface that owns both representations of the fleet, so it mounts
 * the scene and the fleet table as its two arms. It does so through `lazy()`,
 * so the static graph still runs one way — a panel imports from here, and the
 * surface reaches a panel only at the moment it renders it. Nothing else in
 * this directory imports a panel, and `FleetSurface` is deliberately NOT
 * re-exported below: `app/PanelGrid.tsx` imports it by path, so the barrel
 * itself never sits on a cycle.
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
