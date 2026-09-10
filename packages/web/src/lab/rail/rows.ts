import { experimentRowCounts } from '../adapters.js'
import { percentLabel, sessionFraction } from '../axis/index.js'
import type { FailedArm } from '../compare/types.js'
import type { LabCheckpoint, LabExperiment } from '../types.js'

/**
 * WHAT A RAIL ROW SAYS (prd-55 ruling 8) — the sentences, without the markup,
 * so they can be executed rather than read off a rendered tree.
 *
 * The rail is one row per checkpoint and one row per experiment; the row is
 * the whole listing, so every fact the old checkpoint table spread across five
 * columns has to survive the shrink or be honestly dropped. Position comes
 * through the axis's one function (`axis/position.ts`, prd53 ruling 4) — a
 * rail that did the division itself is a rail that can disagree with the track
 * about where 46 % is, and `axis/position-law.test.ts` fails the build for it.
 *
 * Counts come through `adapters.ts` for the same reason one level out: the
 * row's *3 passed* and the comparison's *n = 3 of 3 completed* are the same
 * predicate or they are a lie.
 */

/** The degraded checkpoint's position, in the axis's own words — a marker WITH ITS REASON, never a blank. */
export const POSITION_UNKNOWN = 'session file moved — position unknown'

export interface CheckpointRowFacts {
  checkpointId: string
  lane: string
  /** "46 % of session", or {@link POSITION_UNKNOWN} when the session's length cannot be read. */
  position: string
  capturedBy: string
}

export function checkpointRowFacts(checkpoint: LabCheckpoint): CheckpointRowFacts {
  const percent = percentLabel(sessionFraction(checkpoint.sessionCutByte, checkpoint.sessionByteLength))
  return {
    checkpointId: checkpoint.checkpointId,
    lane: checkpoint.lane,
    position: percent === null ? POSITION_UNKNOWN : `${percent} of session`,
    capturedBy: checkpoint.capturedBy,
  }
}

export interface ExperimentRowFacts {
  forkId: string
  /** "2 arms · 6 runs" — the shape of what dispatched. */
  shape: string
  /** "3 passed · 1 failed · 2 unmeasured" — every run accounted for, none invented. */
  verdicts: string
  /**
   * "2 of 3 arms" — set only when a launch reported arms that never
   * dispatched (ruling 7). N is dispatched + never-dispatched, which is the
   * requested count the launch stamped on its outcome; `rows.test.ts` executes
   * that against `metrics/spend.ts`'s own line so the two cannot drift.
   */
  partial: string | null
}

export function experimentRowFacts(experiment: LabExperiment, failedArms: readonly FailedArm[] = []): ExperimentRowFacts {
  const counts = experimentRowCounts(experiment)
  return {
    forkId: experiment.forkId,
    shape: `${counts.arms} ${counts.arms === 1 ? 'arm' : 'arms'} · ${counts.runs} ${counts.runs === 1 ? 'run' : 'runs'}`,
    verdicts: `${counts.passed} passed · ${counts.failed} failed · ${counts.unmeasured} unmeasured`,
    partial: failedArms.length === 0 ? null : `${counts.arms} of ${counts.arms + failedArms.length} arms`,
  }
}
