import type { SqlLike } from '../../driver.js'
import type { CatalogPort, RlsTable, RoleMembership } from './port.js'

/**
 * THE CATALOG ADAPTER — three read statements against `pg_catalog`, and nothing else.
 *
 * Every statement here is a plain tagged template with at most one bound
 * parameter and **no interpolated identifier**, so `ddl.ts`'s un-parameterised
 * escape hatch is not reached and clause 3 of
 * `no-sql-outside-storage-law.test.ts` stays exactly where `#509` narrowed it to.
 *
 * ## WHY THESE CATALOGS AND NOT `information_schema`
 *
 * `information_schema` has no view of row-level security at all — neither
 * `relrowsecurity`, nor `relforcerowsecurity`, nor policies. The same reason
 * `ports/retention/sql.ts` reads `pg_inherits` for partitions: the standard views
 * do not model what PostgreSQL actually stores here.
 *
 * ## THE PIECES OF `listRlsTables` THAT LOOK OPTIONAL AND ARE NOT
 *
 * - **`a.grantee <> c.relowner`.** `relacl` carries the owner's implicit
 *   arwdDxtm on every table. Without this the readers column names the owner
 *   on all six tables and clause B fires on the healthy schema — measured.
 * - **`NOT g.rolbypassrls`.** `rz_ingest` holds SELECT on the projection tables
 *   and bypasses RLS, so it is not a reader whose grant could read nothing.
 * - **`a.grantee = 0` is PUBLIC.** Oid 0 joins to no row in `pg_roles`, so a
 *   `GRANT SELECT … TO PUBLIC` would vanish without the `CASE`, and that grant
 *   reaches every non-bypassing role at once — the widest possible version of
 *   the state clause B exists to catch.
 * - **`relkind IN ('r','p')`.** Ordinary and partitioned tables. Measured: a
 *   partition does **not** inherit `relrowsecurity` from its parent — every
 *   `events_YYYY_MM` reads `f` — so the fifteen partitions a live host carries
 *   are never candidates and need no filter of their own.
 */

/**
 * `count(*)` arrives as a string on a text-mode driver and as a number on a
 * recorder. Local rather than in `coerce.ts`: it is one expression and no other
 * port reads a count out of a row.
 */
function toCount(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number.parseInt(value, 10)
  return Number.NaN
}

/** `text[]` arrives as an array; a null aggregate and an absent column both mean "none". */
function toNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((name) => String(name))
}

export function createCatalogSql(sql: SqlLike): CatalogPort {
  return {
    /**
     * Every role in the cluster, sorted.
     *
     * Deliberately unfiltered. A `WHERE rolname LIKE 'rz\_%'` would return an
     * empty set both when the roles are missing and when the catalog is
     * unreadable-but-not-erroring, and the caller would have no floor to check
     * against. The predefined `pg_*` roles exist on every live cluster, so a
     * non-empty result is itself evidence the read happened.
     */
    async listCatalogRoles(): Promise<string[]> {
      const rows = await sql<{ rolname: string }[]>`
        SELECT rolname FROM pg_roles ORDER BY rolname
      `
      return rows.map((row) => String(row.rolname))
    },

    async listRlsTables(): Promise<RlsTable[]> {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT c.relname AS table_name,
               c.relforcerowsecurity AS forced,
               (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
               COALESCE(
                 array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g.rolname END)
                   FILTER (WHERE a.grantee = 0 OR g.oid IS NOT NULL),
                 '{}'
               ) AS readers
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN LATERAL aclexplode(c.relacl) a
          ON a.privilege_type = 'SELECT' AND a.grantee <> c.relowner
        LEFT JOIN pg_roles g ON g.oid = a.grantee AND NOT g.rolbypassrls
        WHERE c.relrowsecurity
          AND c.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        GROUP BY c.oid, c.relname, c.relforcerowsecurity
        ORDER BY c.relname
      `
      return rows.map((row) => ({
        table: String(row.table_name),
        forced: row.forced === true,
        policies: toCount(row.policies),
        readers: toNames(row.readers),
      }))
    },

    /**
     * `pg_auth_members` by NAME on both sides, and the role name is a bound
     * parameter — a role name is a value here, not an identifier, so nothing
     * about this statement's text varies with its argument.
     *
     * `rolsuper` rides along because a superuser may `SET ROLE` to anything
     * whatever its memberships; see {@link RoleMembership.isSuperuser}. One
     * round trip rather than two, because the two facts are only meaningful
     * together and a caller that read them apart could report a contradiction
     * that never existed at a single instant.
     */
    async readRoleMembership(roleName: string): Promise<RoleMembership> {
      const rows = await sql<Record<string, unknown>[]>`
        SELECT current_user AS current_user_name,
               (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
               EXISTS (
                 SELECT 1
                 FROM pg_auth_members am
                 JOIN pg_roles r ON r.oid = am.roleid
                 JOIN pg_roles m ON m.oid = am.member
                 WHERE r.rolname = ${roleName} AND m.rolname = current_user
               ) AS is_member
      `
      const row = rows[0] ?? {}
      return {
        currentUser: typeof row.current_user_name === 'string' ? row.current_user_name : '',
        isMember: row.is_member === true,
        isSuperuser: row.is_superuser === true,
      }
    },
  }
}
