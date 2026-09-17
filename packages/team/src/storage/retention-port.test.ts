import { describe, expect, it } from 'vitest'
import { FakeTeamStorage } from './fake.js'
import type { RetentionCeiling } from './ports/retention/port.js'
import { NO_CEILING_SOURCE, RETENTION_QUOTA_GAP } from './ports/retention/port.js'
import { createRetentionSql } from './ports/retention/sql.js'
import { createRecordingSql } from './recording-sql.js'

/**
 * THE RETENTION PORT, FROM BOTH SIDES (#559, prd-51 rulings 9, 10 and B).
 *
 * This file lives here rather than under `ports/retention/` because
 * `composition-law.test.ts` case 1 pins every port directory to exactly
 * `fake.ts`, `port.ts` and `sql.ts` — a port's tests have no home inside it by
 * construction, which is deliberate and is why this file's path is a recorded
 * fence widening on #559 rather than an accident.
 *
 * Two layers, and the split is `recording-sql.ts`'s own: the **adapter** is
 * asserted on what it SENDS and what it BINDS, and the **fake** on what it does
 * to state. Nothing here needs a database.
 */

const CEILING: RetentionCeiling = {
  projectId: 'acme-widgets',
  maxAgeDays: 30,
  archiveBeforeDrop: false,
  archiveDir: null,
  setBy: 'operator',
  source: 'packages/team/deploy/ceiling.ts',
  setAtMs: Date.UTC(2026, 8, 17, 9),
}

describe('the adapter binds the project and never interpolates it', () => {
  it('readCeilings sends one ordered SELECT and reads every column back', async () => {
    const recorder = createRecordingSql()
    recorder.script([
      {
        project_id: 'acme-widgets',
        max_age_days: 30,
        archive_before_drop: false,
        archive_dir: null,
        set_by: 'operator',
        source: 'packages/team/deploy/ceiling.ts',
        set_at: new Date(CEILING.setAtMs).toISOString(),
      },
    ])

    const rows = await createRetentionSql(recorder.sql).readCeilings()

    expect(recorder.queries.length).toBe(1)
    expect(recorder.queries[0]?.sql).toContain('FROM retention_ceilings')
    expect(recorder.queries[0]?.sql).toContain('ORDER BY project_id')
    expect(rows).toEqual([CEILING])
  })

  it('nameCeiling is an upsert that overwrites the PROVENANCE too, not only the age', async () => {
    const recorder = createRecordingSql()
    await createRetentionSql(recorder.sql).nameCeiling(CEILING)

    const sent = recorder.queries[0]?.sql ?? ''
    expect(sent).toContain('INSERT INTO retention_ceilings')
    expect(sent).toContain('ON CONFLICT (project_id) DO UPDATE SET')
    // Ruling 9: the effective value names the admin who set it LAST. A DO UPDATE
    // that moved only `max_age_days` would keep the first admin's name forever.
    for (const column of ['max_age_days', 'archive_before_drop', 'archive_dir', 'set_by', 'source', 'set_at']) {
      expect(sent, `${column} moves on a re-name`).toContain(`${column} = EXCLUDED.${column}`)
    }
    // Every value is BOUND: the statement text carries `?` and the id is in the values.
    expect(sent).not.toContain('acme-widgets')
    expect(recorder.queries[0]?.values).toContain('acme-widgets')
    expect(recorder.queries[0]?.values).toContain(30)
  })

  it('clearCeiling reports whether there was one, from the affected-row count', async () => {
    const recorder = createRecordingSql()
    const port = createRetentionSql(recorder.sql)

    recorder.scriptCount(1)
    expect(await port.clearCeiling('acme-widgets')).toBe(true)
    recorder.scriptCount(0)
    expect(await port.clearCeiling('nobody')).toBe(false)

    expect(recorder.queries[0]?.sql).toContain('DELETE FROM retention_ceilings')
    expect(recorder.queries[0]?.values).toEqual(['acme-widgets'])
  })

  it('listEventPartitions asks the catalogue for the parent by NAME, bound, and orders', async () => {
    const recorder = createRecordingSql()
    recorder.script([{ partition: 'events_2026_07' }, { partition: 'events_2026_08' }])

    expect(await createRetentionSql(recorder.sql).listEventPartitions()).toEqual(['events_2026_07', 'events_2026_08'])

    const sent = recorder.queries[0]?.sql ?? ''
    expect(sent).toContain('pg_inherits')
    expect(sent).toContain('ORDER BY child.relname')
    // `information_schema` has no view of a partition's parent, so the catalogue
    // is not a preference here — it is the only source.
    expect(sent).not.toContain('information_schema')
    expect(recorder.queries[0]?.values).toEqual(['events'])
  })
})

describe('the drop is a partition, checked before a character of it reaches DDL', () => {
  it('sends DROP TABLE IF EXISTS for the one shape it accepts, and nothing else', async () => {
    const recorder = createRecordingSql()
    await createRetentionSql(recorder.sql).dropEventPartition('events_2026_01')

    expect(recorder.queries.map((q) => q.sql)).toEqual(['DROP TABLE IF EXISTS events_2026_01'])
    // `IF EXISTS`, so a sweep racing an operator's manual drop is a no-op rather
    // than a failure that would strand every later partition in the same sweep.
    expect(recorder.queries[0]?.values).toEqual([])
  })

  it.each([
    'events',
    'events_2026_13',
    'events_2026_00',
    'events_2026',
    'events_202_08',
    'pg_class',
    'events_2026_08; DROP TABLE events',
    'events_2026_08 CASCADE',
    '',
  ])('refuses %o by name, BEFORE any statement is sent', async (name) => {
    const recorder = createRecordingSql()
    await expect(createRetentionSql(recorder.sql).dropEventPartition(name)).rejects.toThrow('dropEventPartition')
    // The whole safety story: the refusal happens before the interpolation, so
    // nothing reached the driver at all.
    expect(recorder.queries).toEqual([])
  })
})

describe('the fake is not kinder than the adapter', () => {
  it('nameCeiling twice is ONE row, and the second name is the one that stands', async () => {
    const storage = new FakeTeamStorage()
    await storage.nameCeiling(CEILING)
    await storage.nameCeiling({ ...CEILING, maxAgeDays: 90, setBy: 'second-admin' })
    await storage.nameCeiling({ ...CEILING, maxAgeDays: 7, setBy: 'third-admin' })

    const read = await storage.readCeilings()
    expect(read.length).toBe(1)
    expect(read[0]?.maxAgeDays).toBe(7)
    expect(read[0]?.setBy).toBe('third-admin')
  })

  it('a ceiling is read back in project order, whatever order it was named in', async () => {
    const storage = new FakeTeamStorage()
    await storage.nameCeiling({ ...CEILING, projectId: 'zulu' })
    await storage.nameCeiling({ ...CEILING, projectId: 'alpha' })
    expect((await storage.readCeilings()).map((c) => c.projectId)).toEqual(['alpha', 'zulu'])
  })

  it('clearCeiling says whether there was one, and a second clear says there was not', async () => {
    const storage = new FakeTeamStorage()
    await storage.nameCeiling(CEILING)
    expect(await storage.clearCeiling('acme-widgets')).toBe(true)
    expect(await storage.clearCeiling('acme-widgets')).toBe(false)
    expect(await storage.readCeilings()).toEqual([])
  })

  it('dropping the same partition twice removes it once and records both calls — the adapters IF EXISTS', async () => {
    const storage = new FakeTeamStorage({ eventPartitions: ['events_2026_01', 'events_2026_02'] })
    await storage.dropEventPartition('events_2026_01')
    await storage.dropEventPartition('events_2026_01')

    expect(await storage.listEventPartitions()).toEqual(['events_2026_02'])
    expect(storage.droppedPartitions).toEqual(['events_2026_01', 'events_2026_01'])
  })

  it('the fake refuses the same names the adapter does — a double that accepted `events` would prove a sweep safe that is not', async () => {
    const storage = new FakeTeamStorage({ eventPartitions: ['events_2026_01'] })
    await expect(storage.dropEventPartition('events')).rejects.toThrow('dropEventPartition')
    expect(await storage.listEventPartitions()).toEqual(['events_2026_01'])
  })

  it('the shipped state is an empty ceiling table and whatever partitions exist', async () => {
    const storage = new FakeTeamStorage()
    expect(await storage.readCeilings()).toEqual([])
    expect(await storage.listEventPartitions()).toEqual([])
    expect(storage.droppedPartitions).toEqual([])
  })
})

describe('the two constants say who set the default, and what is not known', () => {
  it('NO_CEILING_SOURCE is a tracked path an operator can open', () => {
    expect(NO_CEILING_SOURCE).toBe('packages/team/src/storage/ports/retention/port.ts')
  })

  it('the quota gap says what it does NOT know, and why, rather than reporting a number', () => {
    expect(RETENTION_QUOTA_GAP).toContain('NOT KNOWN')
    expect(RETENTION_QUOTA_GAP).toContain('partitioned by ts and not by project')
    expect(RETENTION_QUOTA_GAP).toContain('No per-project quota is enforced')
  })
})
