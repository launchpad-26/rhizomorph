/**
 * The instrument's model layer: one derived fleet object, one glyph alphabet,
 * one lane selection, and the fixtures that prove the detectors work.
 *
 * Every prd3 surface (#77–#84) imports from here. Nothing in this directory
 * imports a panel, and nothing outside it re-derives a lane's state.
 */

export * from './buildFleet.js'
export * from './fences.js'
export * from './fixtures.js'
export * from './FleetContext.js'
export * from './manifest.js'
export * from './selection.js'
export * from './sigils.js'
export * from './strokes.js'
