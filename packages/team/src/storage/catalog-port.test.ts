import { describe, expect, it } from 'vitest'
import { FakeTeamStorage } from './fake.js'
import { FAKE_CATALOG_OWNER, HEALTHY_RLS_TABLES, createCatalogFake } from './ports/catalog/fake.js'
import { createCatalogSql } from './ports/catalog/sql.js'
import { createRecordingSql } from './recording-sql.js'

/**
 * THE CATALOG PORT, FROM BOTH SIDES (#581).
 *
 * Here rather than under `ports/catalog/` for the reason `retention-port.test.ts`
 * gives: `composition-law.test.ts` case 1 pins every port directory to exactly
 * `fake.ts`, `port.ts` and `sql.ts`, so a port's tests have no home inside it by
 * construction.
 *
 * Two layers, and the split is `recording-sql.ts`'s own: the **adapter** is
 * asserted on what it SENDS and what it BINDS, the **fake** on what it returns.
 * Nothing here needs a database — but every shape it asserts was measured
 * against one, on PostgreSQL 18.4 with all seven tracked migrations applied.
 */

describe('the catalog adapter reads the catalogs it claims to, and binds what varies', () => {
  it('listCatalogRoles sends one ordered read of pg_roles and filters nothing', async () => {
    const recorder = createRecordingSql()
    recorder.script([{ rolname: 'pg_monitor' }, { rolname: 'rz_ingest' }])

    const roles = await createCatalogSql(recorder.sql).listCatalogRoles()

    expect(recorder.queries.length).toBe(1)
    expect(recorder.queries[0]?.sql).toContain('FROM pg_roles')
    expect(recorder.queries[0]?.sql).toContain('ORDER BY rolname')
    /**
     * NO `rz_` FILTER, AND THE ABSENCE IS THE ASSERTION.
     *
     * A `WHERE rolname LIKE 'rz\\_%'` returns an empty set both when the roles
     * are missing and when the catalog is readable-but-empty, and the caller
     * would have no floor to tell those apart. `pg_roles` on any live cluster
     * carries the predefined `pg_*` roles, so an unfiltered read is itself
     * evidence the read happened.
     */
    expect(recorder.queries[0]?.sql).not.toContain('rz_')
    expect(recorder.queries[0]?.sql).not.toContain('WHERE')
    expect(roles).toEqual(['pg_monitor', 'rz_ingest'])
  })

  it('listRlsTables reads pg_class and pg_policy, excludes the owner, and ignores BYPASSRLS readers', async () => {
    const recorder = createRecordingSql()
    recorder.script([])

    await createCatalogSql(recorder.sql).listRlsTables()
    const sent = recorder.queries[0]?.sql ?? ''

    expect(recorder.queries.length).toBe(1)
    expect(sent).toContain('FROM pg_policy p WHERE p.polrelid = c.oid')
    expect(sent).toContain('c.relforcerowsecurity')
    expect(sent).toContain('WHERE c.relrowsecurity')
    /**
     * THE THREE CLAUSES MEASURED AS LOAD-BEARING, each asserted on its own.
     *
     * - without `a.grantee <> c.relowner` the owner's implicit arwdDxtm names
     *   it a reader of all six tables and clause B fires on the healthy schema;
     * - without `NOT g.rolbypassrls`, `rz_ingest` is a reader of the projections
     *   though it bypasses RLS entirely;
     * - without the `grantee = 0` case a `GRANT SELECT … TO PUBLIC` vanishes,
     *   and that grant reaches every non-bypassing role at once.
     */
    expect(sent).toContain('a.grantee <> c.relowner')
    expect(sent).toContain('NOT g.rolbypassrls')
    expect(sent).toContain("CASE WHEN a.grantee = 0 THEN 'PUBLIC'")
    // Ordinary and partitioned tables. A partition does NOT inherit
    // `relrowsecurity` — measured — so the fifteen a live host carries are never
    // candidates, and `relkind` is what keeps indexes out.
    expect(sent).toContain("c.relkind IN ('r', 'p')")
  })

  it('listRlsTables coerces a text count and a null aggregate into a number and an empty list', async () => {
    const recorder = createRecordingSql()
    // postgres.js hands `count(*)` back as TEXT on the wire, and a row whose
    // aggregate filtered everything out carries `null` rather than `{}`. Both are
    // what a real driver produces, and both are what a naive `Number(row.x)`
    // on the caller's side would get wrong one layer too late.
    recorder.script([
      { table_name: 'events', forced: true, policies: '1', readers: ['rz_viewer'] },
      { table_name: 'ingest_keys', forced: false, policies: '0', readers: null },
    ])

    const rows = await createCatalogSql(recorder.sql).listRlsTables()

    expect(rows).toEqual([
      { table: 'events', forced: true, policies: 1, readers: ['rz_viewer'] },
      { table: 'ingest_keys', forced: false, policies: 0, readers: [] },
    ])
    expect(typeof rows[0]?.policies).toBe('number')
  })

  /**
   * THE INJECTION ASSERTION. A role name is a VALUE here, not an identifier, so
   * nothing about this statement's text may vary with its argument — and the
   * `not.toContain` is the half that fails if someone "simplifies" the query by
   * interpolating the name into it.
   */
  it('readRoleMembership binds the role name and never puts it in the statement text', async () => {
    const recorder = createRecordingSql()
    recorder.script([{ current_user_name: 'rzowner', is_member: true, is_superuser: false }])

    const membership = await createCatalogSql(recorder.sql).readRoleMembership('rz_viewer')
    const sent = recorder.queries[0]?.sql ?? ''

    expect(sent).toContain('FROM pg_auth_members am')
    expect(sent).toContain('current_user')
    expect(sent).not.toContain('rz_viewer')
    expect(recorder.queries[0]?.values).toEqual(['rz_viewer'])
    expect(membership).toEqual({ currentUser: 'rzowner', isMember: true, isSuperuser: false })
  })

  /**
   * `rolsuper` RIDES ALONG BECAUSE THE TWO FACTS ARE ONLY MEANINGFUL TOGETHER.
   * A superuser may SET ROLE to anything whatever its memberships — EXECUTED —
   * so a caller reading "not a member" without it reports a live failure that is
   * only latent. One round trip, so the two cannot be read at different instants.
   */
  it('reports superuser beside membership, in the same statement', async () => {
    const recorder = createRecordingSql()
    recorder.script([{ current_user_name: 'rzowner', is_member: false, is_superuser: true }])

    const membership = await createCatalogSql(recorder.sql).readRoleMembership('rz_viewer')

    expect(recorder.queries.length).toBe(1)
    expect(recorder.queries[0]?.sql).toContain('rolsuper')
    expect(membership).toEqual({ currentUser: 'rzowner', isMember: false, isSuperuser: true })
  })

  it('a driver that returns no row at all yields a refusal-shaped value, not a crash', async () => {
    const recorder = createRecordingSql()
    recorder.script([])

    // `SELECT current_user …` always returns exactly one row against a real
    // server. A driver stub or a cancelled statement may not, and the adapter
    // must not throw a TypeError past the doctor's own catch, where it would be
    // reported as an unreadable catalog it is not.
    expect(await createCatalogSql(recorder.sql).readRoleMembership('rz_viewer')).toEqual({
      currentUser: '',
      isMember: false,
      isSuperuser: false,
    })
  })

  it('no method sends a second statement, so a doctor run is three round trips and not six', async () => {
    const recorder = createRecordingSql()
    const port = createCatalogSql(recorder.sql)
    recorder.script([])
    await port.listCatalogRoles()
    recorder.script([])
    await port.listRlsTables()
    recorder.script([{ current_user_name: 'rzowner', is_member: true, is_superuser: true }])
    await port.readRoleMembership('rz_viewer')

    expect(recorder.queries).toHaveLength(3)
    expect(recorder.log.filter((entry) => entry === 'BEGIN')).toHaveLength(0)
  })
})

describe('the catalog double is not kinder than the adapter', () => {
  it('defaults to the six RLS tables a database with every migration applied actually has', async () => {
    const storage = new FakeTeamStorage()

    const tables = await storage.listRlsTables()

    /**
     * THE MEASUREMENT THAT BROKE THE OBVIOUS CHECK.
     *
     * `ingest_keys` and `retention_ceilings` enable row level security and carry
     * ZERO policies on a HEALTHY schema — deliberately: enabled-and-unFORCEd
     * with no policy is a deny-all declaration for anyone who is neither the
     * owner nor BYPASSRLS. `schema-law.test.ts` found the same thing statically
     * and narrowed its law rather than exempt two tables by name. A double that
     * shipped only the four policied tables would let every check above it pass
     * against a schema this deployment does not have.
     */
    expect(tables.map((t) => t.table)).toEqual([
      'collisions',
      'events',
      'ingest_keys',
      'lane_state',
      'retention_ceilings',
      'spend_by_project_day',
    ])
    expect(tables.filter((t) => t.policies === 0).map((t) => t.table)).toEqual([
      'ingest_keys',
      'retention_ceilings',
    ])
    expect(tables.filter((t) => t.forced).every((t) => t.policies > 0)).toBe(true)
  })

  it('defaults pg_roles to more than the rz_ set, so an empty catalog is a distinguishable state', async () => {
    const roles = await new FakeTeamStorage().listCatalogRoles()

    expect(roles).toContain('rz_viewer')
    expect(roles.filter((r) => r.startsWith('pg_')).length).toBeGreaterThan(0)
    expect(await new FakeTeamStorage({ catalogRoles: [] }).listCatalogRoles()).toEqual([])
  })

  /**
   * THE ADAPTER'S `EXISTS (…)` IS FALSE FOR A ROLE THAT DOES NOT EXIST — it
   * cannot throw for one. A double that threw would invent a failure mode the
   * real statement has no way to produce, and would let a caller ship a branch
   * that is unreachable in production.
   */
  it('readRoleMembership on a role nobody holds returns false rather than throwing', async () => {
    const storage = new FakeTeamStorage()

    expect(await storage.readRoleMembership('rz_nope')).toEqual({
      currentUser: FAKE_CATALOG_OWNER,
      isMember: false,
      isSuperuser: true,
    })
    expect(await storage.readRoleMembership('rz_viewer')).toMatchObject({ isMember: true })
    expect(storage.membershipLookups).toEqual(['rz_nope', 'rz_viewer'])
  })

  /**
   * AN UNREADABLE CATALOG IS UNREADABLE FOR ALL THREE. EXECUTED: revoking
   * PUBLIC's SELECT on `pg_roles` and `pg_policy` makes both reads error
   * (`permission denied for view pg_roles`), so a double that failed only the
   * first would let the other two report a healthy database behind it.
   */
  it('catalogThrows fails every read, not only the first', async () => {
    const calls: string[] = []
    const fake = createCatalogFake(calls, { catalogThrows: 'permission denied for view pg_roles' })

    await expect(fake.listCatalogRoles()).rejects.toThrow('permission denied for view pg_roles')
    await expect(fake.listRlsTables()).rejects.toThrow('permission denied for view pg_roles')
    await expect(fake.readRoleMembership('rz_viewer')).rejects.toThrow('permission denied for view pg_roles')
    expect(calls).toEqual(['listCatalogRoles', 'listRlsTables', 'readRoleMembership'])
  })

  /**
   * REPETITION. The adapter builds fresh objects out of driver rows every call;
   * a double handing back its own seed would let a caller mutate the "database"
   * by accident, and a single-shot test would never see it.
   */
  it('three reads return equal values and hand back copies, not the seed', async () => {
    const storage = new FakeTeamStorage()

    const first = await storage.listRlsTables()
    const second = await storage.listRlsTables()
    ;(first[0]?.readers as string[]).push('mutated')

    const third = await storage.listRlsTables()

    expect(second).toEqual(third)
    expect(third[0]?.readers).not.toContain('mutated')
    expect(storage.calls.filter((c) => c === 'listRlsTables')).toHaveLength(3)
    expect(HEALTHY_RLS_TABLES[0]?.readers).not.toContain('mutated')
  })

  it('a role that disappears between two reads is visible to the second', async () => {
    const storage = new FakeTeamStorage()

    expect(await storage.listCatalogRoles()).toContain('rz_ingest')
    storage.catalogRoles.splice(storage.catalogRoles.indexOf('rz_ingest'), 1)

    expect(await storage.listCatalogRoles()).not.toContain('rz_ingest')
  })
})
