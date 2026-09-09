import type { CollisionDelta, EventRow, LaneStateDelta, ProjectionDelta, SpendDelta } from '../storage/contract.js'

/**
 * THE THREE PROJECTIONS, AS A PURE FOLD (prd-51 ruling 5).
 *
 * `(rows) => ProjectionDelta`. No SQL, no driver type, no promise, no clock —
 * the adapter calls this **inside** its transaction and upserts what comes
 * back, and that is the whole of how ruling 4's ordering is expressed without
 * anything physical crossing the storage port.
 *
 * **It is called with the rows that were actually INSERTED, never with the
 * batch.** `spend_by_project_day.cost_usd` is a sum: events dedup through
 * `ON CONFLICT DO NOTHING` and money does not, so a delta derived from the
 * batch double-counts on every replay while the row count stays right. That
 * defect is invisible in the events table and permanent in the projection.
 *
 * **It is a fold over its input, not an accumulator.** The same rows twice
 * produce the same delta; idempotence lives in the transaction that dedups the
 * rows, not here.
 *
 * ## What this is NOT
 *
 * The incremental half of the read side, and only that. `collisions` here is a
 * per-batch upsert of `(path, lanes)` pairs; the whole-state matrix is
 * `packages/core/src/selectors/collisions.ts` and stays there, because it needs
 * reduced state a single batch does not have. The Definition of done's *"the
 * projections are maintained by the fold worker"* is discharged by the upsert,
 * not by reproducing the selector.
 */

/** `payload.costUsd`, when the event carries dollars. `llm.cost` does; nothing else is assumed to. */
function costUsdOf(row: EventRow): number {
  if (typeof row.payload !== 'object' || row.payload === null) return 0
  const value = (row.payload as Record<string, unknown>).costUsd
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** UTC `YYYY-MM-DD` — the `day` key of `spend_by_project_day`, and the same UTC the partition uses. */
export function utcDay(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10)
}

/** The dirty-file snapshot's own file list, when this row is one. */
function dirtyFiles(row: EventRow): { branch: string | null; paths: string[] } | null {
  if (row.type !== 'worktree.dirty') return null
  if (typeof row.payload !== 'object' || row.payload === null) return null
  const payload = row.payload as Record<string, unknown>
  if (!Array.isArray(payload.files)) return null
  const branch = typeof payload.branch === 'string' && payload.branch.length > 0 ? payload.branch : null
  const paths: string[] = []
  for (const file of payload.files) {
    if (typeof file !== 'object' || file === null) continue
    const filePath = (file as Record<string, unknown>).path
    if (typeof filePath === 'string' && filePath.length > 0) paths.push(filePath)
  }
  return { branch, paths }
}

/** The `agent.status` payload's `status`, when this row is one. */
function agentStateOf(row: EventRow): string | null {
  if (row.type !== 'agent.status') return null
  if (typeof row.payload !== 'object' || row.payload === null) return null
  const status = (row.payload as Record<string, unknown>).status
  return typeof status === 'string' && status.length > 0 ? status : null
}

export function projectionsFor(rows: readonly EventRow[]): ProjectionDelta {
  const spend = new Map<string, SpendDelta>()
  const lanes = new Map<string, LaneStateDelta>()
  const collisions = new Map<string, CollisionDelta>()

  for (const row of rows) {
    const day = utcDay(row.tsMs)
    const spendKey = `${row.projectId} ${day}`
    const currentSpend = spend.get(spendKey)
    spend.set(spendKey, {
      projectId: row.projectId,
      day,
      costUsd: (currentSpend?.costUsd ?? 0) + costUsdOf(row),
      events: (currentSpend?.events ?? 0) + 1,
    })

    if (row.lane !== null) {
      const laneKey = `${row.projectId} ${row.lane}`
      const current = lanes.get(laneKey)
      const state = agentStateOf(row)
      // Within one batch the newest ts wins; an older row still contributes a
      // state the newer one did not carry, which is why `state` is coalesced
      // rather than overwritten.
      const newest = current === undefined || row.tsMs >= current.lastEventTsMs
      lanes.set(laneKey, {
        projectId: row.projectId,
        lane: row.lane,
        state: state ?? current?.state ?? null,
        worktree: newest
          ? (row.worktree ?? current?.worktree ?? null)
          : (current?.worktree ?? row.worktree ?? null),
        lastEventTsMs: Math.max(current?.lastEventTsMs ?? row.tsMs, row.tsMs),
      })
    }

    const dirty = dirtyFiles(row)
    if (dirty !== null && dirty.branch !== null) {
      for (const filePath of dirty.paths) {
        const key = `${row.projectId} ${filePath}`
        const current = collisions.get(key)
        collisions.set(key, {
          projectId: row.projectId,
          path: filePath,
          lanes: [...new Set([...(current?.lanes ?? []), dirty.branch])].sort(),
          firstSeenMs: Math.min(current?.firstSeenMs ?? row.tsMs, row.tsMs),
          lastSeenMs: Math.max(current?.lastSeenMs ?? row.tsMs, row.tsMs),
        })
      }
    }
  }

  return { spend: [...spend.values()], lanes: [...lanes.values()], collisions: [...collisions.values()] }
}
