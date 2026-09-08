import type { AppliedMigration, EventQuery, EventRow, TeamStorage } from './contract.js'
import type { SqlLike } from './driver.js'

/**
 * THE POSTGRES ADAPTER — the only module in `packages/team` allowed to contain SQL.
 *
 * `no-sql-outside-storage-law.test.ts` holds that as a grep law over this
 * package's non-test sources: no `postgres` import outside `driver.ts`, no
 * tagged-template query and no `.unsafe(` outside this file, and no SQL
 * statement literal outside this file. The law is what makes ruling 5's
 * "storage behind an interface" a checkable property rather than a habit.
 *
 * Typed against {@link SqlLike} — the hand-written driver slice — and not
 * against `postgres.Sql`, so `recording-sql.ts` can stand in for a database and
 * the tests can assert **which statements are sent and which bytes are bound**.
 *
 * ## What this file's tests prove, and what they honestly do not
 *
 * `postgres.test.ts` proves the adapter does not touch the bytes it is given:
 * `line` reaches the bound parameter unchanged, `payload` is a parameter and
 * never interpolated, and the batch and the migration each sit inside one
 * transaction. It does **not** prove that Postgres itself stores and returns
 * those bytes unchanged, nor that `timestamptz` round-trips the converted
 * value. That meets a real host in wave 4, by design — this issue stands up no
 * Postgres service, because `.github/workflows/` belongs to another programme.
 */

/**
 * The runner's own bookkeeping table.
 *
 * It cannot itself be a tracked migration: the runner has to read this table to
 * know which migrations to run. That chicken-and-egg is resolved by putting the
 * DDL in the one module the law permits SQL in, rather than by giving the
 * runner a `0000` file it must special-case.
 */
const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS _migrations (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`

/** `YYYY-MM`, and nothing else. See {@link buildMonthlyPartitionDdl}. */
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/**
 * The ONE un-parameterised call site in the package (ADR-0043).
 *
 * DDL cannot go through a tagged template, because the things that vary in it —
 * a partition's name, a migration file's whole body — are identifiers and
 * statements, not values, and neither is bindable. Every caller here hands it
 * either a tracked migration file's text or a string this module built itself
 * from a strictly validated input. A second call site is a decision, not a
 * convenience.
 */
function runDdl(sql: SqlLike, text: string): PromiseLike<unknown> {
  return sql.unsafe(text).simple()
}

/**
 * Epoch milliseconds to an ISO-8601 UTC string with millisecond precision.
 *
 * Exported because it is the conversion `ts timestamptz` rests on and it is
 * what a test can actually falsify. `timestamptz` is microsecond-precision, so
 * milliseconds widen losslessly; the byte-fidelity claim ruling 5 makes rests on
 * {@link bindLine}, not on this.
 */
export function toTimestamptz(tsMs: number): string {
  return new Date(tsMs).toISOString()
}

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

/** Postgres hands `timestamptz` back as a `Date`; a recorder or a text mode hands back a string. */
function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string') return new Date(value).getTime()
  return Number.NaN
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
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
  return `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF events FOR VALUES FROM ('${start}') TO ('${end}')`
}

export function createPostgresStorage(sql: SqlLike): TeamStorage {
  return {
    async readSetting(name: string): Promise<string> {
      const rows = await sql<{ setting: string | null }[]>`SELECT current_setting(${name}, true) AS setting`
      return rows[0]?.setting ?? ''
    },

    async ensureMigrationsTable(): Promise<void> {
      await runDdl(sql, MIGRATIONS_TABLE_DDL)
    },

    async listAppliedMigrations(): Promise<AppliedMigration[]> {
      const rows = await sql<{ id: string; checksum: string; applied_at: unknown }[]>`
        SELECT id, checksum, applied_at FROM _migrations ORDER BY id
      `
      return rows.map((row) => ({
        id: row.id,
        checksum: row.checksum,
        appliedAt: new Date(toEpochMs(row.applied_at)).toISOString(),
      }))
    },

    async applyMigration(m: { id: string; checksum: string; sql: string }): Promise<void> {
      await sql.begin(async (tx) => {
        await runDdl(tx, m.sql)
        await tx`INSERT INTO _migrations (id, checksum) VALUES (${m.id}, ${m.checksum})`
      })
    },

    async appendEvents(rows: readonly EventRow[]): Promise<number> {
      if (rows.length === 0) return 0
      await sql.begin(async (tx) => {
        for (const row of rows) {
          await tx`
            INSERT INTO events (project_id, actor_instance, n, event_id, ts, type, source, lane, worktree, payload, line)
            VALUES (
              ${row.projectId},
              ${row.actorInstance},
              ${row.n},
              ${row.eventId},
              ${toTimestamptz(row.tsMs)}::timestamptz,
              ${row.type},
              ${row.source},
              ${row.lane},
              ${row.worktree},
              ${JSON.stringify(row.payload)}::jsonb,
              ${bindLine(row.line)}
            )
          `
        }
      })
      return rows.length
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

    async close(): Promise<void> {
      await sql.end()
    },
  }
}
