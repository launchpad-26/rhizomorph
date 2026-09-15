import type { SqlLike } from './driver.js'

/**
 * THE ONE UN-PARAMETERISED CALL SITE MECHANISM (ADR-0043).
 *
 * This module is the package's only `.unsafe(` call site, and
 * `no-sql-outside-storage-law.test.ts` names it by path: clause 3 exempts this
 * file and nothing else, so a port's SQL module may not reach the escape hatch
 * on its own.
 *
 * It carries no SQL statement of its own, and must not — it is a *mechanism*,
 * so clause 4 (the SQL-literal sweep) still applies to it in full.
 */

/**
 * The ONE un-parameterised call site in the package (ADR-0043).
 *
 * DDL cannot go through a tagged template, because the things that vary in it —
 * a partition's name, a migration file's whole body — are identifiers and
 * statements, not values, and neither is bindable. Every caller here hands it
 * either a tracked migration file's text or a string a SQL module built itself
 * from a strictly validated input. A second call site is a decision, not a
 * convenience.
 */
export function runDdl(sql: SqlLike, text: string): PromiseLike<unknown> {
  return sql.unsafe(text).simple()
}
