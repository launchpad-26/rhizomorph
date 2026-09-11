import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FoldFaults } from '../ingest/faults.js'
import { openJournal } from '../journal/journal.js'
import { grants, stripSqlComments } from '../migrations/schema-law.test.js'
import { FakeTeamStorage } from '../storage/fake.js'
import { createPostgresStorage } from '../storage/postgres.js'
import { createRecordingSql } from '../storage/recording-sql.js'
import { readCursor } from './cursor.js'
import { runOnce } from './worker.js'

/**
 * ORDERING 2's FAULT-POINT HARNESS (prd-51 ruling 4, F6–F9).
 *
 * The tape is the strongest assertion here for the same reason it is in
 * `../ingest/handle.test.ts`: an exact-array `toEqual` fails under any
 * reordering, and the reordering this one guards — cursor before commit — is
 * the mutation that lost 15,000 lines across 30 kills.
 *
 * The journal is a real file. The storage is a double: `FakeTeamStorage` where
 * the question is what LANDED, and `RecordingSql` behind the real adapter where
 * the question is what was SENT. The grant law needs the second, because the
 * grants are a property of the statements and not of the results.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rz-fold-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const COST_LINE = (n: number, costUsd: number, tsMs: number) =>
  JSON.stringify({
    id: `evt_${n}`,
    ts: tsMs,
    source: 'otel',
    type: 'llm.cost',
    payload: { lane: 'prd51-w3', worktreePath: '/repo-wt/prd51-w3', role: 'worker', model: 'opus', costUsd, authoritative: true },
  })

const TS = Date.UTC(2026, 7, 3, 12)

function journalPath(): string {
  return path.join(dir, 'ingest.journal')
}
function cursorPath(): string {
  return path.join(dir, 'fold.cursor')
}

/** Writes one journal record carrying `count` `llm.cost` lines at $1 each. */
function writeBatch(count: number, from = 1): void {
  const opened = openJournal({ path: journalPath() })
  if (!opened.ok) throw new Error(opened.error)
  opened.journal.append({
    project: 'acme-widgets',
    actorInstance: 'lane-7',
    receivedAtMs: TS,
    batch: Array.from({ length: count }, (_, i) => ({ n: from + i, line: COST_LINE(from + i, 1, TS) })),
  })
  opened.journal.close()
}

function deps(storage: FakeTeamStorage | ReturnType<typeof createPostgresStorage>, faults?: FoldFaults, tape?: string[]) {
  return {
    journalPath: journalPath(),
    cursorPath: cursorPath(),
    storage,
    faults,
    trace: tape ? (step: string) => tape.push(step) : undefined,
  }
}

const dies = (): never => {
  throw new Error('process died')
}

describe('the happy path, and the whole ordering as one array', () => {
  it('reads, begins, inserts, commits, THEN writes and renames the cursor', async () => {
    writeBatch(3)
    const storage = new FakeTeamStorage()
    const tape: string[] = []

    const result = await runOnce(deps(storage, undefined, tape))

    expect(tape).toEqual(['fold.read', 'fold.begin', 'fold.insert', 'fold.commit', 'cursor.write', 'cursor.rename'])
    expect(result).toEqual({ ok: true, records: 1, rows: 3, inserted: 3, cursor: 1, refused: [] })
    expect(storage.events.map((e) => e.n)).toEqual([1, 2, 3])
    expect(readCursor(cursorPath()).seq).toBe(1)
    expect(storage.spend.get('acme-widgets 2026-08-03')).toEqual({
      projectId: 'acme-widgets',
      day: '2026-08-03',
      costUsd: 3,
      events: 3,
    })
  })

  it('a second run with nothing new folds nothing and leaves the cursor where it is', async () => {
    writeBatch(2)
    const storage = new FakeTeamStorage()
    await runOnce(deps(storage))
    const tape: string[] = []
    const second = await runOnce(deps(storage, undefined, tape))

    expect(second).toEqual({ ok: true, records: 0, rows: 0, inserted: 0, cursor: 1, refused: [] })
    expect(tape).toEqual(['fold.read'])
    expect(storage.events.length).toBe(2)
  })

  it('the fold never issues DDL — rz_ingest holds no CREATE anywhere', async () => {
    writeBatch(2)
    const recorder = createRecordingSql()
    await runOnce(deps(createPostgresStorage(recorder.sql)))
    expect(recorder.queries.length).toBeGreaterThan(0)
    for (const query of recorder.queries) {
      expect(query.sql).not.toMatch(/\bCREATE\b/i)
      expect(query.sql).not.toMatch(/\bALTER\b/i)
    }
  })
})

describe('a rewind costs time, not rows', () => {
  it('replaying the same journal record twice inserts N rows, not 2N, and does not double the money', async () => {
    writeBatch(3)
    const storage = new FakeTeamStorage()

    const first = await runOnce(deps(storage))
    // The rewind ruling 4 permits: the cursor is lost, everything else stands.
    rmSync(cursorPath())
    const second = await runOnce(deps(storage))

    expect(first.ok && first.inserted).toBe(3)
    expect(second.ok && second.records).toBe(1)
    expect(second.ok && second.inserted).toBe(0)
    expect(storage.events.length).toBe(3)
    expect(storage.spend.get('acme-widgets 2026-08-03')?.costUsd).toBe(3)
    expect(storage.spend.get('acme-widgets 2026-08-03')?.events).toBe(3)
  })
})

describe('F6–F9 — a fault at each point of the ordering', () => {
  it('F6 — a death between the read and the BEGIN writes nothing and moves nothing', async () => {
    writeBatch(3)
    const storage = new FakeTeamStorage()
    const tape: string[] = []

    const result = await runOnce(deps(storage, { afterReadBeforeBegin: dies }, tape))

    expect(result.ok).toBe(false)
    expect(tape).toEqual(['fold.read'])
    expect(storage.events).toEqual([])
    expect(readCursor(cursorPath()).seq).toBe(0)

    // …and the replay after it yields exactly the batch, once.
    const after = await runOnce(deps(storage))
    expect(after.ok && after.inserted).toBe(3)
    expect(storage.events.map((e) => e.n)).toEqual([1, 2, 3])
  })

  /**
   * F7 is the executed mutation, as a test. Under cursor-first the cursor has
   * already advanced when the transaction rolls back, so the restart skips the
   * batch and the rows are gone — 15,000 lines across 30 kills. Under
   * commit-first the cursor is still where it was, so the restart replays.
   */
  it('F7 — a death inside the transaction ROLLS BACK, leaves the cursor put, and the restart recovers the rows', async () => {
    writeBatch(3)
    const recorder = createRecordingSql()
    const adapter = createPostgresStorage(recorder.sql)
    const tape: string[] = []

    const result = await runOnce(deps(adapter, { afterInsertBeforeCommit: dies }, tape))

    expect(result.ok).toBe(false)
    expect(recorder.log).toContain('ROLLBACK')
    expect(recorder.log).not.toContain('COMMIT')
    expect(tape).toEqual(['fold.read', 'fold.begin', 'fold.insert'])
    expect(existsSync(cursorPath())).toBe(false)
    expect(readCursor(cursorPath()).seq).toBe(0)

    // The restart, against a storage that survives it: the rows are present.
    const storage = new FakeTeamStorage()
    const after = await runOnce(deps(storage))
    expect(after.ok && after.inserted).toBe(3)
    expect(storage.events.map((e) => e.n)).toEqual([1, 2, 3])
  })

  it('F8 — a death after COMMIT and before the cursor replays and dedups, and the money is unchanged', async () => {
    writeBatch(3)
    const storage = new FakeTeamStorage()
    const tape: string[] = []

    const result = await runOnce(deps(storage, { afterCommitBeforeCursor: dies }, tape))

    expect(result.ok).toBe(false)
    expect(tape).toEqual(['fold.read', 'fold.begin', 'fold.insert', 'fold.commit'])
    // The rows ARE committed; only the cursor is behind. That is the legal state.
    expect(storage.events.length).toBe(3)
    expect(readCursor(cursorPath()).seq).toBe(0)
    const costAfterFirst = storage.spend.get('acme-widgets 2026-08-03')?.costUsd

    const replay = await runOnce(deps(storage))
    expect(replay.ok && replay.records).toBe(1)
    expect(replay.ok && replay.inserted).toBe(0)
    expect(storage.events.length).toBe(3)
    expect(storage.spend.get('acme-widgets 2026-08-03')?.costUsd).toBe(costAfterFirst)
    expect(storage.spend.get('acme-widgets 2026-08-03')?.costUsd).toBe(3)
    expect(readCursor(cursorPath()).seq).toBe(1)
  })

  it('F9 — a death between the cursor write and the rename leaves the OLD cursor; the tmp file is not the cursor', async () => {
    writeBatch(2)
    writeBatch(2, 3)
    const storage = new FakeTeamStorage()
    // Fold the first record cleanly so there is an old value to preserve.
    writeFileSync(cursorPath(), '1\n')
    const tape: string[] = []

    const result = await runOnce(deps(storage, { afterCursorWriteBeforeRename: dies }, tape))

    expect(result.ok).toBe(false)
    expect(tape).toEqual(['fold.read', 'fold.begin', 'fold.insert', 'fold.commit', 'cursor.write'])
    expect(readFileSync(cursorPath(), 'utf8').trim()).toBe('1')
    expect(readCursor(cursorPath()).seq).toBe(1)
    expect(existsSync(`${cursorPath()}.tmp`)).toBe(false)

    // The replay: record 2 goes round again and dedups.
    const replay = await runOnce(deps(storage))
    expect(replay.ok && replay.records).toBe(1)
    expect(replay.ok && replay.inserted).toBe(0)
    expect(storage.events.map((e) => e.n)).toEqual([3, 4])
    expect(readCursor(cursorPath()).seq).toBe(2)
  })

  it('every F-test above asserts something the happy path makes false', async () => {
    // The control: the same journal, no fault, moves the cursor and inserts.
    writeBatch(3)
    const storage = new FakeTeamStorage()
    const result = await runOnce(deps(storage))
    expect(result.ok && result.inserted).toBe(3)
    expect(readCursor(cursorPath()).seq).toBe(1)
  })
})

describe('a MALFORMED line stops its own group rather than creating a gap in n (ruling 16)', () => {
  it('nothing is inserted, the cursor does not move, and `refused` names the position', async () => {
    const opened = openJournal({ path: journalPath() })
    if (!opened.ok) throw new Error(opened.error)
    opened.journal.append({
      project: 'acme-widgets',
      actorInstance: 'lane-7',
      receivedAtMs: TS,
      batch: [
        { n: 1, line: COST_LINE(1, 1, TS) },
        { n: 2, line: 'not an event line at all' },
        { n: 3, line: COST_LINE(3, 1, TS) },
      ],
    })
    opened.journal.close()

    const storage = new FakeTeamStorage()
    const result = await runOnce(deps(storage))

    // Ruling 16 changed the SHAPE of the refusal, not the refusal. `ok: false` is now reserved
    // for a journal-level failure; an actor that cannot fold reports itself in `refused`, which
    // is per actor and therefore the only form that survives the fold being per actor at all.
    // A single-actor journal returning `ok: false` and a two-actor one returning `ok: true` for
    // the identical actor-level fact would be the coupling this ruling exists to remove.
    expect(result.ok).toBe(true)
    expect(result.ok && result.refused).toEqual([
      { actorInstance: 'lane-7', n: 2, error: expect.stringContaining('n=2') },
    ])
    // Not "insert 1 and 3 and skip 2": that IS the gap ruling 3 forbids. n=1 shares a record
    // with n=2, so it goes back with it.
    expect(storage.events).toEqual([])
    expect(storage.calls).not.toContain('appendEvents')
    expect(readCursor(cursorPath()).seq).toBe(0)
  })

  it('a corrupt journal refuses the run rather than folding the readable prefix', async () => {
    writeBatch(2)
    writeBatch(2, 3)
    const bytes = readFileSync(journalPath())
    // Flip a byte inside record 1's payload — a corruption, since bytes follow.
    const at = bytes.indexOf(0x0a) + 3
    bytes[at] = (bytes[at] ?? 0) ^ 0x01
    writeFileSync(journalPath(), bytes)

    const storage = new FakeTeamStorage()
    const result = await runOnce(deps(storage))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('corrupt')
    expect(storage.events).toEqual([])
  })

  it('a TORN tail is not an abort — the records before it fold, which is the whole never-acked argument', async () => {
    writeBatch(2)
    const opened = openJournal({ path: journalPath() })
    if (!opened.ok) throw new Error(opened.error)
    opened.journal.append({
      project: 'acme-widgets',
      actorInstance: 'lane-7',
      receivedAtMs: TS,
      batch: [{ n: 3, line: COST_LINE(3, 1, TS) }],
    })
    opened.journal.close()
    const bytes = readFileSync(journalPath())
    writeFileSync(journalPath(), bytes.subarray(0, bytes.length - 5))

    const storage = new FakeTeamStorage()
    const result = await runOnce(deps(storage))
    expect(result.ok && result.records).toBe(1)
    expect(storage.events.map((e) => e.n)).toEqual([1, 2])
  })
})

describe('the cursor cold-starts on garbage rather than refusing to run', () => {
  it('64 bytes of garbage read as 0, and the fold self-repairs the file', async () => {
    writeBatch(2)
    writeFileSync(cursorPath(), Buffer.alloc(64, 0x5a))
    expect(readCursor(cursorPath()).seq).toBe(0)

    const storage = new FakeTeamStorage()
    const result = await runOnce(deps(storage))

    expect(result.ok && result.inserted).toBe(2)
    expect(readCursor(cursorPath()).seq).toBe(1)
    // The repaired file is the v1 shape, not a bare number — the fold rewrote it.
    expect(JSON.parse(readFileSync(cursorPath(), 'utf8'))).toEqual({
      version: 1,
      seq: 1,
      actors: { 'acme-widgets lane-7': 1 },
    })
  })

  it.each([['', 0], ['   ', 0], ['-1', 0], ['abc', 0], ['12', 12], ['12\n', 12]] as const)(
    'a cursor file holding %j reads as %i',
    (text, expected) => {
      writeFileSync(cursorPath(), text)
      expect(readCursor(cursorPath()).seq).toBe(expected)
    },
  )
})

/**
 * THE GRANT LAW.
 *
 * The Definition of done: *"a test asserts the upsert path uses the grants the
 * role actually holds"*. It works by extracting every `(table, verb)` pair from
 * the statements one real fold sends, and checking each against
 * `0003_roles_rls.sql`'s own `GRANT`s as `schema-law.test.ts` parses them.
 *
 * It is also what catches a future `RETURNING` on `events`: `rz_ingest` holds
 * INSERT only there, and a `RETURNING` list needs SELECT on every column it
 * names — a failure that would otherwise appear for the first time on a real
 * host, and nowhere before it.
 */

// `fileURLToPath`, not `new URL(...).pathname`: on Windows the latter yields
// `/C:/…`, which `path.join` then treats as a relative segment.
const ROLES_RLS = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'migrations', '0003_roles_rls.sql')

/** `(table, verb)` pairs a statement uses, over the verbs `0003` grants. */
export function tableVerbPairs(sql: string): { table: string; verb: string }[] {
  const pairs: { table: string; verb: string }[] = []
  for (const m of sql.matchAll(/INSERT\s+INTO\s+(\w+)/gi)) pairs.push({ table: m[1] as string, verb: 'INSERT' })
  for (const m of sql.matchAll(/UPDATE\s+(\w+)\s+SET/gi)) pairs.push({ table: m[1] as string, verb: 'UPDATE' })
  for (const m of sql.matchAll(/\bFROM\s+(\w+)/gi)) pairs.push({ table: m[1] as string, verb: 'SELECT' })
  // `ON CONFLICT ... DO UPDATE` reads the existing row and every column its
  // WHERE names: PostgreSQL requires SELECT for that, which is the grant review
  // of #360 found missing.
  for (const m of sql.matchAll(/ON\s+CONFLICT[^;]*?DO\s+UPDATE/gi)) {
    const target = /(?:INSERT\s+INTO)\s+(\w+)/i.exec(m.input.slice(0, m.index))
    if (target) {
      pairs.push({ table: target[1] as string, verb: 'SELECT' })
      pairs.push({ table: target[1] as string, verb: 'UPDATE' })
    }
  }
  return pairs
}

/** Every `(table, verb)` `rz_ingest` may perform, from the migration's own GRANTs. */
function ingestGrants(): Set<string> {
  const held = new Set<string>()
  for (const grant of grants(stripSqlComments(readFileSync(ROLES_RLS, 'utf8')))) {
    if (!grant.roles.includes('rz_ingest')) continue
    for (const table of grant.tables) for (const privilege of grant.privileges) held.add(`${privilege} ${table}`)
  }
  return held
}

/** A partition-targeted statement names `events_YYYY_MM`; the grant is on the parent. */
function toParent(table: string): string {
  return /^events_\d{4}_\d{2}$/.test(table) ? 'events' : table
}

describe('the fold uses only the grants rz_ingest actually holds', () => {
  it('the grant set is real — parsed from the migration, not hand-written here', () => {
    const held = ingestGrants()
    expect(held.size).toBeGreaterThan(0)
    expect(held.has('INSERT events')).toBe(true)
    // The one that matters, and the one the review of #360 found missing.
    expect(held.has('SELECT spend_by_project_day')).toBe(true)
    // And the one deliberately absent: ingest appends to events and never reads it.
    expect(held.has('SELECT events')).toBe(false)
  })

  it('every (table, verb) one real fold sends is a pair the role holds', async () => {
    writeBatch(3)
    const recorder = createRecordingSql()
    await runOnce(deps(createPostgresStorage(recorder.sql)))

    const held = ingestGrants()
    const used = recorder.queries.flatMap((q) => tableVerbPairs(q.sql))

    // Not vacuous: at least one pair was extracted, on more than one table.
    expect(used.length).toBeGreaterThan(0)
    expect(new Set(used.map((p) => toParent(p.table))).size).toBeGreaterThan(1)

    const missing = used
      .map((p) => `${p.verb} ${toParent(p.table)}`)
      .filter((pair) => !held.has(pair))
    expect([...new Set(missing)]).toEqual([])
  })

  it('the law bites — a planted SELECT on events is caught, and a RETURNING would be too', () => {
    const held = ingestGrants()
    const planted = tableVerbPairs('SELECT n FROM events WHERE project_id = ?')
    expect(planted).toContainEqual({ table: 'events', verb: 'SELECT' })
    expect(planted.map((p) => `${p.verb} ${toParent(p.table)}`).filter((pair) => !held.has(pair))).toEqual([
      'SELECT events',
    ])

    // The upsert extractor really fires on a DO UPDATE, so the SELECT/UPDATE
    // requirement is checked rather than assumed.
    const upsert = tableVerbPairs('INSERT INTO spend_by_project_day (a) VALUES (?) ON CONFLICT (a) DO UPDATE SET b = 1')
    expect(upsert).toContainEqual({ table: 'spend_by_project_day', verb: 'SELECT' })
    expect(upsert).toContainEqual({ table: 'spend_by_project_day', verb: 'UPDATE' })
    expect(upsert).toContainEqual({ table: 'spend_by_project_day', verb: 'INSERT' })
  })

  it('a partition target is checked against the parent grant, since GRANTs name the parent', () => {
    expect(toParent('events_2026_08')).toBe('events')
    expect(toParent('events')).toBe('events')
    expect(toParent('spend_by_project_day')).toBe('spend_by_project_day')
  })
})

/**
 * #410's REPRODUCTION, INVERTED (ruling 16).
 *
 * The bug: `runOnce` assembled every row from every record past the cursor BEFORE opening the
 * transaction and returned on the first refusal, so one line a newer sender shipped discarded
 * the records before it as well as after. Three identical passes, cursor 0, four good lines
 * landing nowhere, and the only operator escape was editing the journal by hand.
 */
const FUTURE_LINE = (n: number) =>
  JSON.stringify({
    id: `evt_${n}`,
    ts: TS,
    source: 'system',
    type: 'agent.telepathy',
    payload: { lane: 'prd51-w3', worktreePath: '/repo-wt/prd51-w3', costUsd: 42.5 },
  })

function writeRecord(project: string, actorInstance: string, batch: { n: number; line: string }[]): void {
  const opened = openJournal({ path: journalPath() })
  if (!opened.ok) throw new Error(opened.error)
  opened.journal.append({ project, actorInstance, receivedAtMs: TS, batch })
  opened.journal.close()
}

describe('an unfoldable line no longer discards the records around it', () => {
  it('[good, unfoldable, good] across three records: ALL FIVE rows land', async () => {
    // The DoD says "the four good lines land". It was written before ruling 16 settled answer
    // (2) — under the ruling the unfoldable line lands too, as a row carrying its verdict, so
    // the honest assertion is five and not four. Nothing is skipped, so there is no gap in `n`.
    writeRecord('acme-widgets', 'lane-7', [
      { n: 1, line: COST_LINE(1, 1, TS) },
      { n: 2, line: COST_LINE(2, 1, TS) },
    ])
    writeRecord('acme-widgets', 'lane-7', [{ n: 3, line: FUTURE_LINE(3) }])
    writeRecord('acme-widgets', 'lane-7', [
      { n: 4, line: COST_LINE(4, 1, TS) },
      { n: 5, line: COST_LINE(5, 1, TS) },
    ])

    const storage = new FakeTeamStorage()
    const result = await runOnce(deps(storage))

    expect(result.ok).toBe(true)
    expect(result.ok && result.refused).toEqual([])
    expect(storage.events.map((e) => e.n)).toEqual([1, 2, 3, 4, 5])
    expect(storage.events.find((e) => e.n === 3)?.unfoldable).toBe('unknown-type')
    // The money from the unvalidated payload does not reach the projection; the count does.
    expect(storage.spend.get('acme-widgets 2026-08-03')).toEqual({
      projectId: 'acme-widgets',
      day: '2026-08-03',
      costUsd: 4,
      events: 5,
    })
    expect(readCursor(cursorPath()).seq).toBe(3)
  })

  it('THE REPRODUCTION: three consecutive folds make progress instead of failing identically', async () => {
    writeRecord('acme-widgets', 'lane-7', [{ n: 1, line: COST_LINE(1, 1, TS) }])
    writeRecord('acme-widgets', 'lane-7', [{ n: 2, line: FUTURE_LINE(2) }])
    const storage = new FakeTeamStorage()

    const first = await runOnce(deps(storage))
    const second = await runOnce(deps(storage))
    const third = await runOnce(deps(storage))

    expect(first.ok && first.inserted).toBe(2)
    // Runs 2 and 3 insert nothing because there is nothing new — not because they failed.
    expect(second.ok && second.inserted).toBe(0)
    expect(third.ok && third.inserted).toBe(0)
    expect(second.ok && second.records).toBe(0)
    expect(storage.events.map((e) => e.n)).toEqual([1, 2])
    // Before this commit: cursor 0 after all three, and `cursorFile=false`.
    expect(existsSync(cursorPath())).toBe(true)
    expect(readCursor(cursorPath()).seq).toBe(2)
  })
})

describe("one actor's skew does not stop another's (ruling 16, answer 3)", () => {
  it('B lands in full while A stops at its malformed record, and `refused` names A', async () => {
    writeRecord('acme-widgets', 'lane-a', [{ n: 1, line: COST_LINE(1, 1, TS) }]) // seq 1
    writeRecord('acme-widgets', 'lane-b', [{ n: 1, line: COST_LINE(1, 1, TS) }]) // seq 2
    writeRecord('acme-widgets', 'lane-a', [{ n: 2, line: 'not an event line at all' }]) // seq 3
    writeRecord('acme-widgets', 'lane-b', [{ n: 2, line: COST_LINE(2, 1, TS) }]) // seq 4

    const storage = new FakeTeamStorage()
    const result = await runOnce(deps(storage))

    expect(result.ok).toBe(true)
    const landed = storage.events.map((e) => `${e.actorInstance}:${e.n}`).sort()
    // A's first record lands — the positions BEFORE a refusal are not a gap. A's second does
    // not. B is untouched by any of it, which is the whole of answer 3.
    expect(landed).toEqual(['lane-a:1', 'lane-b:1', 'lane-b:2'])
    expect(result.ok && result.refused).toEqual([
      { actorInstance: 'lane-a', n: 2, error: expect.stringContaining('journal seq 3') },
    ])
  })

  it('the journal cursor is the MINIMUM, so the stuck actor is re-read and the healthy one dedups', async () => {
    writeRecord('acme-widgets', 'lane-a', [{ n: 1, line: COST_LINE(1, 1, TS) }]) // seq 1
    writeRecord('acme-widgets', 'lane-b', [{ n: 1, line: COST_LINE(1, 1, TS) }]) // seq 2
    writeRecord('acme-widgets', 'lane-a', [{ n: 2, line: 'not an event line at all' }]) // seq 3
    writeRecord('acme-widgets', 'lane-b', [{ n: 2, line: COST_LINE(2, 1, TS) }]) // seq 4

    const storage = new FakeTeamStorage()
    await runOnce(deps(storage))

    // A is stuck at 1 and B reached 4, so the journal cursor is 1 — the point EVERY actor has
    // committed through. A maximum here would advance past A's unread records forever.
    const cursor = readCursor(cursorPath())
    expect(cursor.seq).toBe(1)
    expect(cursor.actors).toEqual({ 'acme-widgets lane-a': 1, 'acme-widgets lane-b': 4 })

    // The second pass re-reads B's span because of that minimum, and inserts nothing: the
    // per-actor marks skip the records before a row is ever built.
    const second = await runOnce(deps(storage))
    expect(second.ok && second.inserted).toBe(0)
    expect(storage.events.length).toBe(3)
    expect(readCursor(cursorPath()).seq).toBe(1)
  })
})

/**
 * THE REVIEW-OF-#417 FINDING, END TO END.
 *
 * `projections.test.ts` asserts an unfoldable row adds no lane — but it hand-builds the row with
 * `lane: null`, so it bypasses `row.ts` and CANNOT fail if the upstream nulling is removed.
 * Measured: with `laneOf`/`worktreeOf` restored on the unfoldable arm, that suite stayed green
 * and only the two `row.test.ts` cases went red. This case closes the half the ruling's own
 * amendment exists to correct — it folds a real journal, so the nulling is on the path.
 */
describe('an unfoldable payload reaches no projection, through the whole fold', () => {
  it('lane_state gets nothing from a line whose payload plainly carries a lane', async () => {
    // FUTURE_LINE's payload carries `lane: 'prd51-w3'`, `worktreePath` and `costUsd: 42.5` —
    // all three readable, so every assertion below is a decision rather than an empty fixture.
    writeRecord('acme-widgets', 'lane-7', [{ n: 1, line: FUTURE_LINE(1) }])

    const storage = new FakeTeamStorage()
    const result = await runOnce(deps(storage))

    expect(result.ok && result.inserted).toBe(1)
    expect(storage.events[0]?.unfoldable).toBe('unknown-type')
    // The three the ruling names, all measured against a payload that carries each one.
    expect([...storage.lanes.values()]).toEqual([])
    expect([...storage.collisions.values()]).toEqual([])
    expect(storage.spend.get('acme-widgets 2026-08-03')).toEqual({
      projectId: 'acme-widgets',
      day: '2026-08-03',
      costUsd: 0,
      events: 1,
    })
    // And the row itself carries no derived column, which is where the nulling happened.
    expect(storage.events[0]?.lane).toBeNull()
    expect(storage.events[0]?.worktree).toBeNull()
  })

  it('the control: a FOLDABLE line with the same lane does populate lane_state', async () => {
    writeRecord('acme-widgets', 'lane-7', [{ n: 1, line: COST_LINE(1, 1, TS) }])
    const storage = new FakeTeamStorage()
    await runOnce(deps(storage))
    expect([...storage.lanes.values()].map((l) => l.lane)).toEqual(['prd51-w3'])
  })
})
