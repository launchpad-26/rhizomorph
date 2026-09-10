import { sessionFraction } from '../axis/position.js'
import type { FailedArm } from '../compare/types.js'
import type { LabCheckpoint, LabExperiment, LabRun, LabRunOutcome } from '../types.js'

/**
 * THE STATES, DRAWN BEFORE THE LIVE ONE (prd-55 ruling 9): every fixture the
 * canvas's tests hand it, in one place, so the empty, partial and held-back
 * pictures are records a stranger can read rather than literals scattered
 * through assertions. Nothing here names a real machine: worktrees follow the
 * collector fixtures' `/repo-wt/<lane>` convention.
 *
 * - {@link NO_DISPATCH_RECORDS} — an experiment the fold knows, with arms and
 *   no runs yet: the root is drawn, and nothing else is drawn from nothing.
 * - {@link STOPPED_LAUNCH} — two arms dispatched, a third that never did (the
 *   `FailedArm` a launch reports, prd-53 ruling 7): the stub's fixture.
 * - {@link UNMEASURED_ARM} — an arm whose runs no gate has judged: the
 *   held-back state, hollow tips and the not-measured voice.
 * - {@link LIVE_TWO_BY_THREE} — the walkthrough's real shape: two arms, three
 *   runs each, verdicts of every kind, some costs booked and some not.
 */

const provenance = { source: 'measure-route' as const, verifyCommand: 'npm run lint', measuredAt: 2000 }

export function outcomeOf(overrides: Partial<LabRunOutcome> & { verified: LabRunOutcome['verified'] }): LabRunOutcome {
  return { verifiedDetail: null, costUsd: 1, durationMs: 1, commits: 1, provenance, ...overrides }
}

export function runOf(id: string, n: number, measured?: LabRunOutcome): LabRun {
  return {
    eventId: `evt-${id}`,
    dispatchedAt: 1000,
    run: n,
    laneHandle: `lane-${id}`,
    worktreePath: `/repo-wt/lane-${id}`,
    ...(measured === undefined ? {} : { outcome: measured }),
  }
}

export function experimentOf(arms: LabExperiment['arms'], forkId = 'fork-1'): LabExperiment {
  return { forkId, parentLane: 'feature', checkpointId: 'ckpt-1', arms }
}

/**
 * How long the fixtures' session is, in bytes. One round number, so a fraction
 * is a byte a reader can do in their head — and so the rounding below never
 * lands the fixture somewhere the axis would not put it.
 */
const SESSION_BYTES = 1000

const AT_THE_START: LabCheckpoint = {
  eventId: 'evt-ckpt-1',
  lane: 'feature',
  checkpointId: 'ckpt-1',
  capturedAt: 1,
  capturedBy: 'dispatch',
  snapshotRef: 'refs/rhizomorph/checkpoints/ckpt-1',
  snapshotSha: 'snap',
  headSha: 'head',
  eventIndex: 3,
  sessionCutByte: 0,
  sessionByteLength: SESSION_BYTES,
}

/**
 * A checkpoint at a given fraction of its session — and the fraction read back
 * through THE ONE POSITION FUNCTION (`axis/position.ts`, prd-53 ruling 4)
 * before the fixture is handed out. A fixture states a position; the axis is
 * what decides one, so a fixture that rounded to a byte the axis reads
 * differently would lie quietly to every test that used it. It throws instead.
 */
export function checkpointAt(fraction: number): LabCheckpoint {
  const checkpoint: LabCheckpoint = { ...AT_THE_START, sessionCutByte: Math.round(fraction * SESSION_BYTES) }
  const at = sessionFraction(checkpoint.sessionCutByte, checkpoint.sessionByteLength)
  if (at === null || Math.abs(at - fraction) > 1 / SESSION_BYTES) {
    throw new Error(`fixture claims ${fraction} of its session; the axis reads ${String(at)} at byte ${checkpoint.sessionCutByte}`)
  }
  return checkpoint
}

/** A checkpoint at 38 % of its session — the walkthrough's own position. */
export const CHECKPOINT_AT_38: LabCheckpoint = checkpointAt(0.38)

/** A checkpoint whose session file moved — its position cannot be known (S1's degraded state). */
export const CHECKPOINT_MOVED: LabCheckpoint = { ...CHECKPOINT_AT_38, sessionByteLength: null }

export const NO_DISPATCH_RECORDS: LabExperiment = experimentOf(
  [
    { arm: 1, treatment: { model: 'opus', promptDigest: null }, runs: [] },
    { arm: 2, treatment: { model: 'sonnet', promptDigest: null }, runs: [] },
  ],
  'fork-empty',
)

export const STOPPED_LAUNCH: LabExperiment = experimentOf(
  [
    { arm: 1, treatment: { model: null, promptDigest: null }, runs: [runOf('s-a1', 1, outcomeOf({ verified: 'pass', costUsd: null })), runOf('s-a2', 2)] },
    { arm: 2, treatment: { model: null, promptDigest: null }, runs: [runOf('s-b1', 1), runOf('s-b2', 2)] },
  ],
  'fork-7be2',
)
export const STOPPED_LAUNCH_FAILED_ARMS: readonly FailedArm[] = [{ arm: 3, error: 'workmux: tmux server not running' }]

export const UNMEASURED_ARM: LabExperiment = experimentOf(
  [{ arm: 1, treatment: { model: 'opus', promptDigest: null }, runs: [runOf('u-a1', 1), runOf('u-a2', 2), runOf('u-a3', 3)] }],
  'fork-a1d1',
)

export const LIVE_TWO_BY_THREE: LabExperiment = experimentOf([
  {
    arm: 1,
    treatment: { model: 'opus', promptDigest: null },
    runs: [
      runOf('a1', 1, outcomeOf({ verified: 'pass', costUsd: 2.1 })),
      runOf('a2', 2, outcomeOf({ verified: 'pass', costUsd: 3.02 })),
      runOf('a3', 3, outcomeOf({ verified: 'pass', costUsd: 4.4 })),
    ],
  },
  {
    arm: 2,
    treatment: { model: 'sonnet', promptDigest: null },
    runs: [
      runOf('b1', 1, outcomeOf({ verified: 'fail', costUsd: 1.15, verifiedDetail: '2 tests failed' })),
      runOf('b2', 2),
      runOf('b3', 3, outcomeOf({ verified: 'not-run', costUsd: null, verifiedDetail: 'npm: not found' })),
    ],
  },
])

/** The harness's own cell (prd-49): 60 arms × 3 runs = 180 ribbons, for the reported-never-asserted budget. */
export function cellOf(arms: number, runs: number): LabExperiment {
  return {
    forkId: 'fork-perf',
    parentLane: 'feature',
    checkpointId: 'ckpt-perf',
    arms: Array.from({ length: arms }, (_unused, a) => ({
      arm: a + 1,
      treatment: { model: null, promptDigest: null },
      runs: Array.from({ length: runs }, (_u, r) => runOf(`${a + 1}-${r + 1}`, r + 1)),
    })),
  }
}
