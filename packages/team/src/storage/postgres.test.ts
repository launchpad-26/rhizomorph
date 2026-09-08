import { describe, expect, it } from 'vitest'
import type { EventRow } from './contract.js'
import { bindLine, buildMonthlyPartitionDdl, createPostgresStorage, toTimestamptz } from './postgres.js'
import { createRecordingSql } from './recording-sql.js'

/**
 * THE ADAPTER, AGAINST A RECORDING DRIVER.
 *
 * What these tests prove: the adapter does not touch the bytes it is given, and
 * it sends them inside the transactions ruling 4 needs. Assertions are made
 * against the **bound parameter**, not against a value the double handed back —
 * a double that echoes its input would make an echo test pass no matter what
 * the adapter did to the bytes on the way in.
 *
 * What they honestly do NOT prove, and where that is proven instead: that
 * Postgres itself stores and returns these bytes unchanged, and that
 * `timestamptz` round-trips the converted value. That needs a real host, and
 * this issue deliberately stands none up — wave 4 is where the schema meets one.
 */

const LINE_CORPUS: readonly { name: string; line: string }[] = [
  { name: 'a single space', line: ' ' },
  { name: 'CRLF inside the line', line: '{"a":1}\r\n{"b":2}' },
  { name: 'a lone carriage return', line: 'before\rafter' },
  { name: 'a tab', line: 'a\tb' },
  { name: 'a four-byte emoji', line: '{"emoji":"🧬"}' },
  { name: 'an escaped lone surrogate', line: '{"s":"\\ud83d"}' },
  { name: 'quotes and a backslash', line: `{"q":"\\"","s":'\\\\'}` },
  { name: 'a trailing space', line: '{"a":1} ' },
  { name: 'a leading space', line: ' {"a":1}' },
  { name: 'a 1 MiB line', line: `{"pad":"${'x'.repeat(1024 * 1024)}"}` },
]

function rowWith(overrides: Partial<EventRow> = {}): EventRow {
  return {
    projectId: 'acme-widgets',
    actorInstance: 'lane-7',
    n: 42,
    eventId: 'evt_0001',
    tsMs: 1785739192632,
    type: 'llm.cost',
    source: 'claude-code',
    lane: 'prd51-w2',
    worktree: 'wt-prd51-w2',
    payload: { costUsd: 0.0123 },
    line: '{"type":"llm.cost"}',
    ...overrides,
  }
}

/** The bound values of every recorded query that inserted into the events table. */
function insertValues(queries: readonly { sql: string; values: readonly unknown[] }[]): readonly unknown[][] {
  return queries.filter((q) => q.sql.includes('INTO events')).map((q) => [...q.values])
}

describe('case 1 — `line` round-trips byte for byte through appendEvents', () => {
  it.each(LINE_CORPUS)('binds $name unchanged', async ({ line }) => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)

    await storage.appendEvents([rowWith({ line })])

    const bound = insertValues(recorder.queries)[0]
    expect(bound).toBeDefined()
    // The LAST bound parameter is `line` — see the column list in `postgres.ts`.
    const boundLine = bound?.[bound.length - 1]
    expect(typeof boundLine).toBe('string')
    expect(boundLine).toBe(line)
    // Byte-level, not just `===` on a string: a normalising step that produced an
    // equal-looking string of different length would be caught here too.
    expect(Buffer.from(String(boundLine), 'utf8').equals(Buffer.from(line, 'utf8'))).toBe(true)
  })

  it('the corpus really covers the shapes a transformation would eat', () => {
    // A vacuous corpus would make every case above pass for the wrong reason.
    expect(LINE_CORPUS.length).toBe(10)
    expect(LINE_CORPUS.some(({ line }) => line !== line.trimEnd())).toBe(true)
    expect(LINE_CORPUS.some(({ line }) => line !== line.trimStart())).toBe(true)
    expect(LINE_CORPUS.some(({ line }) => line.includes('\r\n'))).toBe(true)
    expect(LINE_CORPUS.some(({ line }) => line.includes('\t'))).toBe(true)
    expect(LINE_CORPUS.some(({ line }) => line.length > 1_000_000)).toBe(true)
  })

  it('bindLine is the identity, and is where a transformation would have to be written', () => {
    for (const { line } of LINE_CORPUS) expect(bindLine(line)).toBe(line)
  })
})

describe('case 2 — the same corpus twice binds identically', () => {
  it('binds the same bytes for a repeated line, in one call and across two calls', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)

    const lines = LINE_CORPUS.map(({ line }) => line)
    await storage.appendEvents(lines.map((line, i) => rowWith({ n: i + 1, line })))
    await storage.appendEvents(lines.map((line, i) => rowWith({ n: i + 1, line })))

    const bound = insertValues(recorder.queries).map((values) => values[values.length - 1])
    expect(bound.length).toBe(lines.length * 2)
    expect(bound.slice(0, lines.length)).toEqual(lines)
    expect(bound.slice(lines.length)).toEqual(lines)
  })
})

describe('case 3 — toTimestamptz', () => {
  it('maps epoch milliseconds to exact ISO-8601 UTC with milliseconds', () => {
    expect(toTimestamptz(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(toTimestamptz(1785739192632)).toBe('2026-08-03T06:39:52.632Z')
    expect(toTimestamptz(4102444800000)).toBe('2100-01-01T00:00:00.000Z')
  })

  it('keeps sub-second precision, which is what a date-only conversion would lose', () => {
    expect(toTimestamptz(1785739192632)).toContain('.632')
    expect(toTimestamptz(1785739192001)).toContain('.001')
  })

  it('appendEvents binds the converted value, not the raw milliseconds', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    await storage.appendEvents([rowWith({ tsMs: 1785739192632 })])
    const bound = insertValues(recorder.queries)[0] ?? []
    expect(bound).toContain('2026-08-03T06:39:52.632Z')
    expect(bound).not.toContain(1785739192632)
  })
})

describe('case 4 — appendEvents sends its rows inside one transaction', () => {
  it('logs BEGIN first, COMMIT last, and every insert between them', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)

    const written = await storage.appendEvents([rowWith({ n: 1 }), rowWith({ n: 2 }), rowWith({ n: 3 })])

    expect(written).toBe(3)
    expect(recorder.log[0]).toBe('BEGIN')
    expect(recorder.log[recorder.log.length - 1]).toBe('COMMIT')
    const insertPositions = recorder.log
      .map((entry, i) => (entry.includes('INTO events') ? i : -1))
      .filter((i) => i >= 0)
    expect(insertPositions.length).toBe(3)
    for (const position of insertPositions) {
      expect(position).toBeGreaterThan(0)
      expect(position).toBeLessThan(recorder.log.length - 1)
    }
    // One transaction for the batch, not one per row.
    expect(recorder.log.filter((e) => e === 'BEGIN').length).toBe(1)
  })

  it('an empty batch opens no transaction at all', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    expect(await storage.appendEvents([])).toBe(0)
    expect(recorder.log).toEqual([])
  })
})

describe('case 5 — payload and every other value are parameters, never text', () => {
  it('the recorded statement text carries no value from the row', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)

    await storage.appendEvents([rowWith({ payload: { costUsd: 0.0123, note: 'acme' } })])

    const insert = recorder.queries.find((q) => q.sql.includes('INTO events'))
    expect(insert).toBeDefined()
    const text = insert?.sql ?? ''
    expect(text).not.toContain('{')
    expect(text).not.toContain('acme-widgets')
    expect(text).not.toContain('0.0123')
    expect(text).not.toContain('evt_0001')
    // …and the payload really did travel, as a JSON string parameter.
    expect(insert?.values).toContain(JSON.stringify({ costUsd: 0.0123, note: 'acme' }))
  })

  it('a null lane and worktree are bound as null rather than becoming the string "null"', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    await storage.appendEvents([rowWith({ lane: null, worktree: null })])
    const bound = insertValues(recorder.queries)[0] ?? []
    expect(bound.filter((v) => v === null).length).toBe(2)
    expect(bound).not.toContain('null')
  })
})

describe('case 6 — applyMigration is one transaction around DDL and bookkeeping', () => {
  it('sends the DDL unsafely and the bookkeeping row inside the same begin', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)

    await storage.applyMigration({ id: '0001_events', checksum: 'abc123', sql: 'CREATE TABLE t ()' })

    expect(recorder.log[0]).toBe('BEGIN')
    expect(recorder.log[recorder.log.length - 1]).toBe('COMMIT')
    expect(recorder.log).toContain('CREATE TABLE t ()')
    const bookkeeping = recorder.queries.find((q) => q.sql.includes('INTO _migrations'))
    expect(bookkeeping).toBeDefined()
    expect(bookkeeping?.values).toEqual(['0001_events', 'abc123'])
    const ddlAt = recorder.log.indexOf('CREATE TABLE t ()')
    const rowAt = recorder.log.findIndex((e) => e.includes('INTO _migrations'))
    expect(ddlAt).toBeGreaterThan(0)
    expect(rowAt).toBeGreaterThan(ddlAt)
    expect(rowAt).toBeLessThan(recorder.log.length - 1)
  })

  it('a failing DDL rolls back and never records the row', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    recorder.scriptFailure(new Error('syntax error at or near "CREAT"'))

    await expect(
      storage.applyMigration({ id: '0001_events', checksum: 'abc123', sql: 'CREAT TABLE t ()' }),
    ).rejects.toThrow('syntax error')

    expect(recorder.log).toContain('ROLLBACK')
    expect(recorder.queries.some((q) => q.sql.includes('INTO _migrations'))).toBe(false)
  })

  it('ensureMigrationsTable creates the bookkeeping table the runner reads', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    await storage.ensureMigrationsTable()
    expect(recorder.queries.length).toBe(1)
    expect(recorder.queries[0]?.sql).toContain('_migrations')
    expect(recorder.queries[0]?.sql).toContain('IF NOT EXISTS')
  })
})

describe('case 7 — readSetting binds the GUC name', () => {
  it('sends exactly one statement and binds the name as a parameter', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    recorder.script([{ setting: 'on' }])

    expect(await storage.readSetting('synchronous_commit')).toBe('on')

    expect(recorder.queries.length).toBe(1)
    const query = recorder.queries[0]
    expect(query?.values).toEqual(['synchronous_commit'])
    expect(query?.sql).not.toContain('synchronous_commit')
    expect(query?.sql).toContain('?')
  })

  it('an unknown setting reads as the empty string rather than throwing', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    recorder.script([{ setting: null }])
    expect(await storage.readSetting('nope')).toBe('')

    const empty = createRecordingSql()
    expect(await createPostgresStorage(empty.sql).readSetting('nope')).toBe('')
  })
})

describe('readEvents and the rest of the port', () => {
  it('binds the window and never puts a value in the statement text', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    recorder.script([
      {
        project_id: 'acme-widgets',
        actor_instance: 'lane-7',
        n: '42',
        event_id: 'evt_0001',
        ts: new Date(1785739192632),
        type: 'llm.cost',
        source: 'claude-code',
        lane: null,
        worktree: null,
        payload: { costUsd: 0.0123 },
        line: '{"type":"llm.cost"}',
      },
    ])

    const rows = await storage.readEvents({
      projectId: 'acme-widgets',
      actorInstance: 'lane-7',
      fromN: 1,
      toN: 100,
    })

    expect(recorder.queries[0]?.values).toEqual(['acme-widgets', 'lane-7', 1, 100])
    expect(recorder.queries[0]?.sql).not.toContain('acme-widgets')
    expect(rows).toEqual([
      {
        projectId: 'acme-widgets',
        actorInstance: 'lane-7',
        n: 42,
        eventId: 'evt_0001',
        tsMs: 1785739192632,
        type: 'llm.cost',
        source: 'claude-code',
        lane: null,
        worktree: null,
        payload: { costUsd: 0.0123 },
        line: '{"type":"llm.cost"}',
      },
    ])
  })

  it('listAppliedMigrations reads the bookkeeping table in id order', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    recorder.script([{ id: '0001_events', checksum: 'aa', applied_at: new Date(0) }])
    expect(await storage.listAppliedMigrations()).toEqual([
      { id: '0001_events', checksum: 'aa', appliedAt: '1970-01-01T00:00:00.000Z' },
    ])
    expect(recorder.queries[0]?.sql).toContain('ORDER BY id')
  })

  it('close ends the connection', async () => {
    const recorder = createRecordingSql()
    await createPostgresStorage(recorder.sql).close()
    expect(recorder.ended()).toBe(true)
  })
})

describe('ensureMonthlyPartition — the top-up path 0001 leaves open', () => {
  it('builds the partition 0001 would have built for that month', () => {
    expect(buildMonthlyPartitionDdl('2026-09')).toBe(
      "CREATE TABLE IF NOT EXISTS events_2026_09 PARTITION OF events FOR VALUES FROM ('2026-09-01') TO ('2026-10-01')",
    )
  })

  it('rolls the year over at December rather than producing month 13', () => {
    expect(buildMonthlyPartitionDdl('2026-12')).toContain("FROM ('2026-12-01') TO ('2027-01-01')")
  })

  it('is IF NOT EXISTS, so a second top-up of the same month is a no-op', async () => {
    const recorder = createRecordingSql()
    const storage = createPostgresStorage(recorder.sql)
    await storage.ensureMonthlyPartition('2026-09')
    await storage.ensureMonthlyPartition('2026-09')
    expect(recorder.queries.every((q) => q.sql.includes('IF NOT EXISTS'))).toBe(true)
  })

  it('refuses anything that is not YYYY-MM, by name — the identifier is interpolated, so the guard is the whole safety argument', () => {
    for (const bad of ['2026-13', '2026-00', '26-09', '2026-9', '2026-09-01', "2026-09'; DROP", '']) {
      expect(() => buildMonthlyPartitionDdl(bad)).toThrow(/must be YYYY-MM/)
    }
  })
})
