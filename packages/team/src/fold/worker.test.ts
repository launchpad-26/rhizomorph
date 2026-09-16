import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FoldFaults } from '../ingest/faults.js'
import { startTeamServer } from '../api/main.js'
import { resolveTeamConfig } from '../config/config.js'
import { INGEST_KEY_HEADER } from '../ingest/handle.js'
import { openJournal } from '../journal/journal.js'
import { hashIngestKey } from '../keys/hash.js'
import { mintIngestKey } from '../keys/mint.js'
import { grants, stripSqlComments } from '../migrations/schema-law.test.js'
import { FakeTeamStorage } from '../storage/fake.js'
import { createPostgresStorage } from '../storage/postgres.js'
import { createRecordingSql } from '../storage/recording-sql.js'
import { readCursor } from './cursor.js'
import { type FoldResult, runOnce, startFoldWorker } from './worker.js'

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
    // The repaired file is the v1 shape, not a bare number — the fold rewrote it. `actors` is
    // EMPTY on a clean pass: every actor reached the head of what was read, so every per-actor
    // mark equals `seq` and says nothing `seq` does not. `readCursor`'s own `?? cursor.seq`
    // fallback reconstructs each one unchanged — asserted directly in the next case, so this is
    // a claim about redundancy rather than about loss.
    expect(JSON.parse(readFileSync(cursorPath(), 'utf8'))).toEqual({
      version: 1,
      seq: 1,
      actors: {},
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
    // Only lane-b is carried. lane-a's mark IS the low-water mark, so writing it down would
    // repeat `seq`; what has to survive is lane-b's 4, which is what stops its span being
    // re-derived on the re-read below.
    expect(cursor.actors).toEqual({ 'acme-widgets lane-b': 4 })
    // And the omission is lossless, through the reader the fold actually uses.
    expect(cursor.actors['acme-widgets lane-a'] ?? cursor.seq).toBe(1)

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

/**
 * A RETIRED ACTOR IS NOT A STUCK ONE (review of #446).
 *
 * The skew tests above cover an actor that REFUSES. This is the other way an actor stops
 * appearing, and it is the ordinary one: the session ended. `actorInstance` is the session id
 * (`packages/server/src/shipper/cursor.ts` says so of its own `actors` map), so a deployment
 * accumulates one per session forever — and while every carried-forward actor was seeded at its
 * old mark, `lowWaterMark`'s minimum sat at the final seq of the FIRST session to go quiet, on a
 * journal `journal.ts` records as growing without bound. Nothing refused, every row landed, and
 * the fold re-read the whole journal on every tick with the cursor frozen.
 *
 * The distinction the fix turns on: a group that folded everything it had is committed through
 * the head of what was read, whether or not it ever appears again. Only a group that STOPPED may
 * sit below it.
 */
describe('a session that ended does not hold the journal back', () => {
  it('twelve sessions later the cursor is at the head, and the read is one record, not thirteen', async () => {
    const storage = new FakeTeamStorage()

    writeRecord('acme-widgets', 'session-1', [{ n: 1, line: COST_LINE(1, 1, TS) }]) // seq 1
    const first = await runOnce(deps(storage))
    expect(first.ok && first.refused).toEqual([])
    expect(readCursor(cursorPath()).seq).toBe(1)

    // session-1's process is gone for good. Every later session is a new actorInstance.
    for (let s = 2; s <= 13; s += 1) {
      writeRecord('acme-widgets', `session-${s}`, [{ n: 1, line: COST_LINE(s, 1, TS) }])
      const pass = await runOnce(deps(storage))
      expect(pass.ok && pass.refused).toEqual([])
      expect(pass.ok && pass.inserted).toBe(1)
    }

    const cursor = readCursor(cursorPath())
    expect(cursor.seq).toBe(13)
    // Nothing is behind, so nothing needs a per-actor entry — the file does not carry one row
    // per session this deployment has ever run.
    expect(cursor.actors).toEqual({})

    // THE MEASUREMENT THE BUG WAS: a fourteenth session reads ONE record. Before the fix this
    // read 14, and would have read every record ever journalled, on every tick, forever.
    writeRecord('acme-widgets', 'session-14', [{ n: 1, line: COST_LINE(14, 1, TS) }])
    const last = await runOnce(deps(storage))
    expect(last.ok && last.records).toBe(1)
    expect(storage.events.length).toBe(14)
  })

  it('ONE PASS, TWO ACTORS, NOTHING STUCK: the cursor reaches the head rather than the earlier one', async () => {
    // The case the sessions above cannot reach, because they arrive one per pass. When two
    // actors are interleaved in ONE read and neither stops, a minimum over "the seq each last
    // appeared at" sits on lane-a's 1 and re-reads lane-b's span next tick, for no reason: both
    // folded everything they were shown.
    writeRecord('acme-widgets', 'lane-a', [{ n: 1, line: COST_LINE(1, 1, TS) }]) // seq 1
    writeRecord('acme-widgets', 'lane-b', [{ n: 1, line: COST_LINE(2, 1, TS) }]) // seq 2
    writeRecord('acme-widgets', 'lane-b', [{ n: 2, line: COST_LINE(3, 1, TS) }]) // seq 3

    const storage = new FakeTeamStorage()
    const first = await runOnce(deps(storage))
    expect(first.ok && first.refused).toEqual([])
    expect(first.ok && first.inserted).toBe(3)

    const cursor = readCursor(cursorPath())
    expect(cursor.seq).toBe(3)
    expect(cursor.actors).toEqual({})

    // Nothing left behind to re-read. A minimum taken over last-appearance would have read two.
    const second = await runOnce(deps(storage))
    expect(second.ok && second.records).toBe(0)
  })

  it('THE CONTROL: a genuinely stuck actor still pins it, and still re-reads the healthy span', async () => {
    // Same shape as above — one actor goes quiet after seq 1 — except the reason is a refusal.
    // Without this pair, "the cursor reached the head" could be a fold that stopped holding
    // anything back at all, which is the money-losing direction.
    writeRecord('acme-widgets', 'lane-a', [{ n: 1, line: COST_LINE(1, 1, TS) }]) // seq 1
    writeRecord('acme-widgets', 'lane-a', [{ n: 2, line: 'not an event line at all' }]) // seq 2
    writeRecord('acme-widgets', 'lane-b', [{ n: 1, line: COST_LINE(2, 1, TS) }]) // seq 3

    const storage = new FakeTeamStorage()
    const result = await runOnce(deps(storage))

    expect(result.ok && result.refused.map((entry) => entry.actorInstance)).toEqual(['lane-a'])
    const cursor = readCursor(cursorPath())
    expect(cursor.seq).toBe(1)
    expect(cursor.actors).toEqual({ 'acme-widgets lane-b': 3 })

    const second = await runOnce(deps(storage))
    expect(second.ok && second.records).toBe(2)
    expect(second.ok && second.inserted).toBe(0)
    expect(readCursor(cursorPath()).seq).toBe(1)
  })
})

/**
 * THE SUPERVISOR (#564) — the gap was that nothing called `runOnce`.
 *
 * Every case above proves the fold PASS is correct. None of them proved anything CALLS it, and
 * on the real host (#514) nothing did: batches were accepted, journalled and acked, and `events`
 * stayed empty. These cases are about the thing that calls it.
 *
 * No case here sleeps on a real timer — `setTimer`/`clearTimer` are injected everywhere a tick
 * is involved, and `tickMs` defaults to 0 (disabled) otherwise.
 */
describe('#564 — the fold worker runs, and drains', () => {
  /** Counts one entry per `runOnce`, which is what `onResult` is called once per. */
  function counting(): { results: FoldResult[]; onResult: (r: FoldResult) => void } {
    const results: FoldResult[] = []
    return { results, onResult: (r) => results.push(r) }
  }

  it('THE GAP: a journalled batch reaches events only because something drains it', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(3)

    // The deployed state before this issue: a journal with records and nothing folding them.
    expect(storage.events).toEqual([])

    const worker = startFoldWorker({ ...deps(storage) })
    await worker.drain()
    await worker.stop()

    // Read the ROWS, not a 202. That is the issue's Definition of done in one line.
    expect(storage.events.map((e) => e.n)).toEqual([1, 2, 3])
    expect(storage.spend.get('acme-widgets 2026-08-03')?.events).toBe(3)
  })

  it('the boot drain folds what arrived while no worker existed', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(2, 1)
    writeBatch(2, 3)
    writeBatch(1, 5)

    // Constructed only now — everything above predates the worker entirely.
    const worker = startFoldWorker({ ...deps(storage) })
    await worker.drain()
    await worker.stop()

    expect(storage.events.map((e) => e.n)).toEqual([1, 2, 3, 4, 5])
  })

  it('a replayed batch produces ONE row, not two', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(2)
    const worker = startFoldWorker({ ...deps(storage) })
    await worker.drain()
    writeBatch(2) // the identical batch again, at a new journal seq
    await worker.drain()
    await worker.stop()

    expect(storage.events.map((e) => e.n)).toEqual([1, 2])
    expect(storage.spend.get('acme-widgets 2026-08-03')?.events).toBe(2)
  })

  it('REPETITION — draining three times folds once and calls appendEvents once', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(3)
    const worker = startFoldWorker({ ...deps(storage) })
    await worker.drain()
    await worker.drain()
    await worker.drain()
    await worker.stop()

    expect(storage.events.map((e) => e.n)).toEqual([1, 2, 3])
    expect(storage.calls.filter((c) => c === 'appendEvents').length).toBe(1)
  })

  it('a restart resumes from the cursor: it does not re-fold, and does not skip', async () => {
    const first = new FakeTeamStorage()
    writeBatch(2, 1)
    const a = startFoldWorker({ ...deps(first) })
    await a.drain()
    await a.stop()
    expect(first.events.map((e) => e.n)).toEqual([1, 2])

    // A SECOND worker over the SAME cursor path — the container restart, at file level.
    const second = new FakeTeamStorage()
    writeBatch(1, 3)
    const b = startFoldWorker({ ...deps(second) })
    await b.drain()
    await b.stop()

    // Only the new record folded: the first two are not re-read into this storage.
    expect(second.events.map((e) => e.n)).toEqual([3])
  })

  it('TERMINATES on a permanently stuck group rather than spinning — the cursor is the loop condition', async () => {
    const storage = new FakeTeamStorage()
    const opened = openJournal({ path: journalPath() })
    if (!opened.ok) throw new Error(opened.error)
    opened.journal.append({
      project: 'acme-widgets',
      actorInstance: 'lane-7',
      receivedAtMs: TS,
      batch: [{ n: 1, line: 'this is not an event at all' }],
    })
    opened.journal.close()

    const { results, onResult } = counting()
    const worker = startFoldWorker({ ...deps(storage), onResult })

    // The assertion is that this RETURNS. Written `while (records > 0)` it never does:
    // `runOnce` reports records > 0 with the cursor unmoved for exactly this input.
    await worker.drain()
    await worker.stop()

    expect(storage.events).toEqual([])
    expect(results.length).toBe(1)
    expect(results[0]?.ok && results[0].refused.map((r) => r.n)).toEqual([1])
    expect(readCursor(cursorPath()).seq).toBe(0)
  })

  it('COALESCING — two wakes during one in-flight pass produce one follow-up pass, not two', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(1)

    // Hold the first appendEvents open so both wakes land while a pass is genuinely in flight.
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const gated = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop !== 'appendEvents') return Reflect.get(target, prop, receiver)
        return async (...args: Parameters<FakeTeamStorage['appendEvents']>) => {
          if (first) {
            first = false
            await held
          }
          return target.appendEvents(...args)
        }
      },
    }) as FakeTeamStorage

    const { results, onResult } = counting()
    const worker = startFoldWorker({ ...deps(gated), onResult })
    const boot = worker.drain()

    worker.wake()
    worker.wake()
    release()
    await boot
    await worker.stop()

    // Three runOnce calls total: the held one, the one its own loop takes after the cursor
    // advanced, and ONE follow-up for both wakes. Without coalescing each wake starts its own.
    expect(results.length).toBe(3)
    expect(storage.events.map((e) => e.n)).toEqual([1])
  })

  /**
   * THE SIBLING CASE, and the first version of this test did not have it.
   *
   * I first wrote this against a storage whose `appendEvents` throws — and the mutation proved
   * it vacuous: removing `wake()`'s `.catch()` left all 80 green, because `runOnce` catches its
   * own storage failure and returns `ok: false`. Nothing inside a fold pass rejects, so the
   * guard was unreachable by that input and the test asserted nothing.
   *
   * The reachable one is a **throwing subscriber** — `onResult` is called outside `runOnce` and
   * its exception escapes `pass()`. `deploy/serve.ts` passes a real `onResult` that writes to
   * the console. That is the shape AGENTS.md names as this repo's commonest defect: a seal
   * released on a failed write but not on a throwing subscriber.
   */
  it('wake() never throws into the ingest hot path, even when a subscriber does', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(1)
    const worker = startFoldWorker({
      ...deps(storage),
      onResult: () => {
        throw new Error('the operator log is on fire')
      },
    })

    // `notify` is synchronous and on the hot path: a throw here refuses a batch that was
    // already durably journalled and acked, which inverts ruling 4.
    expect(worker.wake()).toBeUndefined()
    await expect(worker.stop()).resolves.toBeUndefined()
  })

  it('a fold failure is reported through onResult rather than thrown', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(1)
    const exploding = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop !== 'appendEvents') return Reflect.get(target, prop, receiver)
        return async () => {
          throw new Error('database is on fire')
        }
      },
    }) as FakeTeamStorage

    const { results, onResult } = counting()
    const worker = startFoldWorker({ ...deps(exploding), onResult })
    await worker.drain()
    await worker.stop()

    expect(results.some((r) => !r.ok)).toBe(true)
    expect(storage.events).toEqual([])
  })

  it('tickMs 0 arms no timer at all — which is what keeps this suite off real clocks', async () => {
    const storage = new FakeTeamStorage()
    const armed: number[] = []
    const worker = startFoldWorker({
      ...deps(storage),
      tickMs: 0,
      setTimer: (_fn, ms) => {
        armed.push(ms)
        return 0
      },
      clearTimer: () => undefined,
    })
    await worker.drain()
    await worker.stop()
    expect(armed).toEqual([])
  })

  /**
   * THE TICK MUST NOT PRECEDE THE BOOT DRAIN (#564, found at verification).
   *
   * `arm()` used to run in `startFoldWorker`'s body. `deploy/serve.ts` constructs the worker
   * before `startTeamServer`, which re-runs the migration preflight and tops up the monthly
   * partitions before listening — so with the production default of 5000 ms a slow startup fired
   * a fold before the partitions existed, and on the first boot of a new month those rows have
   * nowhere to land.
   *
   * This is the case that would have caught it: a real timer, a short interval, and no drain.
   */
  it('NO timer is armed until the first drain — construction alone must not fold', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(1)
    const armed: number[] = []
    const worker = startFoldWorker({
      ...deps(storage),
      tickMs: 20,
      setTimer: (_fn, ms) => {
        armed.push(ms)
        return armed.length
      },
      clearTimer: () => undefined,
    })

    expect(armed).toEqual([])
    expect(storage.events).toEqual([])

    await worker.drain()
    await worker.stop()

    // Armed only once the drain it follows had settled.
    expect(armed).toEqual([20])
    expect(storage.events.map((e) => e.n)).toEqual([1])
  })

  it('a real timer does not fire a fold before the first drain either', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(1)
    // No injected timer: the production path, with an interval far shorter than the wait below.
    const worker = startFoldWorker({ ...deps(storage), tickMs: 5 })
    await new Promise((resolve) => setTimeout(resolve, 80))

    // This is the assertion. Before the fix it read `expected 1 to be +0`.
    expect(storage.events).toEqual([])

    await worker.drain()
    await worker.stop()
    expect(storage.events.map((e) => e.n)).toEqual([1])
  })

  it('a non-numeric tick is treated as disabled, not as a 1ms hot loop', async () => {
    const storage = new FakeTeamStorage()
    const armed: number[] = []
    const worker = startFoldWorker({
      ...deps(storage),
      // What `Number(process.env.RZ_TEAM_FOLD_TICK_MS)` gives for "5s". `NaN <= 0` is FALSE, and
      // `setTimeout(fn, NaN)` is clamped to 1ms — 145 drains in 200ms, measured.
      tickMs: Number('5s'),
      setTimer: (_fn, ms) => {
        armed.push(ms)
        return armed.length
      },
      clearTimer: () => undefined,
    })
    await worker.drain()
    await worker.stop()
    expect(armed).toEqual([])
  })

  it('STOP IS FINAL — a wake after stop() does not start another pass', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(1, 1)
    const worker = startFoldWorker({ ...deps(storage) })
    await worker.drain()
    await worker.stop()

    // Reachable from `serve.ts`: shutdown stops the worker BEFORE closing the server, so an
    // in-flight request can ack and wake after stop resolved — and `sql.end()` follows.
    writeBatch(1, 2)
    worker.wake()
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(storage.events.map((e) => e.n)).toEqual([1])
  })

  it('stop() awaits a pass that is genuinely in flight, including one started late', async () => {
    const storage = new FakeTeamStorage()
    writeBatch(2)
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    const gated = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop !== 'appendEvents') return Reflect.get(target, prop, receiver)
        return async (...args: Parameters<FakeTeamStorage['appendEvents']>) => {
          if (first) {
            first = false
            await held
          }
          return target.appendEvents(...args)
        }
      },
    }) as FakeTeamStorage

    const worker = startFoldWorker({ ...deps(gated) })
    const pending = worker.drain()
    const stopping = worker.stop()
    release()
    await Promise.all([pending, stopping])

    // stop() returned only after the held pass committed.
    expect(storage.events.map((e) => e.n)).toEqual([1, 2])
  })

  it('a throwing cursor WRITE does not become an unhandled rejection that kills the process', async () => {
    const storage = new FakeTeamStorage()

    /**
     * THE UNCAUGHT PATH, which the first version of this case did not reach.
     *
     * `runOnce`'s docblock says it never throws, and it is NEARLY true: the `rows.length === 0`
     * branch writes the cursor OUTSIDE its own try/catch. Reaching it needs a pass that advances
     * the cursor while producing no rows — an EMPTY batch, which the journal accepts because this
     * harness appends directly and `protocol.ts`'s `min(1)` guards the wire, not the file.
     *
     * Delta verification found the earlier version pointing at the CAUGHT `writeCursor`, so
     * deleting `loop`'s rejection handler left the suite green: a case that could not fail for
     * the reason it claimed.
     */
    const opened = openJournal({ path: journalPath() })
    if (!opened.ok) throw new Error(opened.error)
    opened.journal.append({ project: 'acme-widgets', actorInstance: 'lane-7', receivedAtMs: TS, batch: [] })
    opened.journal.close()

    const doomed = { ...deps(storage), cursorPath: path.join(dir, 'no-such-dir', 'fold.cursor') }
    // The control: this really is the uncaught branch, and it really does throw.
    await expect(runOnce(doomed)).rejects.toThrow()

    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      const worker = startFoldWorker(doomed)
      worker.wake()
      await new Promise((resolve) => setTimeout(resolve, 40))
      await worker.stop().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(rejections).toEqual([])
  })
})

/**
 * THE SEAM ITSELF (#564) — an accepted batch reaches `events`, read as a ROW.
 *
 * Every case above drives `startFoldWorker` directly against a journal this harness wrote. That
 * proves the supervisor and proves nothing about the thing this issue exists to create: that
 * something in the DEPLOYMENT calls it. Found at verification — deleting
 * `onBatch: () => worker.wake()` from `deploy/serve.ts`, which is exactly the #514 bug, left the
 * whole package green, and so did deleting the boot drain.
 *
 * `deploy/serve.ts` has no test anywhere in the repo and cannot easily get one: it opens a real
 * Postgres connection in `main()`. So this closes the gap in two halves — the BEHAVIOUR through a
 * real `startTeamServer` here, and the WIRING as a law over the tracked source below. Neither is
 * sufficient alone: the first would pass with serve.ts wiring nothing, the second would pass if
 * the seam did not work.
 */
describe('#564 — the seam, end to end and as shipped', () => {
  const MINTED = mintIngestKey({ projectId: 'acme-widgets', nowMs: TS })
  const KEY = MINTED.takePlaintext()

  it('a batch POSTed to the running server reaches events — the ROW, not the 202', async () => {
    const storage = new FakeTeamStorage({ settings: { synchronous_commit: 'on' } })
    await storage.insertIngestKey({
      keyHash: MINTED.row.keyHash,
      projectId: 'acme-widgets',
      createdAtMs: TS,
      revokedAtMs: null,
    })

    // Wired exactly as `deploy/serve.ts` wires it: the worker first, `onBatch` to its wake.
    const worker = startFoldWorker({ ...deps(storage), journalPath: journalPath() })
    const started = await startTeamServer({
      storage,
      config: resolveTeamConfig({}),
      journalPath: journalPath(),
      port: 0,
      now: () => TS,
      onBatch: () => worker.wake(),
    })
    if (!started.ok) throw new Error(started.error)

    try {
      const response = await fetch(`http://${started.server.host}:${started.server.port}/v1/rhizomorph/ingest`, {
        method: 'POST',
        headers: { [INGEST_KEY_HEADER]: KEY },
        body: JSON.stringify({
          protocolVersion: 1,
          project: 'acme-widgets',
          actorInstance: 'lane-7',
          batch: [{ n: 1, line: COST_LINE(1, 1, TS) }],
        }),
      })
      expect(response.status).toBe(202)

      // The wake is fire-and-forget by design, so settle the fold before reading.
      await worker.drain()

      // THE ASSERTION THIS ISSUE IS ABOUT. Before #564 this was `[]` on a real host, with the
      // records on disk and the 202 already returned.
      expect(storage.events.map((e) => e.n)).toEqual([1])
      expect(storage.spend.get('acme-widgets 2026-08-03')?.events).toBe(1)
      expect(storage.keyLookups).toEqual([hashIngestKey(KEY)])
    } finally {
      await worker.stop()
      await started.server.close()
    }
  })

  /**
   * THE WIRING, AS A LAW OVER THE TRACKED SOURCE.
   *
   * `deploy/serve.ts` is the one file that turns the seam above into a running deployment, and it
   * is untestable by execution without a database. Reading it is weaker than running it and this
   * says so — but it is the difference between the #514 regression being caught and being
   * invisible, which is what verification measured.
   */
  it('deploy/serve.ts wires onBatch to the worker AND drains at boot', () => {
    const raw = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'serve.ts'),
      'utf8',
    ).replace(/\r\n/g, '\n')

    /**
     * COMMENTS ARE STRIPPED FIRST, and that is load-bearing (found at delta verification).
     *
     * The first version asserted against the raw text and claimed in a comment that "the comment
     * bodies in that file do not contain these spellings" — true when written, and a property
     * nothing held. EXECUTED: deleting the real `onBatch` wiring and planting ONE decoy comment
     * carrying the asserted strings left all 146 cases GREEN. A law that reads a file's prose
     * acquits it for explaining itself; `migrations/schema-law.test.ts` records the same trap and
     * strips for the same reason.
     */
    const serve = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(serve, 'the stripper must not eat the code').toContain('async function main()')
    expect(raw.length, 'serve.ts carries comments, so the strip is not a no-op').toBeGreaterThan(serve.length)
    expect(serve, 'serve.ts must construct the fold worker').toContain('startFoldWorker({')
    expect(serve, 'serve.ts must wake the worker on every accepted batch (#514)').toContain(
      'onBatch: () => worker.wake(),',
    )
    expect(serve, 'serve.ts must drain the journal at boot').toContain('await worker.drain()')
    /**
     * Whitespace-insensitive, and this is the SECOND attempt at that.
     *
     * The first spelling pinned six spaces of indentation. The repair —
     * `serve.replace(/\s+/g, ' ')` then `toContain('worker .stop()')` — was insensitive to HOW
     * MUCH whitespace, not to whether there is any: `worker.stop()` collapses to itself and does
     * not contain `worker .stop()`, so a formatter putting the chain on one line still reddened a
     * law about wiring. Same failure, one size smaller, found in the review of #574.
     */
    expect(serve, 'shutdown must stop the worker').toMatch(/worker\s*\.stop\(\)/)

    /**
     * The ORDER is the ADR-0056 claim: the boot drain follows `startTeamServer`, because that
     * call tops up the monthly partitions and the fold issues no DDL.
     *
     * Both anchors are asserted present FIRST. `indexOf` returns -1 when absent, and -1 is less
     * than any real index — so with `startTeamServer` missing the comparison passed vacuously,
     * asserting an ordering between a line and a thing that was not there.
     */
    const drainAt = serve.indexOf('await worker.drain()')
    const startAt = serve.indexOf('await startTeamServer({')
    expect(drainAt, 'the boot drain must be present to be ordered').toBeGreaterThan(-1)
    expect(startAt, 'startTeamServer must be present to be ordered').toBeGreaterThan(-1)
    expect(drainAt).toBeGreaterThan(startAt)
  })
})
