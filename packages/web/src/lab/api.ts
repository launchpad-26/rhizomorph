import type { FetchLike } from '../replay/api.js'
import type { LabArm, LabCheckpoint, LabCheckpointCapturedBy, LabExperiment, LabRun, LabTreatment } from './types.js'

export type { FetchLike }

/**
 * Parses `GET /api/lab/checkpoints` and `GET /api/lab/experiments`
 * (`packages/server/src/api/lab.ts`) into this package's own vocabulary
 * (`./types.js`). Every field is validated rather than cast — a server that
 * predates this route, or answers something malformed, must read as "the lab
 * cannot see" (a thrown error), never as a silently empty or half-populated
 * list (the honest-empty-state law this wave lands).
 */

const CAPTURED_BY: readonly LabCheckpointCapturedBy[] = ['dispatch', 'gate', 'operator']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCapturedBy(value: unknown): value is LabCheckpointCapturedBy {
  return typeof value === 'string' && (CAPTURED_BY as readonly string[]).includes(value)
}

function isLabCheckpoint(value: unknown): value is LabCheckpoint {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.lane === 'string' &&
    typeof value.checkpointId === 'string' &&
    typeof value.capturedAt === 'number' &&
    isCapturedBy(value.capturedBy) &&
    typeof value.snapshotRef === 'string' &&
    typeof value.snapshotSha === 'string' &&
    typeof value.headSha === 'string'
  )
}

function isLabTreatment(value: unknown): value is LabTreatment {
  return (
    isRecord(value) &&
    (typeof value.model === 'string' || value.model === null) &&
    (typeof value.promptDigest === 'string' || value.promptDigest === null)
  )
}

function isLabRun(value: unknown): value is LabRun {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.dispatchedAt === 'number' &&
    typeof value.laneHandle === 'string' &&
    typeof value.worktreePath === 'string'
  )
}

function isLabArm(value: unknown): value is LabArm {
  return (
    isRecord(value) &&
    typeof value.arm === 'number' &&
    isLabTreatment(value.treatment) &&
    Array.isArray(value.runs) &&
    value.runs.every(isLabRun)
  )
}

function isLabExperiment(value: unknown): value is LabExperiment {
  return (
    isRecord(value) &&
    typeof value.forkId === 'string' &&
    typeof value.parentLane === 'string' &&
    typeof value.checkpointId === 'string' &&
    Array.isArray(value.arms) &&
    value.arms.every(isLabArm)
  )
}

/** Every checkpoint this repo has captured, in the order the server folded them. */
export async function fetchLabCheckpoints(fetchImpl: FetchLike = fetch): Promise<LabCheckpoint[]> {
  const response = await fetchImpl('/api/lab/checkpoints')
  if (!response.ok) throw new Error(`/api/lab/checkpoints responded ${response.status}`)
  const data: unknown = await response.json()
  const checkpoints = isRecord(data) && Array.isArray(data.checkpoints) ? data.checkpoints : []
  if (!checkpoints.every(isLabCheckpoint)) {
    throw new Error('/api/lab/checkpoints returned a shape this console does not recognise')
  }
  return checkpoints
}

/** Every experiment this repo has run, in the order the server folded them. */
export async function fetchLabExperiments(fetchImpl: FetchLike = fetch): Promise<LabExperiment[]> {
  const response = await fetchImpl('/api/lab/experiments')
  if (!response.ok) throw new Error(`/api/lab/experiments responded ${response.status}`)
  const data: unknown = await response.json()
  const experiments = isRecord(data) && Array.isArray(data.experiments) ? data.experiments : []
  if (!experiments.every(isLabExperiment)) {
    throw new Error('/api/lab/experiments returned a shape this console does not recognise')
  }
  return experiments
}
