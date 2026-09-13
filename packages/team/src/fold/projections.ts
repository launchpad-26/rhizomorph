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
  // Per lane, the ts of the row that actually SUPPLIED each coalesced field —
  // which is not the same number as `lastEventTsMs`. See the note where it is
  // read; the two being conflated is a defect this fold has already had once.
  const supplied = new Map<string, { state: number; worktree: number }>()

  for (const row of rows) {
    // RULING 16: NO PROJECTION MAY DERIVE A VALUE FROM AN UNVALIDATED PAYLOAD.
    //
    // This gates the three values THIS MODULE derives itself — `costUsdOf`, `agentStateOf` and
    // `dirtyFiles`. The other two derived values, `row.lane` and `row.worktree`, are nulled
    // upstream in `row.ts`, because by the time they arrive here they are columns and a marker
    // cannot see a derivation that already happened.
    //
    // `spend.events` is deliberately NOT gated: an unfoldable row is an event, it reached
    // storage, and a count that silently omitted some would be the dishonest answer. Ruling 16
    // makes those two verdicts explicitly different.
    const unfoldable = row.unfoldable !== undefined

    const day = utcDay(row.tsMs)
    const spendKey = `${row.projectId} ${day}`
    const currentSpend = spend.get(spendKey)
    spend.set(spendKey, {
      projectId: row.projectId,
      day,
      costUsd: (currentSpend?.costUsd ?? 0) + (unfoldable ? 0 : costUsdOf(row)),
      events: (currentSpend?.events ?? 0) + 1,
    })

    if (row.lane !== null) {
      const laneKey = `${row.projectId} ${row.lane}`
      const current = lanes.get(laneKey)
      // Gated even though `row.lane === null` already makes this unreachable for an unfoldable
      // row: the ruling names `agentStateOf` as one of the three, and the unreachability is a
      // property of `row.ts` that a later change there could remove without a sound here.
      const state = unfoldable ? null : agentStateOf(row)
      // BOTH HALVES OF THIS ARE LOAD-BEARING, AND THEY ARE PER FIELD.
      //
      // Newer wins: an older row must never overwrite a newer row's value, or
      // the delta leaves carrying a stale value stamped with the batch's
      // MAXIMUM ts, and the `lane_state` upsert's
      // `EXCLUDED.last_event_ts >= lane_state.last_event_ts` guard then accepts
      // it and refuses the true row when it arrives in a later batch. Nothing
      // downstream can correct that. Out-of-order arrival within a batch is
      // legal (ADR-0033), and `fold/worker.ts` folds every journal record past
      // the cursor in ONE call, so this is ordinary input.
      //
      // Coalesced: a newer row that says nothing about a field must not erase
      // what an older row in the same batch carried — `null` is reserved for
      // "this batch said nothing", which is what tells the adapter's `COALESCE`
      // to leave the stored value alone.
      //
      // "Newer" therefore has to be measured against the ts of the row that
      // supplied THIS FIELD, not against the lane's running maximum. Measured
      // against the maximum, a row carrying no status at all (an `llm.cost`,
      // say) lifts the bar, and a genuinely newer `agent.status` arriving after
      // it is then misread as older and dropped. That defect survived a fix
      // that only compared against `lastEventTsMs`: it is invisible at two rows
      // — there the maximum IS the supplying row's ts — and appears at three.
      const carried = supplied.get(laneKey)
      const takeState = state !== null && (carried === undefined || row.tsMs >= carried.state)
      const takeWorktree = row.worktree !== null && (carried === undefined || row.tsMs >= carried.worktree)
      lanes.set(laneKey, {
        projectId: row.projectId,
        lane: row.lane,
        state: takeState ? state : (current?.state ?? null),
        worktree: takeWorktree ? row.worktree : (current?.worktree ?? null),
        lastEventTsMs: Math.max(current?.lastEventTsMs ?? row.tsMs, row.tsMs),
      })
      supplied.set(laneKey, {
        state: takeState ? row.tsMs : (carried?.state ?? Number.NEGATIVE_INFINITY),
        worktree: takeWorktree ? row.tsMs : (carried?.worktree ?? Number.NEGATIVE_INFINITY),
      })
    }

    // Covered by the MARKER, not by `dirtyFiles`' own `row.type` gate. That gate protects the
    // unknown-TYPE arm and nothing else — an `unknown-shape` `worktree.dirty` has a known type
    // and walks straight through it. EXECUTED in the review of #417: with the marker removed and
    // the type gate standing, one such line puts a path and a lane into `collisions`.
    const dirty = unfoldable ? null : dirtyFiles(row)
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
