import postgres from 'postgres'

/**
 * THE DRIVER SEAM (ADR-0043).
 *
 * The only module in `packages/team` that names the `postgres` package. The
 * adapter in `postgres.ts` is typed against {@link SqlLike} — a hand-written
 * slice of postgres.js — rather than against `postgres.Sql`, and that is what
 * makes the adapter testable without a database: a plain object can satisfy
 * `SqlLike`, so `recording-sql.ts` can record exactly which statements the
 * adapter sends and exactly which bytes it binds.
 *
 * Keeping the slice narrow is the point. Anything the adapter needs that is not
 * here is a widening *decision*, visible in a diff to this file, rather than a
 * capability that arrived by autocomplete.
 */

/**
 * What a tagged-template call resolves to: the rows, plus postgres.js's own
 * affected-row count.
 *
 * **THE WIDENING, STATED (prd-51 wave 3).** The slice used to resolve to `T`
 * alone. `count` is admitted because ruling 4's dedup —
 * `ON CONFLICT (project_id, actor_instance, n) DO NOTHING` — makes *"did this
 * row land?"* a question the adapter must answer per row, and the obvious way
 * to ask it is `RETURNING`. `RETURNING` is the wrong answer here, and it would
 * have failed on the first real host rather than in any test: PostgreSQL
 * requires `SELECT` on every column a `RETURNING` list names, and
 * `packages/team/src/migrations/0003_roles_rls.sql` grants `rz_ingest`
 * **INSERT only** on `events`, deliberately and in as many words. The
 * affected-row count carries the same information and needs no grant.
 *
 * It is `T & { count }` rather than a second method because that is what
 * postgres.js already hands back on every result array. Naming it here makes it
 * visible in a diff to this file, which is what this module's contract above
 * says a widening must be.
 */
export type SqlResult<T> = T & { readonly count: number }

/** The narrow slice of postgres.js the adapter may use. Anything wider is a widening decision. */
export interface SqlLike {
  <T extends readonly unknown[] = readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromiseLike<SqlResult<T>>
  /**
   * The ONLY un-parameterised path, and the reason ADR-0043 chose a driver
   * whose unsafe path is *named* unsafe. Reserved for DDL, which cannot go
   * through a tagged template because its identifiers are not bindable.
   */
  unsafe(text: string): { simple(): PromiseLike<unknown> }
  begin<T>(fn: (tx: SqlLike) => Promise<T>): Promise<T>
  end(): Promise<void>
}

/**
 * Opens a real connection. The one call site of `postgres()` in the package.
 *
 * The cast is the seam: postgres.js's `Sql` is structurally wider than
 * `SqlLike` in ways TypeScript cannot narrow through (its tagged-template
 * overloads carry the driver's own row typing), so the narrowing is asserted
 * here, once, in the module whose whole job is to touch the driver.
 */
export function openSql(databaseUrl: string): SqlLike {
  return postgres(databaseUrl) as unknown as SqlLike
}
