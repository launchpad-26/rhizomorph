import { sessionFraction } from '../axis/position.js'
import type { FailedArm } from '../compare/types.js'
import type { LabCheckpoint, LabExperiment, LabRun, LabRunOutcome } from '../types.js'
import type { RailProps } from './Rail.js'

/**
 * THE RAIL'S STATES, DRAWN FIRST (prd-55 ruling 9). Every state the rail can
 * be in is a fixture here before it is a branch in `Rail.tsx`: no checkpoints,
 * checkpoints but no experiments, an experiment selected, a partial launch,
 * loading, and a failed read. They live in a source file rather than inside
 * the test for the reason `canvas/fixtures.ts` gives (prd-55 wave 2): a
 * specimen that drifts is a picture that drifts, and a specimen the walker
 * counts is a specimen someone has to keep.
 *
 * Nothing here is measured by anything: the outcomes are supplied, exactly as
 * a fixture's are, and the rail prints what it is handed.
 */

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm test', measuredAt: 2_000 }

function outcome(verified: LabRunOutcome['verified'], costUsd: number | null): LabRunOutcome {
  return { verified, verifiedDetail: null, costUsd, durationMs: null, commits: null, provenance }
}

function run(id: string, runNumber: number, measured?: LabRunOutcome): LabRun {
  return {
    eventId: id,
    dispatchedAt: 1_000 + runNumber,
    run: runNumber,
    laneHandle: `lane-${id}`,
    worktreePath: `/work/${id}`,
    ...(measured === undefined ? {} : { outcome: measured }),
  }
}

const SESSION_BYTES = 100_000

const A_CHECKPOINT: LabCheckpoint = {
  eventId: 'evt-ckpt-1',
  lane: 'feature',
  checkpointId: 'ckpt-1',
  capturedAt: Date.UTC(2026, 8, 10, 9, 30, 0),
  capturedBy: 'operator',
  snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
  snapshotSha: 'sha-1',
  headSha: 'sha-0',
  eventIndex: 12,
  sessionCutByte: 0,
  sessionByteLength: SESSION_BYTES,
}

/**
 * A checkpoint AT a fraction of its session, checked against the axis's own
 * function (prd53 ruling 4) rather than merely asserted in a comment — the
 * same self-check `canvas/fixtures.ts` makes, for the same reason: a fixture
 * that claims 46 % while the one function reads something else is a specimen
 * that would make a green test say nothing.
 */
function atFraction(fraction: number, overrides: Partial<LabCheckpoint>): LabCheckpoint {
  const checkpoint: LabCheckpoint = { ...A_CHECKPOINT, ...overrides, sessionCutByte: Math.round(fraction * SESSION_BYTES) }
  const at = sessionFraction(checkpoint.sessionCutByte, checkpoint.sessionByteLength)
  if (at !== fraction) {
    throw new Error(`fixture claims ${fraction} of its session; the axis reads ${String(at)} at byte ${checkpoint.sessionCutByte}`)
  }
  return checkpoint
}

/** A checkpoint 46 % into its session — the ordinary live row. */
export const RAIL_CHECKPOINT: LabCheckpoint = atFraction(0.46, {})

/** A checkpoint at the very end of its session — the playhead label's late case. */
export const RAIL_LATE_CHECKPOINT: LabCheckpoint = atFraction(1, {
  eventId: 'evt-ckpt-2',
  checkpointId: 'ckpt-2',
  lane: 'w5-sweep',
  capturedBy: 'dispatch',
  eventIndex: 40,
})

/** The degraded row (S1): its session file moved, so it has a reason where a position would be. */
export const RAIL_DEGRADED_CHECKPOINT: LabCheckpoint = {
  ...RAIL_CHECKPOINT,
  eventId: 'evt-ckpt-3',
  checkpointId: 'ckpt-3',
  sessionByteLength: null,
}

/** Two arms, three runs each: three passed, one failed, two nobody judged. */
export const RAIL_EXPERIMENT: LabExperiment = {
  forkId: 'fork-a1d1',
  parentLane: 'feature',
  checkpointId: 'ckpt-1',
  arms: [
    {
      arm: 1,
      treatment: { model: 'claude-opus-5', promptDigest: null },
      runs: [run('a1r1', 1, outcome('pass', 2.1)), run('a1r2', 2, outcome('pass', 3.02)), run('a1r3', 3, outcome('pass', 4.4))],
    },
    {
      arm: 2,
      treatment: { model: 'claude-sonnet-5', promptDigest: null },
      runs: [run('a2r1', 1, outcome('fail', 1.15)), run('a2r2', 2), run('a2r3', 3, outcome('not-run', null))],
    },
  ],
}

/** The partial launch's fork: two arms on the record, a third the launch asked for that never dispatched. */
export const RAIL_PARTIAL_EXPERIMENT: LabExperiment = { ...RAIL_EXPERIMENT, forkId: 'fork-7be2' }

export const RAIL_FAILED_ARMS: readonly FailedArm[] = [{ arm: 3, error: 'workmux: tmux server not running' }]

const inert = {
  onSeat: () => {},
  onSelectExperiment: () => {},
}

/**
 * One entry per state ruling 9 asks to be drawn before the live one. The keys
 * are the states' own names, so a test that walks them names the state it is
 * checking rather than an index.
 */
export const RAIL_STATES: Readonly<Record<string, RailProps>> = {
  'no-checkpoints': {
    ...inert,
    checkpoints: { status: 'ready', items: [] },
    experiments: { status: 'ready', items: [] },
    seated: null,
    selectedFork: null,
  },
  'checkpoints-no-experiments': {
    ...inert,
    checkpoints: { status: 'ready', items: [RAIL_CHECKPOINT, RAIL_LATE_CHECKPOINT] },
    experiments: { status: 'ready', items: [] },
    seated: null,
    selectedFork: null,
  },
  'experiment-selected': {
    ...inert,
    checkpoints: { status: 'ready', items: [RAIL_CHECKPOINT] },
    experiments: { status: 'ready', items: [RAIL_EXPERIMENT] },
    seated: 'ckpt-1',
    selectedFork: 'fork-a1d1',
  },
  partial: {
    ...inert,
    checkpoints: { status: 'ready', items: [RAIL_CHECKPOINT] },
    experiments: { status: 'ready', items: [RAIL_PARTIAL_EXPERIMENT] },
    seated: 'ckpt-1',
    selectedFork: 'fork-7be2',
    failedByFork: { 'fork-7be2': RAIL_FAILED_ARMS },
  },
  degraded: {
    ...inert,
    checkpoints: { status: 'ready', items: [RAIL_DEGRADED_CHECKPOINT] },
    experiments: { status: 'ready', items: [] },
    seated: null,
    selectedFork: null,
  },
  loading: {
    ...inert,
    checkpoints: { status: 'loading' },
    experiments: { status: 'loading' },
    seated: null,
    selectedFork: null,
  },
  error: {
    ...inert,
    checkpoints: { status: 'error', message: 'HTTP 500' },
    experiments: { status: 'error', message: 'HTTP 500' },
    seated: null,
    selectedFork: null,
  },
}
