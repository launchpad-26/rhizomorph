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

/** The narrow slice of postgres.js the adapter may use. Anything wider is a widening decision. */
export interface SqlLike {
  <T extends readonly unknown[] = readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): PromiseLike<T>
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
