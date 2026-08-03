/**
 * Pure derivations over SessionState. Everything the UI calls "interesting" —
 * flatlines, collisions, ahead-of-main — is computed here rather than emitted,
 * so live view and replay can never disagree.
 */

export * from './branches.js'
export * from './collisions.js'
export * from './commits.js'
export * from './liveness.js'
export * from './spend.js'
export * from './touches.js'
export * from './traces.js'
export * from './worktrees.js'
