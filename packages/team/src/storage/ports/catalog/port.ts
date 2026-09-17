/**
 * THE CATALOG PORT — what the database ACTUALLY has, not what the DDL says it should (#581).
 *
 * Every other port in this package asks the database about rows this server
 * wrote. This one asks it about **itself**: which roles exist, which tables
 * carry row-level security and whether anything enforces it, and whether the
 * connection may become the viewer role. Reads only — no method here changes
 * anything, and there is deliberately no way to add one that does.
 *
 * ## WHY IT EXISTS, AND WHY NOTHING ELSE IN THE TREE COULD SEE THIS
 *
 * `migrations/schema-law.test.ts` says it in its own docblock: it reads the
 * tracked `.sql`, so it proves a property of the DDL **this package will run**.
 * #514 measured a restored host where that was not the question:
 *
 *     rz_ roles present : (NONE)     policies on events : 0
 *     rls enabled/forced: true/true  migrations recorded: 5
 *
 * Correct files, diverged database. `_migrations` recorded `0003_roles_rls` as
 * applied while every role and policy it creates was absent, so the migration
 * will never re-run to recreate them — and every check an operator would think
 * to run reports healthy. `\d+` says row-level security is on, the boot report
 * says nothing to do, and nothing is restricting anything. A restore is the
 * runbook's own documented recovery path, so this is not an exotic state.
 *
 * #565 closed by deferring exactly this: *"that wants a boot-time check against
 * `pg_policy`/`pg_roles`, which is a different fence."* This is that fence.
 *
 * ## ABSENT AND UNREADABLE ARE DIFFERENT, AND THE DIFFERENCE IS MECHANICAL
 *
 * The falsifier this port was required to answer: can a reader tell *"the role
 * is not there"* from *"this connection cannot see the role catalog"*? It can,
 * and not by inference. Measured on PostgreSQL 18.4:
 *
 *     relname         | relacl
 *     ----------------+---------------------------------------
 *     pg_roles        | {owner=arwdDxtm/owner,=r/owner}
 *     pg_policy       | {owner=arwdDxtm/owner,=r/owner}
 *     pg_class        | {owner=arwdDxtm/owner,=r/owner}
 *     pg_auth_members | {owner=arwdDxtm/owner,=r/owner}
 *
 * The `=r/` entry is a SELECT grant to **PUBLIC** — every catalog these queries
 * read is world-readable by default, and a plain non-superuser holding nothing
 * but CONNECT read all four. So an absent role is *absent*. A deployment that
 * has revoked PUBLIC hits the other arm: the statement **throws**
 * (`permission denied for view pg_roles`, EXECUTED) rather than returning a
 * short list, and a throw is a different observation from a short answer. The
 * caller reports the two under different findings and never conflates them.
 *
 * A third fact belts it: `pg_roles` on any live cluster carries the predefined
 * `pg_*` roles before anything is created, so an **empty** result is not a state
 * a live database has. {@link CatalogPort.listCatalogRoles} therefore returns
 * every role rather than a filtered set — the caller gets a floor it can check,
 * instead of an empty list that could mean either thing.
 */

/**
 * One table with row-level security ENABLED, exactly as `pg_class` and
 * `pg_policy` hold it. Enabled — **not** offending: the verdict is the caller's.
 *
 * That split is deliberate. The law this is the runtime twin of
 * (`migrations/schema-law.test.ts`, #565) is two clauses, and neither subsumes
 * the other; putting them in a `WHERE` here would bury them one layer away from
 * the prose that explains them, and would hand the caller an empty array with no
 * way to tell "nothing is wrong" from "nothing was read".
 */
export interface RlsTable {
  readonly table: string
  /**
   * `relforcerowsecurity` — whether the policies apply to the table OWNER too.
   *
   * It matters because this server connects as the owner. A FORCEd table with no
   * policy is read by nobody at all; an unFORCEd one is still read by the owner,
   * which is why the two are different clauses and not one.
   */
  readonly forced: boolean
  /**
   * Rows in `pg_policy` for this table. The claim a caller may make is
   * *"at least one"*, never *"exactly four"* — a policy count asserted as a
   * number is the rot #514 corrected in the runbook.
   */
  readonly policies: number
  /**
   * Roles granted SELECT that do **not** carry `BYPASSRLS` — the real RLS
   * readers. A grant to PUBLIC appears as the literal `PUBLIC`.
   *
   * **The table's owner is excluded**, and that is what keeps this the same law
   * as the static one. `relacl` carries the owner's implicit arwdDxtm on every
   * table, while `schema-law.test.ts`'s `nonBypassingReaders` only ever reads
   * explicit `GRANT … TO` clauses — which never name an owner. Including it
   * would name every table on the schema and the twin would stop being a twin.
   */
  readonly readers: readonly string[]
}

/**
 * `current_user`, and its relationship to one named role.
 *
 * Three fields rather than one boolean, because "is a member" is not the same
 * question as "can SET ROLE" — see {@link RoleMembership.isSuperuser}.
 */
export interface RoleMembership {
  /** PostgreSQL's `current_user`: the role this connection is acting as. */
  readonly currentUser: string
  /**
   * Whether {@link currentUser} holds membership of the named role.
   *
   * `0006_viewer_role_membership.sql` grants it `WITH INHERIT FALSE`, which
   * still writes a `pg_auth_members` row (`inherit_option = f`) — EXECUTED, so
   * the clause that makes the grant safe does not make it invisible.
   *
   * `false` for a role that does not exist at all. The membership question and
   * the existence question are answered by different checks, and this one does
   * not throw for a missing role: the adapter's `EXISTS` cannot.
   */
  readonly isMember: boolean
  /**
   * WHY THIS IS HERE AND NOT AN IMPLEMENTATION DETAIL.
   *
   * **A superuser may `SET ROLE` to anything, membership or not.** EXECUTED:
   * revoking `rz_viewer` from a superuser owner and then running
   * `SET LOCAL ROLE rz_viewer` still succeeded, while the same statement as a
   * non-superuser non-member gave `permission denied to set role "rz_viewer"`.
   *
   * So a missing membership on a superuser connection is **latent, not live**,
   * which is precisely what `0006`'s own header says it exists to fix:
   * *"This grant removes the app's accidental dependence on BEING a superuser to
   * reach `rz_viewer`, which is what a deployment that later narrows the app's
   * role would otherwise lose silently."* A caller that reported it as broken
   * would be posting a line an operator can disprove in thirty seconds, and then
   * stop trusting the rest.
   */
  readonly isSuperuser: boolean
}

export interface CatalogPort {
  /**
   * Every role name `pg_roles` shows this connection, sorted — **not** a
   * filtered set, for the floor reason in this module's header.
   *
   * Throws when the catalog cannot be read at all, which is the observation that
   * separates *unreadable* from *absent*.
   */
  listCatalogRoles(): Promise<string[]>

  /** Every table with row-level security enabled, sorted by name. The clauses are the caller's. */
  listRlsTables(): Promise<RlsTable[]>

  /** `current_user`'s relationship to `roleName`. The name is bound, never interpolated. */
  readRoleMembership(roleName: string): Promise<RoleMembership>
}
