import postgres from 'postgres'

/**
 * THE DRIVER SEAM (ADR-0043).
 *
 * The only module in `packages/team` that names the `postgres` package. The
 * adapters under `ports/<port>/sql.ts` are typed against {@link SqlLike} — a
 * hand-written slice of postgres.js — rather than against `postgres.Sql`, and
 * that is what makes them testable without a database: a plain object can
 * satisfy `SqlLike`, so `recording-sql.ts` can record exactly which statements
 * an adapter sends and exactly which bytes it binds.
 *
 * Keeping the slice narrow is the point. Anything an adapter needs that is not
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
   * through a tagged template because its identifiers are not bindable. The
   * package's one call site is `ddl.ts`, and the law names it by path.
   */
  unsafe(text: string): { simple(): PromiseLike<unknown> }
  begin<T>(fn: (tx: SqlLike) => Promise<T>): Promise<T>
  end(): Promise<void>
}

/**
 * THE NOTICE FILTER (#551).
 *
 * postgres.js's own default handler is console.log(parseError(x)) — the raw wire
 * fields as one object — for every NOTICE the server sends, unconditionally. The
 * migrations this package runs on every boot legitimately raise about a dozen of
 * these (a DROP POLICY IF EXISTS in the roles/RLS migration, a CREATE TABLE IF
 * NOT EXISTS in the partition top-up), and each one costs eight lines by
 * default — enough to bury the boot report's own lines under a hundred lines of
 * expected noise (measured on a real first boot, #551).
 *
 * The two severities Postgres's NoticeResponse can carry that matter here split
 * on one field: severity — never severity_local, which the server may localize
 * (a French server sends AVIS, not NOTICE, for the same condition) and so cannot
 * be gated on without breaking on a non-English host.
 *
 * A NOTICE condenses to one line; nothing above it is touched. This is
 * deliberately NOT keyed on the notice's code — Postgres's generic
 * "successful completion" code is the one both DDL shapes above carry, and it is
 * also the code plenty of other, not-necessarily-expected NOTICEs carry. A
 * driver that cannot tell those apart must not drop either — so this never drops
 * a message, it only ever shortens one. Anything that is not a plain NOTICE — a
 * WARNING, or a notice with no severity field at all — is shown in full, exactly
 * as the default handler would have, because an unclassifiable notice is the
 * case this filter must fail open on, not closed.
 */
export function reportNotice(notice: postgres.Notice): void {
  if (notice.severity === 'NOTICE') {
    console.log(`notice: ${notice.message ?? '(no message)'}`)
    return
  }
  console.warn(notice)
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
  return postgres(databaseUrl, { onnotice: reportNotice }) as unknown as SqlLike
}
