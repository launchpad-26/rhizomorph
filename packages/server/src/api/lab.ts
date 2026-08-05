import type { RhizomorphEvent } from '@rhizomorph/core'
import { reduceAll } from '@rhizomorph/core'
import type { FastifyInstance } from 'fastify'
import { listSessions, readSessionEvents, sessionFilePath } from '../log/session-log.js'
import type { ServerContext } from '../server/context.js'

/**
 * Read-only routes over the laboratory's own event slice (prd12 rulings 2/3;
 * prd14 wave 1 — "the seam and the route"): every `fork.checkpoint` this repo
 * has captured, and every experiment (`fork.dispatched`, grouped by forkId)
 * it has run.
 *
 * These routes read `@rhizomorph/core`'s fold directly (`reduceAll` →
 * `state.checkpoints` / `state.forks`) rather than importing anything under
 * `server/src/lab/` — `lab/namespace-law.test.ts` confines that module to its
 * one CLI wiring point (prd12 ruling 1: the laboratory is a second,
 * explicitly-invoked hand, never reachable from a request a background
 * process — or an always-on server route — could trigger). A GET here can
 * never write; it folds the same log every other route already reads.
 */

export interface LabCheckpointDTO {
  eventId: string
  lane: string
  checkpointId: string
  capturedAt: number
  capturedBy: string
  snapshotRef: string
  snapshotSha: string
  headSha: string
}

export interface LabTreatmentDTO {
  model: string | null
  promptDigest: string | null
}

export interface LabRunDTO {
  eventId: string
  dispatchedAt: number
  laneHandle: string
  worktreePath: string
}

export interface LabArmDTO {
  arm: number
  treatment: LabTreatmentDTO
  runs: LabRunDTO[]
}

export interface LabExperimentDTO {
  forkId: string
  parentLane: string
  checkpointId: string
  arms: LabArmDTO[]
}

/**
 * Every event this repo has recorded, across every session file plus the
 * live recorder's own buffer — the same merge `log/listing.ts`'s
 * `listSessionListings` performs, so a request can never race the live
 * writer's append (reads the buffer, not the file it hasn't flushed to yet).
 */
async function readAllEvents(ctx: ServerContext): Promise<RhizomorphEvent[]> {
  const summaries = await listSessions(ctx.sessionDir)
  const events: RhizomorphEvent[] = []
  let sawLive = false

  for (const summary of summaries) {
    if (summary.id === ctx.recorder.sessionId) {
      sawLive = true
      events.push(...ctx.recorder.eventsSoFar())
    } else {
      events.push(...(await readSessionEvents(sessionFilePath(ctx.sessionDir, summary.id))))
    }
  }

  // The live session may not have a file on disk yet (its first event hasn't
  // landed) — `listSessions` only sees files, so its buffer would otherwise
  // be missing entirely rather than just late.
  if (!sawLive) events.push(...ctx.recorder.eventsSoFar())

  return events
}

/** `state.checkpoints.records`, oldest first — the same chronological order `GET /api/sessions` lists in. */
function checkpointDTOs(events: readonly RhizomorphEvent[]): LabCheckpointDTO[] {
  const state = reduceAll(events)
  return state.checkpoints.records.map((record) => ({
    eventId: record.eventId,
    lane: record.lane,
    checkpointId: record.checkpointId,
    capturedAt: record.ts,
    capturedBy: record.capturedBy,
    snapshotRef: record.snapshotRef,
    snapshotSha: record.snapshotSha,
    headSha: record.headSha,
  }))
}

/**
 * `state.forks.dispatches`, grouped first by `forkId` (an experiment), then
 * by `arm` number within it (one arm, one or more runs) — mirroring
 * `lab/compare.ts`'s own grouping over the identical state, without
 * importing that module (see the file doc).
 */
function experimentDTOs(events: readonly RhizomorphEvent[]): LabExperimentDTO[] {
  const state = reduceAll(events)
  const experiments: LabExperimentDTO[] = []

  for (const forkId of Object.keys(state.forks.byFork)) {
    const positions = state.forks.byFork[forkId] ?? []
    const dispatches = positions.map((at) => state.forks.dispatches[at]).filter((d) => d !== undefined)
    if (dispatches.length === 0) continue

    const armsByNumber = new Map<number, LabArmDTO>()
    for (const dispatch of dispatches) {
      const run: LabRunDTO = {
        eventId: dispatch.eventId,
        dispatchedAt: dispatch.ts,
        laneHandle: dispatch.laneHandle,
        worktreePath: dispatch.worktreePath,
      }
      const existing = armsByNumber.get(dispatch.arm)
      if (existing === undefined) {
        armsByNumber.set(dispatch.arm, {
          arm: dispatch.arm,
          treatment: { model: dispatch.model, promptDigest: dispatch.promptDigest },
          runs: [run],
        })
      } else {
        existing.runs.push(run)
      }
    }

    const first = dispatches[0]
    if (first === undefined) continue
    experiments.push({
      forkId,
      parentLane: first.parentLane,
      checkpointId: first.checkpointId,
      arms: [...armsByNumber.values()].sort((a, b) => a.arm - b.arm),
    })
  }

  return experiments
}

export function registerLabRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/lab/checkpoints', async () => {
    const events = await readAllEvents(ctx)
    return { checkpoints: checkpointDTOs(events) }
  })

  app.get('/api/lab/experiments', async () => {
    const events = await readAllEvents(ctx)
    return { experiments: experimentDTOs(events) }
  })
}
