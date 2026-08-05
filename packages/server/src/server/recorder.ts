/**
 * The recorder moved behind its own module boundary in prd16 wave 1 (ruling
 * 6): it now lives in `packages/server/src/recorder/`, together with the log
 * writer and rotation. This file stays as the front door every existing
 * caller already knows — the package barrel (`src/index.ts`), the laboratory,
 * the poll loop, the API routes — so the seam was drawn without a rename
 * sweep through code that has no business knowing where the writer lives.
 *
 * Import from here (or from `../recorder/index.js`) — never from a file
 * inside the module: `recorder/namespace-law.test.ts` keeps rotation itself
 * reachable only from the two explicit operator entry points.
 */
export { SessionRecorder, type SessionRecorderOptions } from '../recorder/index.js'
