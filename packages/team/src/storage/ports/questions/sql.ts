import { toEpochMs, toNullableString } from '../../coerce.js'
import type { SqlLike } from '../../driver.js'
import type { CollisionRow, LaneRow, QuestionsPort, SpendRow } from './port.js'

/**
 * THE VIEWER'S ROLE, AND WHY IT IS `SET LOCAL` (#557).
 *
 * `0003_roles_rls.sql` says the isolation guarantee "rests on a deployment fact
 * this migration cannot enforce: wave 3 reads as `rz_viewer` or `rz_readonly`,
 * never as the owner and never as a superuser." This constant is that fact.
 *
 * **`SET LOCAL`, never `SET`.** `SET LOCAL` reverts at COMMIT, so the role
 * cannot outlive the transaction that set it. The alternative leaks in both
 * directions on a pooled connection: a later caller inherits `rz_viewer` and
 * loses writes it is entitled to, or — far worse and silent — a connection that
 * failed to reset hands the *next* viewer the owner's rights and every row in
 * the database. Nothing in a functional test distinguishes those two.
 *
 * **Membership, not a login.** `rz_viewer` is `NOLOGIN` and has no password;
 * `0006_viewer_role_membership.sql` makes the owner a member so this statement
 * is legal. Before that migration this worked anyway, by accident — the app
 * connects as the instance superuser and a superuser may `SET ROLE` to anything
 * — which would have failed OPEN, as a viewer reading every project, the day
 * anyone narrowed the app's role.
 *
 * The constant is what `questions.test.ts` compares the statement tape against.
 * It is NOT interpolated into the query: a tagged template would parameterise it
 * and `SET ROLE $1` is not valid SQL, so the text below is written out in each
 * call site and the test is what holds the two spellings together.
 */
export const VIEWER_ROLE = 'set local role rz_viewer'

/**
 * The project scope the policies in `0003_roles_rls.sql` actually read.
 *
 * Every policy is `USING (project_id = current_setting('rhizomorph.project_id', true))`.
 * `set_config` rather than `SET LOCAL <name> = <value>`, because the value is a
 * caller-supplied string and only the function form can be parameterised — the
 * statement form would mean interpolating it into SQL.
 */
export const VIEWER_PROJECT_GUC = 'rhizomorph.project_id'

/**
 * Every question, in one shape: one transaction, the role first, then the read.
 *
 * The role statement is the first thing sent inside the transaction and there is
 * exactly one place it can go missing. `questions.test.ts` asserts it against the
 * statement tape rather than against the rows, because a viewer that silently
 * reads as the owner returns MORE rows, not fewer — every functional assertion
 * still passes.
 */
async function asViewer<T>(sql: SqlLike, projectId: string, read: (tx: SqlLike) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    // THE GUC FIRST, THEN THE ROLE. Both are required and neither is optional:
    // without the setting `current_setting(...)` is NULL, `project_id = NULL` is
    // NULL, and the policy admits NOTHING — a viewer that is correct, gated,
    // well-tested and permanently EMPTY. Without the role the owner reads every
    // project. The two failures point opposite ways and only one of them looks
    // like a bug.
    await tx`select set_config('rhizomorph.project_id', ${projectId}, true)`
    await tx`set local role rz_viewer`
    return await read(tx)
  })
}

export function createQuestionsSql(sql: SqlLike): QuestionsPort {
  return {
    async readSpendByDay(projectId: string): Promise<SpendRow[]> {
      return await asViewer(sql, projectId, async (tx) => {
        const rows = await tx<readonly Record<string, unknown>[]>`
          select project_id, day, cost_usd, events
          from spend_by_project_day
          where project_id = ${projectId}
          order by day desc
        `
        return rows.map((r) => ({
          projectId: String(r.project_id),
          // `date` arrives as a Date from the driver and as a string from a fake;
          // both mean the same calendar day, and the view prints it verbatim.
          day: r.day instanceof Date ? (r.day.toISOString().slice(0, 10) as string) : String(r.day),
          // STRING, deliberately — see `SpendRow.costUsd`. `numeric` is exact and a
          // `Number()` here would round money before anything displayed it.
          costUsd: String(r.cost_usd),
          events: Number(r.events),
        }))
      })
    },

    async readLaneState(projectId: string): Promise<LaneRow[]> {
      return await asViewer(sql, projectId, async (tx) => {
        const rows = await tx<readonly Record<string, unknown>[]>`
          select project_id, lane, state, worktree, last_event_ts
          from lane_state
          where project_id = ${projectId}
          order by lane asc
        `
        return rows.map((r) => ({
          projectId: String(r.project_id),
          lane: String(r.lane),
          state: String(r.state),
          worktree: toNullableString(r.worktree),
          lastEventTsMs: r.last_event_ts === null || r.last_event_ts === undefined ? null : toEpochMs(r.last_event_ts),
        }))
      })
    },

    async readCollisions(projectId: string): Promise<CollisionRow[]> {
      return await asViewer(sql, projectId, async (tx) => {
        const rows = await tx<readonly Record<string, unknown>[]>`
          select project_id, path, lanes, first_seen, last_seen
          from collisions
          where project_id = ${projectId}
          order by last_seen desc
        `
        return rows.map((r) => ({
          projectId: String(r.project_id),
          path: String(r.path),
          lanes: Array.isArray(r.lanes) ? r.lanes.map((l) => String(l)) : [],
          firstSeenMs: toEpochMs(r.first_seen),
          lastSeenMs: toEpochMs(r.last_seen),
        }))
      })
    },
  }
}
