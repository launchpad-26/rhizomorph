import { toEpochMs, toNullableString, toTimestamptz } from '../../coerce.js'
import { runDdl } from '../../ddl.js'
import type { SqlLike } from '../../driver.js'
import type { EventQuery, EventRow, EventsPort, ProjectionDelta } from './port.js'

/** `YYYY-MM`, and nothing else. See {@link buildMonthlyPartitionDdl}. */
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/** `events_YYYY_MM`, and nothing else. The gate on every interpolated partition identifier. */
const PARTITION_RE = /^events_\d{4}_(?:0[1-9]|1[0-2])$/

/** The eleven columns of ruling 5's events table, in the order every insert binds them. */
const EVENT_COLUMNS = 'project_id, actor_instance, n, event_id, ts, type, source, lane, worktree, payload, line'

/**
 * The identity function on `line`.
 *
 * It exists so that "nothing transforms `line`" has a named place to be
 * violated and a named place to be tested. If a later lane ever needs to touch
 * `line`, they touch this, and `postgres.test.ts`'s byte corpus goes red for
 * them rather than for whoever re-exports a ledger six months later.
 */
export function bindLine(line: string): string {
  return line
}

/**
 * The partition top-up statement for one month.
 *
 * `month` is validated against {@link MONTH_RE} before a single character of it
 * reaches the string, and the only characters that can survive that regex are
 * digits and one hyphen. That is what makes an interpolated identifier
 * defensible here and nowhere else — a partition name is an identifier, and
 * identifiers are not bindable.
 */
export function buildMonthlyPartitionDdl(month: string): string {
  const match = MONTH_RE.exec(month)
  if (!match) {
    throw new Error(`ensureMonthlyPartition: month must be YYYY-MM, received ${JSON.stringify(month)}`)
  }
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  const start = `${match[1]}-${match[2]}-01`
  const nextYear = monthNumber === 12 ? year + 1 : year
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1
  const end = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`
  const name = `events_${match[1]}_${match[2]}`
  // The partition and its unique index are created TOGETHER. A partition
  // without the index accepts the targeted `ON CONFLICT` nowhere — the
  // inference has nothing to find and the insert errors — so a top-up that
  // built only the table would produce a month that silently refused every
  // batch. `runDdl` uses `.simple()`, which takes both statements.
  return [
    `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF events FOR VALUES FROM ('${start}') TO ('${end}')`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${name}_pos_uq ON ${name} (project_id, actor_instance, n)`,
  ].join(';\n')
}

/**
 * The partition one row belongs to, derived from its own `ts` in **UTC**.
 *
 * Derived here, inside the adapter, and never named by a caller: a caller that
 * said `events_2026_09` would have a physical storage detail leaking past the
 * port, which is the exact falsifier this issue was asked to rule on.
 *
 * The result is checked against {@link PARTITION_RE} before it is interpolated,
 * by the same argument {@link buildMonthlyPartitionDdl} already makes — an
 * identifier is not bindable, so the guard is the whole safety story.
 *
 * **A hazard, recorded rather than solved.** `migrations/0001_events.sql` writes
 * partition bounds as bare date literals against a `timestamptz` column, so
 * PostgreSQL interprets them in the *session's* `TimeZone`, while this function
 * works in UTC. The two agree only on a server running UTC. Not executed — this
 * package stands up no Postgres — and deliberately not "fixed" here by guessing
 * a conversion, because that is a schema change to an applied migration. Wave 4
 * is where it meets a real host.
 */
export function partitionNameFor(tsMs: number): string {
  if (!Number.isFinite(tsMs)) {
    throw new Error(`appendEvents: a row's tsMs must be a finite epoch-millisecond value, received ${JSON.stringify(tsMs)}`)
  }
  const at = new Date(tsMs)
  const name = `events_${at.getUTCFullYear()}_${String(at.getUTCMonth() + 1).padStart(2, '0')}`
  if (!PARTITION_RE.test(name)) {
    throw new Error(`appendEvents: tsMs ${tsMs} falls outside the partition naming this build can express (${name})`)
  }
  return name
}

/**
 * A tagged-template `strings` array built at runtime.
 *
 * This is how the partition identifier reaches the *statement text* while every
 * value still reaches the server as a bound parameter. A tagged template's
 * literal parts are fixed at parse time, and a partition name is not known
 * then; calling the tag as an ordinary function with a synthesized `strings`
 * array is the same call the compiler would have made. postgres.js dispatches
 * on `Array.isArray(strings.raw)` and takes this path (`node_modules/postgres/src/index.js`),
 * and it keeps the package's ONE `unsafe()` call site intact — the alternative
 * was a second escape hatch, which ADR-0043 makes a decision rather than a
 * convenience.
 */
function template(parts: readonly string[]): TemplateStringsArray {
  const strings = [...parts] as string[] & { raw: string[] }
  strings.raw = [...parts]
  return strings as unknown as TemplateStringsArray
}

/** The partition-targeted insert, as literal text plus eleven bind slots. */
function insertTemplate(partition: string): TemplateStringsArray {
  return template([
    `INSERT INTO ${partition} (${EVENT_COLUMNS}) VALUES (`,
    ', ',
    ', ',
    ', ',
    ', ',
    '::timestamptz, ',
    ', ',
    ', ',
    ', ',
    ', ',
    '::jsonb, ',
    ') ON CONFLICT (project_id, actor_instance, n) DO NOTHING',
  ])
}

/**
 * The three projections, upserted inside the caller's transaction (ruling 5).
 *
 * Every statement here is an `ON CONFLICT … DO UPDATE`, and every one of them
 * uses only grants `0003_roles_rls.sql` gives `rz_ingest`: SELECT, INSERT and
 * UPDATE on the three projection tables. `../../../fold/worker.test.ts`
 * cross-checks the statements this actually sends against that file's own
 * `GRANT`s, so a future `RETURNING` or a read of `events` reddens there rather
 * than on a host.
 *
 * The two upserts that could rewind are guarded rather than trusted:
 * `lane_state` refuses an arrival older than what it holds, and `collisions`
 * takes `LEAST`/`GREATEST` on its two timestamps. Out-of-order arrival is
 * legal — ADR-0033 makes ordering within a batch explicitly not an invariant.
 */
async function upsertProjections(tx: SqlLike, delta: ProjectionDelta): Promise<void> {
  for (const spend of delta.spend) {
    await tx`
      INSERT INTO spend_by_project_day (project_id, day, cost_usd, events)
      VALUES (${spend.projectId}, ${spend.day}::date, ${spend.costUsd}, ${spend.events})
      ON CONFLICT (project_id, day) DO UPDATE SET
        cost_usd = spend_by_project_day.cost_usd + EXCLUDED.cost_usd,
        events = spend_by_project_day.events + EXCLUDED.events,
        updated_at = now()
    `
  }

  for (const lane of delta.lanes) {
    // `state` is NOT NULL, and a batch that carried no `agent.status` for this
    // lane must not invent one. So the parameter is bound twice: once with a
    // fallback for the INSERT arm, and once bare in the UPDATE arm, where
    // COALESCE against the stored value leaves it alone.
    await tx`
      INSERT INTO lane_state (project_id, lane, state, worktree, last_event_ts)
      VALUES (
        ${lane.projectId},
        ${lane.lane},
        COALESCE(${lane.state}::text, 'unknown'),
        ${lane.worktree},
        ${toTimestamptz(lane.lastEventTsMs)}::timestamptz
      )
      ON CONFLICT (project_id, lane) DO UPDATE SET
        state = COALESCE(${lane.state}::text, lane_state.state),
        worktree = COALESCE(EXCLUDED.worktree, lane_state.worktree),
        last_event_ts = EXCLUDED.last_event_ts,
        updated_at = now()
      WHERE EXCLUDED.last_event_ts >= lane_state.last_event_ts
    `
  }

  for (const collision of delta.collisions) {
    await tx`
      INSERT INTO collisions (project_id, path, lanes, first_seen, last_seen)
      VALUES (
        ${collision.projectId},
        ${collision.path},
        ${collision.lanes as string[]},
        ${toTimestamptz(collision.firstSeenMs)}::timestamptz,
        ${toTimestamptz(collision.lastSeenMs)}::timestamptz
      )
      ON CONFLICT (project_id, path) DO UPDATE SET
        lanes = ARRAY(SELECT DISTINCT unnest(collisions.lanes || EXCLUDED.lanes) ORDER BY 1),
        first_seen = LEAST(collisions.first_seen, EXCLUDED.first_seen),
        last_seen = GREATEST(collisions.last_seen, EXCLUDED.last_seen),
        updated_at = now()
    `
  }
}

export function createEventsSql(sql: SqlLike): EventsPort {
  return {
    /**
     * ORDERING 2's transaction: insert, then the projections, then COMMIT.
     *
     * The insert targets **the month's partition**, not the parent (prd-51's
     * 2026-09-08 amendment). Against the parent the targeted `ON CONFLICT`
     * cannot work — `ERROR: there is no unique or exclusion constraint matching
     * the ON CONFLICT specification`, executed on PostgreSQL 18.4 — and the
     * untargeted form was rejected on a measured failure: it swallows *any*
     * unique violation, which silently drops a row carrying a fresh
     * `(project_id, actor_instance, n)`, i.e. it manufactures the gap in `n`
     * ruling 3 forbids.
     *
     * **A row counts as inserted when the statement reports one affected row.**
     * Not `RETURNING`: that needs `SELECT` on every column it names and
     * `rz_ingest` holds INSERT only on `events`. See `driver.ts`'s `SqlResult`.
     */
    async appendEvents(
      rows: readonly EventRow[],
      projectionsFor?: (inserted: readonly EventRow[]) => ProjectionDelta,
    ): Promise<number> {
      if (rows.length === 0) return 0
      return await sql.begin(async (tx) => {
        const inserted: EventRow[] = []
        for (const row of rows) {
          const result = await tx(
            insertTemplate(partitionNameFor(row.tsMs)),
            row.projectId,
            row.actorInstance,
            row.n,
            row.eventId,
            toTimestamptz(row.tsMs),
            row.type,
            row.source,
            row.lane,
            row.worktree,
            JSON.stringify(row.payload),
            bindLine(row.line),
          )
          if (result.count > 0) inserted.push(row)
        }

        if (projectionsFor) await upsertProjections(tx, projectionsFor(inserted))

        return inserted.length
      })
    },

    async readEvents(q: EventQuery): Promise<EventRow[]> {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT project_id, actor_instance, n, event_id, ts, type, source, lane, worktree, payload, line
        FROM events
        WHERE project_id = ${q.projectId}
          AND actor_instance = ${q.actorInstance}
          AND n >= ${q.fromN}
          AND n <= ${q.toN}
        ORDER BY n
      `
      return rows.map((row) => ({
        projectId: String(row.project_id),
        actorInstance: String(row.actor_instance),
        n: Number(row.n),
        eventId: String(row.event_id),
        tsMs: toEpochMs(row.ts),
        type: String(row.type),
        source: String(row.source),
        lane: toNullableString(row.lane),
        worktree: toNullableString(row.worktree),
        payload: row.payload,
        line: String(row.line),
      }))
    },

    async ensureMonthlyPartition(month: string): Promise<void> {
      await runDdl(sql, buildMonthlyPartitionDdl(month))
    },
  }
}
