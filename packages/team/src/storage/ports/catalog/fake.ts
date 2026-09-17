import type { CatalogPort, RlsTable, RoleMembership } from './port.js'

/**
 * The predefined roles PostgreSQL 18.4 creates before anything else exists,
 * verbatim from a freshly `initdb`'d cluster.
 *
 * Here so the fake's default role list is what a real `pg_roles` looks like
 * rather than the three names the checks above it care about. A default of
 * `['rz_ingest', 'rz_readonly', 'rz_viewer']` would make the caller's
 * "the catalog came back empty" floor untestable against a realistic baseline —
 * the only way to produce a short-but-non-empty list would be to write one by
 * hand in every case that needs one.
 */
const PREDEFINED_ROLES: readonly string[] = [
  'pg_checkpoint',
  'pg_create_subscription',
  'pg_database_owner',
  'pg_execute_server_program',
  'pg_maintain',
  'pg_monitor',
  'pg_read_all_data',
  'pg_read_all_settings',
  'pg_read_all_stats',
  'pg_read_server_files',
  'pg_signal_autovacuum_worker',
  'pg_signal_backend',
  'pg_stat_scan_tables',
  'pg_use_reserved_connections',
  'pg_write_all_data',
  'pg_write_server_files',
]

/** The owner this deployment connects as, in the fake's default world. */
export const FAKE_CATALOG_OWNER = 'rzowner'

/**
 * The six RLS-enabled tables a database with every tracked migration applied
 * actually has — **measured**, not composed.
 *
 * `ingest_keys` and `retention_ceilings` carry zero policies on a HEALTHY
 * schema, and that is the single most important fact in this file. RLS enabled
 * and not FORCEd with no policy is a deny-all declaration for anyone who is
 * neither the owner nor `BYPASSRLS`; `schema-law.test.ts` found the same thing
 * statically and narrowed its law rather than exempt the two tables by name. A
 * double that shipped only the four policied tables would let every check above
 * it pass against a schema this deployment does not have.
 */
export const HEALTHY_RLS_TABLES: readonly RlsTable[] = [
  { table: 'collisions', forced: true, policies: 1, readers: ['rz_readonly', 'rz_viewer'] },
  { table: 'events', forced: true, policies: 1, readers: ['rz_readonly', 'rz_viewer'] },
  { table: 'ingest_keys', forced: false, policies: 0, readers: [] },
  { table: 'lane_state', forced: true, policies: 1, readers: ['rz_readonly', 'rz_viewer'] },
  { table: 'retention_ceilings', forced: false, policies: 0, readers: [] },
  { table: 'spend_by_project_day', forced: true, policies: 1, readers: ['rz_readonly', 'rz_viewer'] },
]

export interface CatalogFakeOptions {
  /** Every role `pg_roles` holds. Defaults to the predefined set plus the three `rz_` roles. */
  readonly catalogRoles?: readonly string[]
  /** Defaults to {@link HEALTHY_RLS_TABLES}. */
  readonly rlsTables?: readonly RlsTable[]
  /** Role name to its members. Defaults to `rz_viewer` holding {@link FAKE_CATALOG_OWNER}. */
  readonly roleMembers?: Readonly<Record<string, readonly string[]>>
  readonly currentUser?: string
  /** A superuser may SET ROLE regardless of membership; defaults to the compose deployment's `true`. */
  readonly currentUserIsSuperuser?: boolean
  /**
   * The catalog cannot be read at all — a deployment that revoked PUBLIC's
   * SELECT on `pg_roles`. **The adapter throws in that state** (EXECUTED:
   * `permission denied for view pg_roles`), it does not return a short list, so
   * this double throws too. A double that returned `[]` instead would let a
   * caller pass a test claiming it can tell absent from unreadable while
   * conflating exactly those two.
   */
  readonly catalogThrows?: string
}

export interface CatalogFake extends CatalogPort {
  /** `pg_roles`, mutable so one fake can answer differently across two calls. */
  readonly catalogRoles: string[]
  /** The RLS-enabled tables this database has. */
  readonly rlsTables: RlsTable[]
  /** Every role name {@link CatalogPort.readRoleMembership} was asked about, in order. */
  readonly membershipLookups: string[]
}

/**
 * THE CATALOG DOUBLE, AND IT IS NOT KINDER THAN THE ADAPTER.
 *
 * - **`readRoleMembership` on an unknown role returns `isMember: false` and does
 *   not throw.** The adapter's `EXISTS (…)` is false for a role that does not
 *   exist, so a throwing double would invent a failure mode the real statement
 *   cannot produce — and would let a caller ship an unreachable branch.
 * - **Every read returns a fresh copy.** The adapter builds new objects out of
 *   driver rows on every call; a double handing back its own seed would let a
 *   caller mutate the "database" by accident and a repetition test would pass
 *   for the wrong reason.
 * - **{@link CatalogFakeOptions.catalogThrows} throws from all three methods.**
 *   An unreadable `pg_roles` is an unreadable catalog; a double that failed only
 *   the first would let the other two report a healthy database behind it.
 */
export function createCatalogFake(calls: string[], options: CatalogFakeOptions): CatalogFake {
  const catalogRoles = [...(options.catalogRoles ?? [...PREDEFINED_ROLES, FAKE_CATALOG_OWNER, 'rz_ingest', 'rz_readonly', 'rz_viewer'])]
  const rlsTables = [...(options.rlsTables ?? HEALTHY_RLS_TABLES)]
  const membershipLookups: string[] = []
  const currentUser = options.currentUser ?? FAKE_CATALOG_OWNER
  const roleMembers = options.roleMembers ?? { rz_viewer: [currentUser] }

  function refuse(): never {
    throw new Error(options.catalogThrows as string)
  }

  return {
    catalogRoles,
    rlsTables,
    membershipLookups,

    async listCatalogRoles(): Promise<string[]> {
      calls.push('listCatalogRoles')
      if (options.catalogThrows !== undefined) refuse()
      return [...catalogRoles].sort()
    },

    async listRlsTables(): Promise<RlsTable[]> {
      calls.push('listRlsTables')
      if (options.catalogThrows !== undefined) refuse()
      return rlsTables
        .map((row) => ({ ...row, readers: [...row.readers] }))
        .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
    },

    async readRoleMembership(roleName: string): Promise<RoleMembership> {
      calls.push('readRoleMembership')
      membershipLookups.push(roleName)
      if (options.catalogThrows !== undefined) refuse()
      return {
        currentUser,
        isMember: (roleMembers[roleName] ?? []).includes(currentUser),
        isSuperuser: options.currentUserIsSuperuser ?? true,
      }
    },
  }
}
