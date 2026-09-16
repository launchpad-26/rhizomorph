/**
 * THE QUESTIONS PORT — the three questions prd-51 exists to answer (#557).
 *
 * *Where is work* (`lane_state`), *what does it cost* (`spend_by_project_day`)
 * and *who is stuck* (`collisions`). All three read projections the fold
 * maintains and nothing else writes, so this port is read-only by construction:
 * there is no method here that changes anything.
 *
 * ## EVERY READ RUNS AS `rz_viewer`, AND THAT IS THIS PORT'S WHOLE POINT
 *
 * `migrations/0003_roles_rls.sql`'s header records the measurement that makes it
 * load-bearing: a superuser bypasses RLS unconditionally and
 * `FORCE ROW LEVEL SECURITY` does not close it, so per-project isolation rests
 * entirely on **which role reads**. The adapter puts every statement inside a
 * transaction that begins `SET LOCAL ROLE rz_viewer`; see `sql.ts`.
 *
 * ## WHAT THE PROJECT SCOPE IS, AND WHAT IT IS NOT
 *
 * The adapter sets `rhizomorph.project_id` from `projectId` and the policies read that same
 * setting, so **`projectId` is not an authorisation boundary — it is the scope the caller
 * chooses**. An earlier version of this docblock claimed a caller naming another project "gets
 * nothing rather than that project's rows"; that claim was circular and false, and verification
 * measured it returning the other project's rows on a real engine.
 *
 * What the pair of statements does buy is real, and it is two things: a query that forgot its
 * `WHERE` cannot return another project's rows, and the read runs with the owner's rights
 * dropped. What it does NOT buy is one member being unable to read another project.
 *
 * **Membership of the organisation is the boundary** (#169, ruling 6), which is prd-51's whole
 * premise — "nothing leaves the team". Per-project authorisation would need a per-project
 * membership model, and this deployment has none: `ports/ingest-keys/port.ts` scopes a KEY to
 * one project, which is a statement about shippers, not about readers.
 */

/** One row of `spend_by_project_day`. */
export interface SpendRow {
  readonly projectId: string
  /** `YYYY-MM-DD`. A `date` column, kept as the calendar day it is. */
  readonly day: string
  /**
   * `numeric(18,6)`, carried as the STRING the driver returns.
   *
   * Never a `number`: the column is exact decimal and JavaScript's is not, so
   * parsing here would round money on the way to a page whose only job is to
   * display it. The formatting decision belongs to the view, on the exact value.
   */
  readonly costUsd: string
  readonly events: number
}

/** One row of `lane_state`. */
export interface LaneRow {
  readonly projectId: string
  readonly lane: string
  readonly state: string
  readonly worktree: string | null
  /** Epoch milliseconds, or null. The adapter converts from `timestamptz`. */
  readonly lastEventTsMs: number | null
}

/** One row of `collisions`. */
export interface CollisionRow {
  readonly projectId: string
  readonly path: string
  /** `text[]` — the lanes contending for {@link path}. */
  readonly lanes: readonly string[]
  readonly firstSeenMs: number
  readonly lastSeenMs: number
}

export interface QuestionsPort {
  /** What does it cost — newest day first. */
  readSpendByDay(projectId: string): Promise<SpendRow[]>
  /** Where is work — by lane. */
  readLaneState(projectId: string): Promise<LaneRow[]>
  /** Who is stuck — contended paths, most recently seen first. */
  readCollisions(projectId: string): Promise<CollisionRow[]>
}
