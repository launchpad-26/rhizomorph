import { describe, expect, it } from 'vitest'
import type { TeamStorage } from './contract.js'
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
    const row = {
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
    expect(await fake.appendEvents([{ ...row, n: 1 }, { ...row, n: 2 }, { ...row, n: 9 }])).toBe(3)
    const read = await fake.readEvents({ projectId: 'acme-widgets', actorInstance: 'lane-7', fromN: 1, toN: 2 })
    expect(read.map((e) => e.n)).toEqual([1, 2])
  })

  it('de-duplicates monthly partition top-ups, as an IF NOT EXISTS would', async () => {
    const fake = new FakeTeamStorage()
    await fake.ensureMonthlyPartition('2026-09')
    await fake.ensureMonthlyPartition('2026-09')
    await fake.ensureMonthlyPartition('2026-10')
    expect(fake.partitions).toEqual(['2026-09', '2026-10'])
  })
})
