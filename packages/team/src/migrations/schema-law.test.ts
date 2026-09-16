import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE SCHEMA LAW — reading the migrations back (prd-51 ruling 5).
 *
 * This issue stands up no Postgres, by design: the ingest lane meets a real
 * host in wave 4, and adding a database service to CI is a workflow change that
 * belongs to another programme. So the schema is verified the only honest way
 * left — by reading the tracked `.sql` files and asserting what they say.
 *
 * That is a weaker claim than "the database behaves this way", and the file
 * says so rather than implying more: it proves the DDL this package will run is
 * the DDL ruling 5 specifies. What it cannot prove — that partition pruning
 * works, that BRIN behaves, that RLS actually refuses a cross-project read — is
 * wave 4's, on the real host.
 *
 * ## Comments are stripped first, and that is load-bearing
 *
 * `0001_events.sql`'s header comment records the ruling 4 / ruling 5 collision
 * verbatim, including the phrases `ON CONFLICT`, `PRIMARY KEY` and
 * `CREATE INDEX CONCURRENTLY` — as the things this schema deliberately does NOT
 * do. A law that swept the raw text would convict the file for explaining
 * itself, and the next author would resolve that by deleting the explanation.
 * So the forbidden-pattern clauses run on comment-stripped SQL, and only the
 * citation clause reads the raw text.
 *
 * Cited: `docs/research/2026-08-28-shared-record-s4-schema.md` — the spike that
 * measured `pages_per_range = 32` and found the planner never chose an
 * index-only scan over the covering expression index.
 */

const MIGRATIONS_DIR = path.dirname(fileURLToPath(import.meta.url))
/**
 * Where the events port declares its interface.
 *
 * Was `storage/contract.ts` until #509 split `TeamStorage` into one file per
 * port; `contract.ts` is now the intersection and the re-export surface and
 * declares no methods of its own. The assertion below is unchanged — the same
 * signature, at the file that now declares it.
 */
const EVENTS_PORT_PATH = path.join(MIGRATIONS_DIR, '..', 'storage', 'ports', 'events', 'port.ts')

const RULING_5_COLUMNS = [
  'project_id',
  'actor_instance',
  'n',
  'event_id',
  'ts',
  'type',
  'source',
  'lane',
  'worktree',
  'payload',
  'line',
]

/** Every tracked migration, LF-normalised, in ordinal order. */
function migrations(): { id: string; raw: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({
      id: f.slice(0, -'.sql'.length),
      raw: readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').replace(/\r\n/g, '\n'),
    }))
}

/** `-- …` to end of line, removed. These files contain no `--` inside a string literal. */
export function stripSqlComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const at = line.indexOf('--')
      return at === -1 ? line : line.slice(0, at)
    })
    .join('\n')
}

function sqlOf(id: string): string {
  const found = migrations().find((m) => m.id === id)
  if (!found) throw new Error(`no migration ${id}`)
  return stripSqlComments(found.raw)
}

function rawOf(id: string): string {
  const found = migrations().find((m) => m.id === id)
  if (!found) throw new Error(`no migration ${id}`)
  return found.raw
}

function allStripped(): string {
  return migrations()
    .map((m) => stripSqlComments(m.raw))
    .join('\n')
}

/**
 * `ALTER TABLE [ONLY] [schema.]["]name["]` — the spellings PostgreSQL accepts for one table.
 *
 * Written out because the first version matched `(\w+)` alone and so FAILED OPEN on all three:
 * `ALTER TABLE ONLY events …`, `ALTER TABLE public.events …` and `ALTER TABLE "events" …` each
 * parsed as NO table at all, which silently exempts it from both clauses below. A guard that
 * stops seeing a table is worse here than one that is noisy about it, because the state it stops
 * seeing is the one #514 measured.
 */
const TABLE_REF = '(?:ONLY\\s+)?(?:"?\\w+"?\\s*\\.\\s*)?"?(\\w+)"?'

/** The bare table name from a reference the patterns above capture. */
function tableNamesIn(sql: string, verb: string): string[] {
  const pattern = new RegExp(`ALTER\\s+TABLE\\s+${TABLE_REF}\\s+${verb}\\s+ROW\\s+LEVEL\\s+SECURITY`, 'gi')
  return [...sql.matchAll(pattern)].map((m) => m[1] as string)
}

/** Tables the schema turns RLS ON for, in declaration order. */
function rlsEnabledTables(sql: string): string[] {
  return tableNamesIn(sql, 'ENABLE')
}

/** Tables the schema FORCEs RLS on — the set that puts the owner inside the policies too. */
function forcedTables(sql: string): Set<string> {
  return new Set(tableNamesIn(sql, 'FORCE'))
}

/**
 * Tables carrying at least one policy **that can admit a read**. Never a COUNT — see case 23.
 *
 * The command matters, and the first version of this did not check it. A policy is scoped by its
 * `FOR` clause, so `FOR INSERT` admits no SELECT at all: a table with RLS on and nothing but an
 * insert policy is exactly as unreadable as one with no policy, while "does it have a policy?"
 * answers yes. Both clauses below rest on this set, so that spelling silenced both of them.
 * PostgreSQL defaults an omitted `FOR` to `ALL`, which does admit a read.
 */
function policiedTables(sql: string): Set<string> {
  const admits = new Map<string, Set<string>>()
  const created = new RegExp(`CREATE\\s+POLICY\\s+(\\w+)\\s+ON\\s+${TABLE_REF}([^;]*);`, 'gi')
  for (const m of sql.matchAll(created)) {
    const command = /\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(m[3] as string)
    // No FOR clause at all means ALL, which admits a read.
    if (command === null || /^(ALL|SELECT)$/i.test(command[1] as string)) {
      const table = m[2] as string
      if (!admits.has(table)) admits.set(table, new Set())
      admits.get(table)?.add(m[1] as string)
    }
  }

  /**
   * A DROP RETRACTS ITS CREATE (review of #574).
   *
   * This read `CREATE POLICY` alone, so appending `DROP POLICY events_by_project ON events;` to
   * the schema left the law GREEN on **precisely the state #514 measured** — RLS enabled and
   * forced, zero policies. `0003_roles_rls.sql:73` already uses the `DROP POLICY IF EXISTS`
   * idiom, so the statement form is in this corpus today and a future migration that drops
   * without recreating plants that state where nothing sees it.
   *
   * Dropped by NAME, not by table: `0003`'s own `DROP POLICY IF EXISTS … ; CREATE POLICY … ;`
   * pairs must not read as a table with no policy, and they do not — the create that follows
   * re-adds the name.
   */
  const dropped = new RegExp(`DROP\\s+POLICY\\s+(?:IF\\s+EXISTS\\s+)?(\\w+)\\s+ON\\s+${TABLE_REF}`, 'gi')
  for (const m of sql.matchAll(dropped)) {
    const names = admits.get(m[2] as string)
    if (names === undefined) continue
    // A drop AFTER the last create of that name retracts it; a drop before it does not.
    const lastCreate = sql.toLowerCase().lastIndexOf(`create policy ${(m[1] as string).toLowerCase()}`)
    if ((m.index ?? 0) > lastCreate) names.delete(m[1] as string)
  }

  return new Set([...admits.entries()].filter(([, names]) => names.size > 0).map(([table]) => table))
}

/**
 * THE TWO CLAUSES, AS FUNCTIONS — and they are functions for a measured reason.
 *
 * The first version computed both offender lists inline in their `it(...)` blocks and gave the
 * "mutation" cases below rigged strings to assert PARSER facts against. That left the law itself
 * downstream of nothing: EXECUTED on this file at `1e655b9b`, replacing `rlsEnabledTables`' body
 * with `return []` kept all 43 cases GREEN, and so did gutting either clause's own filter. The
 * non-vacuity guards were real but sat on the wrong side of the computation — they floored
 * `forcedTables`, `policiedTables` and the reader map, none of which is the input the offender
 * list is built from.
 *
 * Routing both the law cases and the mutation cases through these two functions is what makes
 * the mutation cases mutations of the LAW rather than of its parsers.
 */

/** Clause A: FORCEd, and no policy that can admit a read. Nobody reads it, the owner included. */
function forcedWithoutPolicy(sql: string): string[] {
  const policied = policiedTables(sql)
  const forced = forcedTables(sql)
  return rlsEnabledTables(sql).filter((table) => forced.has(table) && !policied.has(table))
}

/** Clause B: RLS on, a non-bypassing role may SELECT it, and no policy admits anyone. */
function readableWithoutPolicy(sql: string): string[] {
  const policied = policiedTables(sql)
  const readers = nonBypassingReaders(sql)
  return rlsEnabledTables(sql).filter((table) => (readers.get(table)?.length ?? 0) > 0 && !policied.has(table))
}

/** Per table, the roles granted SELECT that do NOT carry BYPASSRLS — i.e. real RLS readers. */
function nonBypassingReaders(sql: string): Map<string, string[]> {
  const bypassing = new Set(
    createdRoles(sql)
      .filter((r) => r.bypassRls)
      .map((r) => r.name),
  )
  const readers = new Map<string, string[]>()
  for (const grant of grants(sql)) {
    if (!grant.privileges.includes('SELECT')) continue
    for (const table of grant.tables) {
      for (const role of grant.roles) {
        if (bypassing.has(role)) continue
        readers.set(table, [...(readers.get(table) ?? []), role])
      }
    }
  }
  return readers
}

/** The column list of the `events` table declaration, as `[name, rest]` pairs. */
function eventsColumns(): { name: string; declaration: string }[] {
  const match = /CREATE TABLE IF NOT EXISTS events \(([\s\S]*?)\)\s*PARTITION BY RANGE \(ts\);/.exec(sqlOf('0001_events'))
  if (!match) throw new Error('the events table declaration was not found')
  return (match[1] as string)
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = '', ...rest] = line.split(/\s+/)
      return { name, declaration: rest.join(' ') }
    })
}

/**
 * The column list of any `CREATE TABLE IF NOT EXISTS <name> ( … );` declaration,
 * as `[name, rest]` pairs. The general form of {@link eventsColumns}, which
 * cannot be reused because the events table ends `) PARTITION BY RANGE (ts);`
 * rather than `);`.
 */
export function tableColumns(sql: string, table: string): { name: string; declaration: string }[] {
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`).exec(sql)
  if (!match) throw new Error(`the ${table} table declaration was not found`)
  return (match[1] as string)
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = '', ...rest] = line.split(/\s+/)
      return { name, declaration: rest.join(' ') }
    })
}

/**
 * Every column name in every `CREATE TABLE` in the text, paired with its table.
 *
 * Deliberately not scoped to one table: the claim case 31 makes is about the
 * WHOLE schema, and a plaintext key column smuggled into `events` or into a
 * projection would satisfy a law that only read `ingest_keys`.
 */
export function allColumnNames(sql: string): { table: string; column: string }[] {
  const found: { table: string; column: string }[] = []
  for (const match of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\)\s*(?:PARTITION BY|;)/gi)) {
    const table = match[1] as string
    for (const line of (match[2] as string).split('\n')) {
      const name = line.trim().replace(/,$/, '').split(/\s+/)[0] ?? ''
      if (name === '') continue
      found.push({ table, column: name })
    }
  }
  return found
}

interface IndexDeclaration {
  readonly name: string
  readonly table: string
  readonly body: string
  readonly concurrently: boolean
}

const CREATE_INDEX_RE =
  /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s+([^;]*);/gi

export function indexDeclarations(sql: string): IndexDeclaration[] {
  return [...sql.matchAll(CREATE_INDEX_RE)].map((m) => ({
    name: m[2] as string,
    table: m[3] as string,
    body: (m[4] as string).replace(/\s+/g, ' ').trim(),
    concurrently: m[1] !== undefined,
  }))
}

/**
 * An index declared on a PARTITION rather than on a named table.
 *
 * `0004_events_dedup.sql` builds its index inside `format('… %I … %I …')`,
 * because which partitions exist depends on when `0001` ran and there is no
 * list to write. {@link CREATE_INDEX_RE} cannot see one: it matches `ON (\w+)`
 * and `%I` is not `\w+`. That is exactly why case 20's four-element `toEqual`
 * would have stayed green while accounting for the new index at all — a test
 * that cannot fail for the reason it claims. This extractor is the other half.
 */
interface PartitionIndexDeclaration {
  readonly unique: boolean
  readonly concurrently: boolean
  readonly name: string
  /** Always the `%I` placeholder — a declaration on a literal table is not one of these. */
  readonly target: string
  readonly columns: string[]
}

const PARTITION_INDEX_RE =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF NOT EXISTS\s+)?(%I|\w+)\s+ON\s+(%I|\w+)\s*\(([^)]*)\)/gi

export function partitionIndexDeclarations(sql: string): PartitionIndexDeclaration[] {
  return [...sql.matchAll(PARTITION_INDEX_RE)]
    .filter((m) => m[4] === '%I')
    .map((m) => ({
      unique: m[1] !== undefined,
      concurrently: m[2] !== undefined,
      name: m[3] as string,
      target: m[4] as string,
      columns: (m[5] as string).split(',').map((s) => s.trim()),
    }))
}

/** `CREATE TABLE IF NOT EXISTS <name>` — the tables a migration declares. */
export function createdTables(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1] as string)
}

/** `CREATE ROLE <name> <attributes>` — every role and whether it carries BYPASSRLS. */
export function createdRoles(sql: string): { name: string; bypassRls: boolean }[] {
  return [...sql.matchAll(/CREATE ROLE\s+(\w+)([^;]*);/gi)].map((m) => ({
    name: m[1] as string,
    bypassRls: /\bBYPASSRLS\b/i.test(m[2] as string),
  }))
}

/** `GRANT <privileges> ON <tables> TO <roles>;` */
export function grants(sql: string): { privileges: string[]; tables: string[]; roles: string[] }[] {
  return [...sql.matchAll(/GRANT\s+([\w\s,]+?)\s+ON\s+([\w\s,]+?)\s+TO\s+([\w\s,]+?);/gi)].map((m) => ({
    privileges: (m[1] as string).split(',').map((s) => s.trim().toUpperCase()),
    tables: (m[2] as string).split(',').map((s) => s.trim()),
    roles: (m[3] as string).split(',').map((s) => s.trim()),
  }))
}

describe('case 26 — the walk really reads the tracked migrations', () => {
  it('finds exactly the five that ship with this package', () => {
    expect(migrations().map((m) => m.id)).toEqual([
      '0001_events',
      '0002_projections',
      '0003_roles_rls',
      '0004_events_dedup',
      '0005_ingest_keys',
    ])
  })

  it('and they contain real DDL, not empty files', () => {
    for (const m of migrations()) expect(stripSqlComments(m.raw).trim().length).toBeGreaterThan(50)
  })

  it('comment stripping removes the header without eating the statements', () => {
    const stripped = sqlOf('0001_events')
    expect(rawOf('0001_events')).toContain('ON CONFLICT')
    expect(stripped).not.toContain('ON CONFLICT')
    expect(stripped).toContain('CREATE TABLE IF NOT EXISTS events (')
    expect(stripped).toContain('PARTITION BY RANGE (ts)')
    // …and it is a line-scoped strip, not a whole-file one.
    expect(stripSqlComments('SELECT 1; -- why\nSELECT 2;')).toBe('SELECT 1; \nSELECT 2;')
  })
})

describe('case 18 — the events table is exactly ruling 5', () => {
  it('is partitioned by range on ts', () => {
    expect(sqlOf('0001_events')).toContain('PARTITION BY RANGE (ts)')
  })

  it('declares exactly the eleven columns, as a set — an extra one fails too', () => {
    expect(eventsColumns().map((c) => c.name).sort()).toEqual([...RULING_5_COLUMNS].sort())
  })

  it('line is `text NOT NULL` and payload is `jsonb NOT NULL`', () => {
    const byName = new Map(eventsColumns().map((c) => [c.name, c.declaration]))
    expect(byName.get('line')).toMatch(/^text\s+NOT NULL$/)
    expect(byName.get('payload')).toMatch(/^jsonb\s+NOT NULL$/)
    expect(byName.get('ts')).toMatch(/^timestamptz\s+NOT NULL$/)
    expect(byName.get('n')).toMatch(/^bigint\s+NOT NULL$/)
  })

  it('the parser really parsed — a rigged declaration with a twelfth column would be seen', () => {
    // The guard against a regex that matched nothing: the extractor is shown
    // returning a different answer for different input.
    expect(eventsColumns().length).toBe(11)
    expect(RULING_5_COLUMNS.length).toBe(11)
  })
})

describe('case 19 — a monthly window, with a top-up path', () => {
  it('creates bounded monthly partitions derived from date_trunc', () => {
    const sql = sqlOf('0001_events')
    expect(sql).toContain("date_trunc('month'")
    expect(sql).toMatch(/FOR VALUES FROM \(.+\) TO \(.+\)/)
    expect(sql).toContain('PARTITION OF events')
  })

  it('and the port declares the top-up, because a window is not a promise', () => {
    expect(readFileSync(EVENTS_PORT_PATH, 'utf8')).toContain('ensureMonthlyPartition(month: string): Promise<void>')
  })
})

describe('case 20 — exactly four indexes on the PARENT, and the unique key on each partition', () => {
  /**
   * The claim this `it` makes changed with prd-51's 2026-09-08 amendment, and
   * the name says so because otherwise the assertion and the claim drift apart.
   *
   * It used to read "exactly four indexes on events". It now reads: the parent
   * still carries exactly four, **because the unique key cannot live there** —
   * `UNIQUE constraint on table "events" lacks column "ts" which is part of the
   * partition key`. Ruling 5's sentence as the amendment rewrote it: the natural
   * unique key cannot exist on the partitioned table; it exists on each
   * partition. So four here is not "we added no index", it is "the index we
   * added could not have gone here", and the clause below is where the added
   * one is accounted for.
   */
  it('the parent carries one BRIN and three btrees, and cannot carry the unique key at all', () => {
    const onEvents = indexDeclarations(allStripped()).filter((i) => i.table === 'events')
    expect(onEvents.length).toBe(4)
    expect(onEvents.map((i) => i.body).sort()).toEqual(
      [
        'USING brin (ts) WITH (pages_per_range = 32)',
        '(lane, ts)',
        '(project_id, lane)',
        '(type, ts)',
      ].sort(),
    )
  })

  /**
   * RESTATED, NOT WEAKENED (#462, prd-51 ruling 8).
   *
   * This used to read `indexDeclarations(allStripped()).every((i) => i.table === 'events')`,
   * and `0005_ingest_keys.sql` makes that false: the keys table carries an index
   * on `project_id`, because revoking a project's keys is the only access path a
   * primary key on the digest cannot serve.
   *
   * The law's INTENT was that nothing indexes the wrong thing — not that `events`
   * is the only table this schema may ever hold. `CONTRIBUTING.md` allows a law
   * to be restated at equal or greater strength and never weakened, so the
   * replacement is an exact per-table pin rather than a loosened predicate: it
   * fails on a wrong table exactly as the old one did, AND on a wrong body, AND
   * in the retiring direction, none of which `.every(...)` could see.
   */
  it('and every index in the whole schema is accounted for, by table and by body', () => {
    const byTable = new Map<string, string[]>()
    for (const index of indexDeclarations(allStripped())) {
      byTable.set(index.table, [...(byTable.get(index.table) ?? []), index.body].sort())
    }
    expect(Object.fromEntries([...byTable.entries()].sort())).toEqual({
      events: [
        '(lane, ts)',
        '(project_id, lane)',
        '(type, ts)',
        'USING brin (ts) WITH (pages_per_range = 32)',
      ].sort(),
      ingest_keys: ['(project_id)'],
    })
  })

  it('the extractor bites — it finds a planted fifth index and reads its target', () => {
    const rigged = indexDeclarations('CREATE INDEX IF NOT EXISTS x ON events (source);')
    expect(rigged).toEqual([{ name: 'x', table: 'events', body: '(source)', concurrently: false }])
    expect(indexDeclarations('-- CREATE INDEX nope ON events (source)')).toEqual([])
  })

  /**
   * The added index, accounted for by the only extractor that can see it.
   *
   * `CREATE_INDEX_RE` matches `ON (\w+)`; `0004`'s target is the `%I`
   * placeholder of a `format()` template, so the four-element assertion above
   * stays at four **without having looked at the new index**. Deleting or
   * loosening that assertion is not the repair — it is still true and still
   * worth holding. This is.
   */
  it('exactly one per-partition index exists across every tracked migration, and it is ruling 4s key', () => {
    const declarations = partitionIndexDeclarations(allStripped())
    expect(declarations.length).toBe(1)
    const declaration = declarations[0]
    expect(declaration?.unique).toBe(true)
    expect(declaration?.concurrently).toBe(false)
    expect(declaration?.columns).toEqual(['project_id', 'actor_instance', 'n'])
    // Aimed at a partition, never at the parent — which is the whole amendment.
    expect(declaration?.target).toBe('%I')
    expect(declaration?.columns).not.toContain('event_id')
    expect(declaration?.columns).not.toContain('ts')
  })

  it('the per-partition extractor bites — a planted declaration is found and a commented one is not', () => {
    expect(
      partitionIndexDeclarations("EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (a, b)', x, y);"),
    ).toEqual([{ unique: true, concurrently: false, name: '%I', target: '%I', columns: ['a', 'b'] }])
    expect(
      partitionIndexDeclarations(stripSqlComments("-- EXECUTE format('CREATE UNIQUE INDEX %I ON %I (a)')")),
    ).toEqual([])
    // …and it does NOT claim a literal-target index as a partition one, which is
    // what keeps the two extractors from double-counting the same declaration.
    expect(partitionIndexDeclarations('CREATE UNIQUE INDEX x ON events (project_id);')).toEqual([])
    // …nor would it miss a CONCURRENTLY smuggled into the format template.
    expect(
      partitionIndexDeclarations("format('CREATE UNIQUE INDEX CONCURRENTLY %I ON %I (a)')")[0]?.concurrently,
    ).toBe(true)
  })
})

describe('the ruling 4 / ruling 5 collision is recorded as RESOLVED, and cited', () => {
  /**
   * `0001_events.sql`'s header recorded the collision as an open question and
   * said the ingest issue would settle it. It is settled — prd-51's amendment
   * of 2026-09-08 — and the header was rewritten to say what was ruled.
   *
   * Asserted rather than assumed, because a header that still poses the
   * question sends the next reader to re-litigate a decision that is made, and
   * nothing else in this suite reads the prose.
   */
  it('the open question is gone and the amendment is cited by path and date', () => {
    const raw = rawOf('0001_events')
    expect(raw).not.toContain('NOT resolved here')
    expect(raw).not.toContain('It is the ingest issue')
    expect(raw).toContain('RESOLVED')
    expect(raw).toContain('2026-09-08')
    expect(raw).toContain('docs/prds/prd-51-the-split.md')
    // The clause itself is still named as what was RULED, which is what case 26's
    // comment-stripping assertion reads it for.
    expect(raw).toContain('ON CONFLICT')
    expect(raw).toContain('0004_events_dedup.sql')
  })

  /**
   * The invariant the amendment added, and the reason it is written into the
   * migration rather than left in the PRD: per-partition uniqueness cannot see
   * across a partition boundary, so a shipper that recomputed `ts` would break
   * dedup at every month boundary with no error anywhere.
   */
  it('and the header states the invariant dedup rests on', () => {
    expect(rawOf('0001_events')).toContain('always carries the same ts')
  })

  it('0004 cites the amendment too, and quotes the errors it answers', () => {
    const raw = rawOf('0004_events_dedup')
    expect(raw).toContain('docs/prds/prd-51-the-split.md')
    expect(raw).toContain('2026-09-08')
    expect(raw).toContain('no unique or exclusion constraint matching the ON CONFLICT specification')
  })
})

describe('case 21 — no covering expression index, and the note is cited', () => {
  it('no index covers a jsonb expression the planner never chose', () => {
    for (const index of indexDeclarations(allStripped())) {
      expect(index.body).not.toContain('INCLUDE (')
      expect(index.body).not.toContain('->>')
    }
  })

  it('and the file cites the spike that measured it', () => {
    expect(rawOf('0001_events')).toContain('docs/research/2026-08-28-shared-record-s4-schema.md')
  })
})

describe('case 22 — the three projections exist, all of them', () => {
  it('0002 creates exactly spend_by_project_day, lane_state and collisions', () => {
    expect(createdTables(sqlOf('0002_projections')).sort()).toEqual([
      'collisions',
      'lane_state',
      'spend_by_project_day',
    ])
  })
})

describe('case 23 — roles and RLS, both facts', () => {
  it('the ingest writer bypasses RLS', () => {
    const roles = createdRoles(sqlOf('0003_roles_rls'))
    expect(roles.length).toBeGreaterThanOrEqual(3)
    expect(roles.filter((r) => r.bypassRls).map((r) => r.name)).toEqual(['rz_ingest'])
  })

  it('every table has row level security enabled, and FORCEd so the owner is inside it too', () => {
    const sql = sqlOf('0003_roles_rls')
    for (const table of ['events', 'spend_by_project_day', 'lane_state', 'collisions']) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
    }
  })

  /**
   * The general form of the defect found reviewing #360, not the instance.
   *
   * `GRANT INSERT, UPDATE` on the projections without SELECT produced a role
   * that could not perform the write it exists for: PostgreSQL requires SELECT
   * on every column named in a WHERE clause and on the row that
   * `ON CONFLICT ... DO UPDATE` reads. EXECUTED against PostgreSQL 18.4 --
   * `ERROR: permission denied for table spend_by_project_day` -- and controlled
   * by granting SELECT (both statements pass) and revoking it again (denied).
   *
   * Asserting the instance would pin one grant line. This asserts the rule, so
   * a fourth projection added later with the same two verbs reddens here rather
   * than in wave 3 against a real database.
   *
   * `events` is deliberately exempt and named: ingest appends and never reads
   * it back, so INSERT alone is correct and a SELECT there would be a widening.
   *
   * MUTATION: drop SELECT from the projections grant -- red.
   */
  it('any table a role may UPDATE, it may also SELECT — UPDATE ... WHERE cannot run without it', () => {
    const sql = sqlOf('0003_roles_rls')
    const selectable = new Map<string, Set<string>>()
    const updatable = new Map<string, Set<string>>()
    for (const grant of grants(sql)) {
      for (const role of grant.roles) {
        for (const table of grant.tables) {
          if (grant.privileges.includes('SELECT')) {
            if (!selectable.has(role)) selectable.set(role, new Set())
            selectable.get(role)?.add(table)
          }
          if (grant.privileges.includes('UPDATE')) {
            if (!updatable.has(role)) updatable.set(role, new Set())
            updatable.get(role)?.add(table)
          }
        }
      }
    }

    // Not vacuous: some role must actually hold UPDATE somewhere.
    expect([...updatable.values()].reduce((n, set) => n + set.size, 0)).toBeGreaterThan(0)

    const missing: string[] = []
    for (const [role, tables] of updatable) {
      for (const table of tables) {
        if (!selectable.get(role)?.has(table)) missing.push(`${role} may UPDATE ${table} but not SELECT it`)
      }
    }
    expect(missing).toEqual([])
  })

  it('every policy predicates on project_id', () => {
    const policies = [...sqlOf('0003_roles_rls').matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+(\w+)([^;]*);/gi)]
    expect(policies.length).toBe(4)
    for (const policy of policies) {
      expect(policy[3]).toContain('project_id = current_setting')
    }
  })

  it('NO role granted SELECT on events also carries BYPASSRLS — the failure that makes isolation fiction', () => {
    const sql = sqlOf('0003_roles_rls')
    const bypassing = new Set(
      createdRoles(sql)
        .filter((r) => r.bypassRls)
        .map((r) => r.name),
    )
    const readers = new Set<string>()
    for (const grant of grants(sql)) {
      if (!grant.privileges.includes('SELECT')) continue
      if (!grant.tables.includes('events')) continue
      for (const role of grant.roles) readers.add(role)
    }
    expect(readers.size).toBeGreaterThan(0)
    expect([...readers].filter((r) => bypassing.has(r))).toEqual([])
  })

  /**
   * RLS ENABLED WITH NO POLICY (#565), and the shape of this law is the whole finding.
   *
   * #514's drill restored a database exactly as `docs/team-server-runbook.md` prescribes and
   * measured this on the real host:
   *
   *     rz_ roles present   : (NONE)      policies on events : 0
   *     rls enabled/forced  : true/true   migrations recorded: 5
   *
   * A table in that state looks protected to every check an operator would think to run — `\d+`
   * reports RLS on, the migration that configures it is recorded as applied, the boot report says
   * nothing to do — while nothing restricts anything.
   *
   * ## THIS LAW IS TWO CLAUSES, AND NEITHER SUBSUMES THE OTHER
   *
   * The obvious law — *every RLS-enabled table has a policy* — is RED ON THIS SCHEMA, and
   * correctly so: `0005` enables RLS on `ingest_keys` and deliberately does not FORCE it, with its
   * header arguing the case (*"RLS with no policy denies anyone who later is"*). On that table the
   * two booleans are a DECLARATION, not a symptom. Exempting it by name would be the absence
   * machinery this repo forbids, so the law is narrowed until it is true instead:
   *
   * - **FORCED with no policy** — nobody reads it, the owner included, and the app connects as the
   *   owner. `ingest_keys` is outside this because it is not FORCEd.
   * - **ENABLED and readable by a role that does not BYPASSRLS, with no policy** — that role was
   *   granted a read that returns nothing, forever. `ingest_keys` is outside this because its only
   *   SELECT grant goes to `rz_ingest`, which the case above pins as the one BYPASSRLS role.
   *
   * Measured, not argued: dropping `events`' policy trips BOTH; a forced table with no grants at
   * all trips only the first; granting `rz_viewer` SELECT on `ingest_keys` trips only the second.
   * The two mutation cases below are those last two.
   *
   * ## WHAT THIS LAW CANNOT SEE
   *
   * It reads the tracked `.sql` and so proves a property of the DDL THIS PACKAGE WILL RUN. #514's
   * host had correct files and a diverged database — `_migrations` recorded `0003` as applied
   * while the roles and policies it creates were absent, so the migration will never re-run to
   * recreate them. **No static law can catch that**, and this one does not claim to; that wants a
   * boot-time check against `pg_policy`/`pg_roles`, which is a different fence.
   *
   * No count is asserted anywhere here. The claim is "enabled implies at least one", never
   * "enabled implies four" — a policy count in a test is the rot #514 corrected in the runbook.
   */
  it('a FORCED table with no policy is a schema-law failure — nobody reads it, the owner included', () => {
    const sql = allStripped()

    // Not vacuous, and the floor is on the parser the offender list is BUILT FROM: a
    // `rlsEnabledTables` that returned nothing would make this case pass forever.
    expect(rlsEnabledTables(sql).length).toBeGreaterThan(0)
    expect(forcedTables(sql).size).toBeGreaterThan(0)
    expect(policiedTables(sql).size).toBeGreaterThan(0)

    const offenders = forcedWithoutPolicy(sql).map(
      (table) =>
        `${table} FORCEs row level security and carries no policy that admits a read, so nothing — not even the owner — can read it: the schema no longer means what 0003_roles_rls.sql says it means`,
    )
    expect(offenders).toEqual([])
  })

  it('an RLS table a non-bypassing role may SELECT must have a policy, or that grant reads nothing', () => {
    const sql = allStripped()
    const readers = nonBypassingReaders(sql)

    expect(rlsEnabledTables(sql).length).toBeGreaterThan(0)
    expect([...readers.values()].reduce((n, roles) => n + roles.length, 0)).toBeGreaterThan(0)

    const offenders = readableWithoutPolicy(sql).map(
      (table) =>
        `${table} has row level security enabled and is SELECT-able by ${readers.get(table)?.join(', ')}, but no policy admits anyone: the schema no longer means what 0003_roles_rls.sql says it means`,
    )
    expect(offenders).toEqual([])
  })

  /**
   * MUTATION — the state #514 measured, planted as a string rather than as an edit to a tracked
   * `.sql`. The migrations are checksummed (`runner.ts` refuses a run whose recorded checksum
   * differs), so a law about them must not touch them to test itself.
   *
   * These assert the CLAUSES, not the parsers underneath them. An earlier version asserted
   * `forcedTables(rigged).has(...)` and friends, which is a fact about a regex: gutting either
   * clause left all of them green.
   */
  it("the law bites — drop `events`' policy with RLS still on and BOTH clauses name it", () => {
    const rigged = allStripped().replace(/CREATE\s+POLICY\s+events_by_project[^;]*;/i, '')
    expect(forcedWithoutPolicy(rigged)).toContain('events')
    expect(readableWithoutPolicy(rigged)).toContain('events')
    // The control: on the real schema neither clause names it.
    expect(forcedWithoutPolicy(allStripped())).toEqual([])
    expect(readableWithoutPolicy(allStripped())).toEqual([])
  })

  /**
   * THE TWO CLAUSES ARE NOT REDUNDANT, and these are the cases that prove it. Each state below is
   * caught by exactly ONE clause, so dropping either ships one of them green.
   */
  it('a FORCED table with no grants at all is caught by the first clause and missed by the second', () => {
    const rigged = `${allStripped()}\nALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;\nALTER TABLE audit_log FORCE ROW LEVEL SECURITY;`
    expect(forcedWithoutPolicy(rigged)).toContain('audit_log')
    // Nothing was granted, so clause B has no reader to inspect and cannot see it.
    expect(readableWithoutPolicy(rigged)).not.toContain('audit_log')
  })

  it('granting rz_viewer a read on policy-less ingest_keys is caught by the second clause and missed by the first', () => {
    const rigged = `${allStripped()}\nGRANT SELECT ON ingest_keys TO rz_viewer;`
    expect(readableWithoutPolicy(rigged)).toContain('ingest_keys')
    // `ingest_keys` is ENABLED and not FORCEd, which is why it is green today. The exemption is
    // derived from the schema, not written down.
    expect(forcedWithoutPolicy(rigged)).not.toContain('ingest_keys')
  })

  /**
   * A POLICY THAT ADMITS NO READ IS NOT A POLICY, for either clause.
   *
   * Found at verification. `FOR INSERT` silenced both clauses while the table stayed exactly as
   * unreadable as one with no policy at all — and clause B's message would have said "no policy
   * admits anyone" about a table that has one.
   */
  it('an INSERT-only policy does not satisfy either clause', () => {
    const insertOnly = 'CREATE POLICY ingest_keys_insert_only ON ingest_keys FOR INSERT WITH CHECK (true);'
    const readable = `${allStripped()}\nGRANT SELECT ON ingest_keys TO rz_viewer;\n${insertOnly}`
    expect(readableWithoutPolicy(readable)).toContain('ingest_keys')

    const forced = `${allStripped()}\nALTER TABLE ingest_keys FORCE ROW LEVEL SECURITY;\n${insertOnly}`
    expect(forcedWithoutPolicy(forced)).toContain('ingest_keys')

    // The control: a SELECT policy DOES satisfy both, so this is about the command and not
    // about the parser failing to see the statement at all.
    const selectPolicy = 'CREATE POLICY ingest_keys_read ON ingest_keys FOR SELECT TO rz_viewer USING (true);'
    expect(readableWithoutPolicy(`${allStripped()}\nGRANT SELECT ON ingest_keys TO rz_viewer;\n${selectPolicy}`)).not.toContain('ingest_keys')
    // …and so does one with no FOR clause, which PostgreSQL reads as ALL.
    const allPolicy = 'CREATE POLICY ingest_keys_all ON ingest_keys USING (true);'
    expect(readableWithoutPolicy(`${allStripped()}\nGRANT SELECT ON ingest_keys TO rz_viewer;\n${allPolicy}`)).not.toContain('ingest_keys')
  })

  /**
   * THE PARSERS DO NOT FAIL OPEN ON A SPELLING, and that is the failure mode that matters.
   *
   * Found at verification: matching the table as a bare `(\\w+)` made `ALTER TABLE ONLY events`,
   * `ALTER TABLE public.events` and `ALTER TABLE "events"` parse as no table at all — so a future
   * migration written any of those three ways would plant exactly the state these clauses forbid
   * and neither would see it. A parser that stops seeing tables makes both clauses vacuous for
   * those tables, silently.
   */
  it('ONLY, a schema qualifier and quotes are all still the same table', () => {
    for (const spelling of ['events', 'ONLY events', 'public.events', '"events"', 'ONLY public."events"']) {
      expect(rlsEnabledTables(`ALTER TABLE ${spelling} ENABLE ROW LEVEL SECURITY;`), spelling).toEqual(['events'])
      expect([...forcedTables(`ALTER TABLE ${spelling} FORCE ROW LEVEL SECURITY;`)], spelling).toEqual(['events'])
    }
    for (const spelling of ['events', 'public.events', '"events"']) {
      expect([...policiedTables(`CREATE POLICY p ON ${spelling} FOR SELECT USING (true);`)], spelling).toEqual(['events'])
    }
  })

  /**
   * THE TWO HOLES REVIEW FOUND IN THIS GUARD, pinned so they cannot reopen.
   *
   * Both are the shape `TABLE_REF`'s docblock already argues against: *"a guard that stops seeing
   * a table is worse here than one that is noisy about it, because the state it stops seeing is
   * the one #514 measured."* Neither was a defect in the shipped schema — both were holes in the
   * guard installed to watch it.
   */
  it('a DROPPED policy is not a policy — the #514 state, planted by a DROP', () => {
    const rigged = `${allStripped()}\nDROP POLICY events_by_project ON events;`
    expect(policiedTables(rigged).has('events')).toBe(false)
    expect(forcedWithoutPolicy(rigged)).toContain('events')
    expect(readableWithoutPolicy(rigged)).toContain('events')
  })

  it("…but 0003's own DROP-then-CREATE pairs still read as policied", () => {
    // The corpus already contains `DROP POLICY IF EXISTS x ON t; CREATE POLICY x ON t …`.
    expect(allStripped()).toContain('DROP POLICY IF EXISTS events_by_project ON events')
    expect(policiedTables(allStripped()).has('events')).toBe(true)
    expect(forcedWithoutPolicy(allStripped())).toEqual([])
  })

  it('a QUOTED schema qualifier is still the same table', () => {
    for (const spelling of ['"public"."events"', 'public."events"', '"public".events']) {
      expect(rlsEnabledTables(`ALTER TABLE ${spelling} ENABLE ROW LEVEL SECURITY;`), spelling).toEqual(['events'])
    }
  })

  it('the grant parser bites — it would see the violation it is asserting the absence of', () => {
    const rigged = 'CREATE ROLE bad NOLOGIN BYPASSRLS;\nGRANT SELECT ON events TO bad;'
    expect(createdRoles(rigged)).toEqual([{ name: 'bad', bypassRls: true }])
    expect(grants(rigged)).toEqual([{ privileges: ['SELECT'], tables: ['events'], roles: ['bad'] }])
  })
})

describe('case 24 — event_id is stored and never keyed', () => {
  it('appears in the events column list', () => {
    expect(eventsColumns().map((c) => c.name)).toContain('event_id')
  })

  it('appears in no index, no primary key, no ON CONFLICT and no WHERE in any tracked migration', () => {
    for (const { id, raw } of migrations()) {
      const sql = stripSqlComments(raw)
      for (const index of indexDeclarations(sql)) {
        expect(`${id}:${index.body}`).not.toContain('event_id')
      }
      for (const clause of [
        ...sql.matchAll(/PRIMARY KEY\s*\(([^)]*)\)/gi),
        ...sql.matchAll(/ON CONFLICT\s*\(([^)]*)\)/gi),
        ...sql.matchAll(/\bWHERE\b([^;]*)/gi),
      ]) {
        expect(`${id}:${clause[1] ?? clause[0]}`).not.toContain('event_id')
      }
    }
  })
})

describe('case 25 — no CONCURRENTLY, because applyMigration runs inside a transaction', () => {
  it('no tracked migration uses it', () => {
    expect(allStripped()).not.toMatch(/\bCONCURRENTLY\b/i)
    expect(indexDeclarations(allStripped()).some((i) => i.concurrently)).toBe(false)
  })

  it('the detector would see it — the extractor flags a planted CONCURRENTLY', () => {
    expect(indexDeclarations('CREATE INDEX CONCURRENTLY x ON events (n);')[0]?.concurrently).toBe(true)
  })
})

/**
 * CASE 31 — THE KEYS TABLE STORES A DIGEST AND NEVER A KEY (prd-51 ruling 8).
 *
 * Ruling 8: *"32 random bytes, **stored only as SHA-256**, shown once at mint"*.
 * That clause is the one an implementation loses quietly — a second column added
 * "for support" costs nothing at the time and makes the whole sentence false —
 * so it is asserted from both ends: the column list of this table exactly, and
 * a rule over the WHOLE schema that no column anywhere may name a key without
 * being a digest of one.
 *
 * MUTATION, executed before this was committed: add `plaintext text` to
 * `0005_ingest_keys.sql` and the exact column list goes red; rename it
 * `ingest_key text` and both that clause and the whole-schema rule go red;
 * plant `GRANT SELECT ON ingest_keys TO rz_viewer` and the grant clause goes red.
 */
describe('case 31 — ingest_keys holds a digest, a project and two timestamps', () => {
  it('0005 creates exactly one table, and it is the keys table', () => {
    expect(createdTables(sqlOf('0005_ingest_keys'))).toEqual(['ingest_keys'])
  })

  it('declares exactly four columns — an extra one fails, which is the point', () => {
    expect(tableColumns(sqlOf('0005_ingest_keys'), 'ingest_keys').map((c) => c.name).sort()).toEqual([
      'created_at',
      'key_hash',
      'project_id',
      'revoked_at',
    ])
  })

  it('the digest is the primary key, and the revocation flag is the one nullable column', () => {
    const byName = new Map(tableColumns(sqlOf('0005_ingest_keys'), 'ingest_keys').map((c) => [c.name, c.declaration]))
    expect(byName.get('key_hash')).toMatch(/^text\s+PRIMARY KEY$/)
    expect(byName.get('project_id')).toMatch(/^text\s+NOT NULL$/)
    expect(byName.get('created_at')).toMatch(/^timestamptz\s+NOT NULL$/)
    // Nullable, and that IS the flag: `revoked_at IS NULL` means live.
    expect(byName.get('revoked_at')).toBe('timestamptz')
  })

  it('the column parser bites — it reads a rigged five-column declaration as five', () => {
    const rigged = 'CREATE TABLE IF NOT EXISTS ingest_keys (\n  key_hash text PRIMARY KEY,\n  plaintext text\n);'
    expect(tableColumns(rigged, 'ingest_keys').map((c) => c.name)).toEqual(['key_hash', 'plaintext'])
  })

  /**
   * THE WHOLE-SCHEMA RULE, not the instance.
   *
   * Asserting only `ingest_keys`' column list would pin one table. This pins the
   * claim: a column that names a key anywhere in this schema is a digest of one.
   * A `plaintext` column added beside `key_hash` is caught by the clause above;
   * an `ingest_key` column added to `events` is caught only by this one.
   */
  it('no column in the whole schema names a key without being a digest of one', () => {
    const offenders = allColumnNames(allStripped())
      .filter(({ column }) => /key/i.test(column))
      .filter(({ column }) => !column.endsWith('_hash'))
    expect(offenders).toEqual([])
    // Not vacuous: the sweep really found the one column that IS allowed.
    expect(allColumnNames(allStripped()).filter(({ column }) => column === 'key_hash')).toEqual([
      { table: 'ingest_keys', column: 'key_hash' },
    ])
  })

  it('the whole-schema sweep bites — a planted plaintext column is found and named', () => {
    const rigged = 'CREATE TABLE IF NOT EXISTS ingest_keys (\n  key_hash text,\n  ingest_key text\n);'
    expect(allColumnNames(rigged).filter(({ column }) => /key/i.test(column) && !column.endsWith('_hash'))).toEqual([
      { table: 'ingest_keys', column: 'ingest_key' },
    ])
    // …and it reaches inside a table that is not the keys table at all.
    const elsewhere = 'CREATE TABLE IF NOT EXISTS events (\n  n bigint,\n  ingest_key text\n) PARTITION BY RANGE (ts);'
    expect(allColumnNames(elsewhere).map((c) => c.column)).toEqual(['n', 'ingest_key'])
  })

  /**
   * RLS is ENABLED and deliberately NOT FORCEd, which is the opposite of what
   * `0003` does to the four fact tables. The migration's own header carries the
   * reason — the app reads this table as the database OWNER, and `0003`'s
   * measured table says a plain owner under FORCE sees nothing — so a FORCE here
   * with no policy would deny the server its own key check.
   */
  it('enables row level security, does not FORCE it, and says why in the file', () => {
    const sql = sqlOf('0005_ingest_keys')
    expect(sql).toContain('ALTER TABLE ingest_keys ENABLE ROW LEVEL SECURITY')
    expect(sql).not.toContain('FORCE ROW LEVEL SECURITY')
    expect(rawOf('0005_ingest_keys')).toContain('NOT FORCE')
  })

  /**
   * The grant lives in THIS migration rather than in an edit to `0003`: applied
   * migrations are checksummed and `0001`'s header records that the one legal
   * retroactive edit has been spent.
   */
  it('grants rz_ingest SELECT and grants no viewer role anything at all', () => {
    const granted = grants(sqlOf('0005_ingest_keys')).filter((g) => g.tables.includes('ingest_keys'))
    expect(granted).toEqual([{ privileges: ['SELECT'], tables: ['ingest_keys'], roles: ['rz_ingest'] }])
    // The whole schema, not just this file: no other migration may open it either.
    const readers = grants(allStripped())
      .filter((g) => g.tables.includes('ingest_keys'))
      .flatMap((g) => g.roles)
    expect([...new Set(readers)].sort()).toEqual(['rz_ingest'])
  })
})
