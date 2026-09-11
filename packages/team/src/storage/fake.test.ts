import { describe, expect, it } from 'vitest'
import type { EventRow, TeamStorage } from './contract.js'
import { FakeTeamStorage } from './fake.js'
import { createPostgresStorage } from './postgres.js'
import { createRecordingSql } from './recording-sql.js'

/**
 * THE DOUBLE IS NOT KINDER THAN THE REAL THING.
 *
 * `runner.test.ts`'s mid-run-failure and checksum-change cases are only
 * meaningful if the fake fails the way the adapter does. A double that
 * committed a bookkeeping row for a migration whose body threw would make every
 * one of those tests pass while proving nothing — the runner would look correct
 * against a database that cannot exist.
 *
 * So the atomicity property is asserted here on BOTH implementations, from the
 * same premise: a failing migration body leaves no `_migrations` row.
 */

/** One row, minus its position. `n` is supplied per assertion because it is the dedup key. */
const FAKE_ROW: Omit<EventRow, 'n'> = {
  projectId: 'acme-widgets',
  actorInstance: 'lane-7',
  eventId: 'evt',
  tsMs: 0,
  type: 't',
  source: 's',
  lane: null,
  worktree: null,
  payload: {},
  line: 'x',
}

describe('case 35 — the fake is a TeamStorage, and it is atomic in the same sense', () => {
  it('satisfies the port', () => {
    const storage: TeamStorage = new FakeTeamStorage()
    expect(typeof storage.readSetting).toBe('function')
    expect(typeof storage.appendEvents).toBe('function')
    expect(typeof storage.ensureMonthlyPartition).toBe('function')
  })

  it('a throwing migration records no bookkeeping row', async () => {
    const fake = new FakeTeamStorage({ failApply: ['0002_projections'] })
    await fake.ensureMigrationsTable()
    await fake.applyMigration({ id: '0001_events', checksum: 'a', sql: '' })
    await expect(fake.applyMigration({ id: '0002_projections', checksum: 'b', sql: '' })).rejects.toThrow()

    expect(fake.committed).toEqual(['0001_events'])
    expect(await fake.listAppliedMigrations()).toEqual([
      { id: '0001_events', checksum: 'a', appliedAt: '1970-01-01T00:00:00.000Z' },
    ])
  })

  it('…and so does the real adapter, which is the claim that makes the fake usable', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    recorder.scriptFailure(new Error('relation "events" already exists'))

    await expect(storage.applyMigration({ id: '0002_projections', checksum: 'b', sql: 'CREATE TABLE x ()' })).rejects.toThrow()

    expect(recorder.queries.some((q) => q.sql.includes('INTO _migrations'))).toBe(false)
    expect(recorder.log).toContain('ROLLBACK')
  })

  it('refuses to list or apply before the bookkeeping table exists, as Postgres would', async () => {
    const fake = new FakeTeamStorage()
    await expect(fake.listAppliedMigrations()).rejects.toThrow('_migrations')
    await expect(fake.applyMigration({ id: '0001_events', checksum: 'a', sql: '' })).rejects.toThrow('_migrations')
  })

  it('records every call, in order, with the migration id attached', async () => {
    const fake = new FakeTeamStorage({ settings: { synchronous_commit: 'on' } })
    await fake.readSetting('synchronous_commit')
    await fake.ensureMigrationsTable()
    await fake.listAppliedMigrations()
    await fake.applyMigration({ id: '0001_events', checksum: 'a', sql: '' })
    await fake.close()

    expect(fake.calls).toEqual([
      'readSetting',
      'ensureMigrationsTable',
      'listAppliedMigrations',
      'applyMigration:0001_events',
      'close',
    ])
    expect(fake.closed).toBe(true)
  })

  it('stores and reads back events within the requested window only', async () => {
    const fake = new FakeTeamStorage()
    const row = FAKE_ROW
    expect(await fake.appendEvents([{ ...row, n: 1 }, { ...row, n: 2 }, { ...row, n: 9 }])).toBe(3)
    const read = await fake.readEvents({ projectId: 'acme-widgets', actorInstance: 'lane-7', fromN: 1, toN: 2 })
    expect(read.map((e) => e.n)).toEqual([1, 2])
  })

  /**
   * The second place this file's premise bites, added with the ingest lane.
   *
   * The adapter dedups on `(project_id, actor_instance, n)` through each
   * partition's unique index. A double that appended unconditionally would make
   * every replay test above it a lie: the fold's whole rewind argument is *"a
   * replay costs time, not rows"*, and against a duplicating double a test
   * asserting N rows after two folds would have to assert 2N to pass — that is,
   * it would certify the defect it exists to catch.
   */
  it('the fake dedups on (projectId, actorInstance, n) and reports what actually landed', async () => {
    const fake = new FakeTeamStorage()

    expect(await fake.appendEvents([{ ...FAKE_ROW, n: 1 }, { ...FAKE_ROW, n: 2 }])).toBe(2)
    // The same positions again: nothing lands, and the count says so.
    expect(await fake.appendEvents([{ ...FAKE_ROW, n: 1 }, { ...FAKE_ROW, n: 2 }])).toBe(0)
    expect(fake.events.length).toBe(2)
    // A different actor at the same positions is a different key.
    expect(await fake.appendEvents([{ ...FAKE_ROW, actorInstance: 'lane-8', n: 1 }])).toBe(1)
    expect(fake.events.length).toBe(3)
  })

  it('…and the real adapter dedups the same way, which is what makes the fake usable', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    recorder.scriptCount(0)
    recorder.scriptCount(0)

    const written = await storage.appendEvents([
      { ...FAKE_ROW, n: 1 },
      { ...FAKE_ROW, n: 2 },
    ])

    expect(written).toBe(0)
    const insert = recorder.queries.find((q) => q.sql.includes('INTO events'))
    expect(insert?.sql).toContain('ON CONFLICT (project_id, actor_instance, n) DO NOTHING')
  })

  it('the projection callback runs against the rows that landed, not the batch', async () => {
    const fake = new FakeTeamStorage()
    const seen: number[][] = []
    const nothing = { spend: [], lanes: [], collisions: [] }

    await fake.appendEvents([{ ...FAKE_ROW, n: 1 }], (inserted) => {
      seen.push(inserted.map((r) => r.n))
      return nothing
    })
    await fake.appendEvents([{ ...FAKE_ROW, n: 1 }], (inserted) => {
      seen.push(inserted.map((r) => r.n))
      return nothing
    })

    // First fold: the row landed. Second: it did not, so the delta covers nothing.
    expect(seen).toEqual([[1], []])
  })

  it('the fake sums spend and refuses to rewind a lane, exactly as the upserts do', async () => {
    const fake = new FakeTeamStorage()
    await fake.appendEvents([{ ...FAKE_ROW, n: 1 }], () => ({
      spend: [{ projectId: 'p', day: '2026-08-03', costUsd: 1.5, events: 1 }],
      lanes: [{ projectId: 'p', lane: 'l', state: 'working', worktree: 'wt', lastEventTsMs: 100 }],
      collisions: [{ projectId: 'p', path: 'a.ts', lanes: ['x'], firstSeenMs: 100, lastSeenMs: 100 }],
    }))
    await fake.appendEvents([{ ...FAKE_ROW, n: 2 }], () => ({
      spend: [{ projectId: 'p', day: '2026-08-03', costUsd: 0.5, events: 1 }],
      // An older arrival: it must not overwrite `working`.
      lanes: [{ projectId: 'p', lane: 'l', state: 'done', worktree: null, lastEventTsMs: 50 }],
      collisions: [{ projectId: 'p', path: 'a.ts', lanes: ['y'], firstSeenMs: 50, lastSeenMs: 150 }],
    }))

    expect(fake.spend.get('p 2026-08-03')).toEqual({ projectId: 'p', day: '2026-08-03', costUsd: 2, events: 2 })
    expect(fake.lanes.get('p l')?.state).toBe('working')
    expect(fake.lanes.get('p l')?.lastEventTsMs).toBe(100)
    expect(fake.collisions.get('p a.ts')).toEqual({
      projectId: 'p',
      path: 'a.ts',
      lanes: ['x', 'y'],
      firstSeenMs: 50,
      lastSeenMs: 150,
    })
  })

  it('de-duplicates monthly partition top-ups, as an IF NOT EXISTS would', async () => {
    const fake = new FakeTeamStorage()
    await fake.ensureMonthlyPartition('2026-09')
    await fake.ensureMonthlyPartition('2026-09')
    await fake.ensureMonthlyPartition('2026-10')
    expect(fake.partitions).toEqual(['2026-09', '2026-10'])
  })
})
