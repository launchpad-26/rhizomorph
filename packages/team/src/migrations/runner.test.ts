import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeTeamStorage } from '../storage/fake.js'
import { MIGRATIONS_DIR, checksumOf, readMigrationDir, runMigrations } from './runner.js'

/**
 * THE MIGRATION RUNNER, AGAINST THE PORT DOUBLE AND A TEMP DIRECTORY.
 *
 * One case per rule in the runner's own table. Two of them exist specifically
 * because the obvious implementation passes the others and fails these: the
 * checksum-change case asserts that a **later** pending migration was not
 * applied on the way to discovering the mismatch (a per-file check inside the
 * apply loop would have applied it), and the CRLF case asserts a checksum that
 * a raw-bytes implementation gets wrong only on Windows.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rz-team-migrations-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, body: string): void {
  writeFileSync(path.join(dir, name), body, 'utf8')
}

function writeThree(): void {
  write('0001_events.sql', 'CREATE TABLE events ();\n')
  write('0002_projections.sql', 'CREATE TABLE lane_state ();\n')
  write('0003_roles_rls.sql', 'CREATE ROLE rz_viewer;\n')
}

describe('case 8 — the happy path', () => {
  it('applies all three in ordinal order, after ensuring the bookkeeping table', async () => {
    writeThree()
    const fake = new FakeTeamStorage()

    const result = await runMigrations(fake, dir)

    expect(result).toEqual({
      ok: true,
      applied: ['0001_events', '0002_projections', '0003_roles_rls'],
      alreadyApplied: [],
    })
    expect(fake.calls.indexOf('ensureMigrationsTable')).toBeLessThan(
      fake.calls.findIndex((c) => c.startsWith('applyMigration:')),
    )
    expect(fake.applyAttempts).toEqual(['0001_events', '0002_projections', '0003_roles_rls'])
  })

  it('orders by the parsed integer, not by string compare', async () => {
    // Ten files: a string sort of unpadded numbers would put 10 before 2. These
    // are zero-padded, so the guard is the ordinal field itself — asserted here
    // against a ten-file set where the ordinals and the sort must agree.
    for (let i = 1; i <= 10; i += 1) write(`${String(i).padStart(4, '0')}_step.sql`, `-- ${i}\n`)
    const files = readMigrationDir(dir)
    expect(Array.isArray(files)).toBe(true)
    expect(Array.isArray(files) ? files.map((f) => f.ordinal) : []).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})

describe('case 9 — repetition is a no-op', () => {
  it('applies exactly three times across three runs', async () => {
    writeThree()
    const fake = new FakeTeamStorage()

    const first = await runMigrations(fake, dir)
    const second = await runMigrations(fake, dir)
    const third = await runMigrations(fake, dir)

    expect(first).toMatchObject({ ok: true, applied: ['0001_events', '0002_projections', '0003_roles_rls'] })
    expect(second).toMatchObject({ ok: true, applied: [] })
    expect(third).toMatchObject({ ok: true, applied: [] })
    expect(second.ok && second.alreadyApplied.length).toBe(3)
    expect(third.ok && third.alreadyApplied.length).toBe(3)
    expect(fake.applyAttempts.length).toBe(3)
  })
})

describe('case 10 — a gap refuses before anything is applied', () => {
  it('names the missing ordinal and applies nothing', async () => {
    write('0001_events.sql', 'CREATE TABLE events ();\n')
    write('0003_roles_rls.sql', 'CREATE ROLE rz_viewer;\n')
    const fake = new FakeTeamStorage()

    const result = await runMigrations(fake, dir)

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('0002')
    expect(fake.applyAttempts).toEqual([])
    expect(fake.committed).toEqual([])
  })
})

describe('case 11 — a duplicate ordinal refuses', () => {
  it('names both files and applies nothing', async () => {
    write('0001_events.sql', 'CREATE TABLE events ();\n')
    write('0002_projections.sql', 'CREATE TABLE lane_state ();\n')
    write('0002_extra.sql', 'CREATE TABLE other ();\n')
    const fake = new FakeTeamStorage()

    const result = await runMigrations(fake, dir)

    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toContain('0002_extra')
    expect(error).toContain('0002_projections')
    expect(fake.applyAttempts).toEqual([])
  })
})

describe('case 12 — a changed checksum refuses in a plan phase, before any apply', () => {
  it('applies nothing at all, including the pending migrations that follow it', async () => {
    write('0001_events.sql', 'CREATE TABLE events ();\n')
    const fake = new FakeTeamStorage()
    expect(await runMigrations(fake, dir)).toMatchObject({ ok: true, applied: ['0001_events'] })

    // 0001 is edited, and two brand-new migrations arrive behind it. A per-file
    // check inside the apply loop would apply 0002 and 0003 before noticing.
    write('0001_events.sql', 'CREATE TABLE events (extra text);\n')
    write('0002_projections.sql', 'CREATE TABLE lane_state ();\n')
    write('0003_roles_rls.sql', 'CREATE ROLE rz_viewer;\n')

    const result = await runMigrations(fake, dir)

    expect(result.ok).toBe(false)
    const error = result.ok ? '' : result.error
    expect(error).toContain('0001_events')
    expect(error).toContain('append-only')
    expect(error).toContain(checksumOf('CREATE TABLE events ();\n'))
    expect(error).toContain(checksumOf('CREATE TABLE events (extra text);\n'))
    expect(fake.applyAttempts).toEqual(['0001_events'])
    expect(fake.committed).toEqual(['0001_events'])
  })
})

describe('case 13 — the checksum is CRLF-normalised', () => {
  it('a CRLF checkout and an LF checkout of the same file agree', () => {
    const lf = 'CREATE TABLE events ();\nCREATE INDEX i ON events (n);\n'
    const crlf = lf.replace(/\n/g, '\r\n')
    expect(crlf).not.toBe(lf)
    expect(checksumOf(crlf)).toBe(checksumOf(lf))
  })

  it('a real content edit still changes it', () => {
    expect(checksumOf('CREATE TABLE events ();\n')).not.toBe(checksumOf('CREATE TABLE events (x text);\n'))
  })

  it('the normalise runs through readMigrationDir, not only through the helper', () => {
    write('0001_events.sql', 'CREATE TABLE events ();\r\nCREATE INDEX i ON events (n);\r\n')
    const files = readMigrationDir(dir)
    expect(Array.isArray(files)).toBe(true)
    expect(Array.isArray(files) ? files[0]?.checksum : '').toBe(
      checksumOf('CREATE TABLE events ();\nCREATE INDEX i ON events (n);\n'),
    )
  })
})

describe('case 14 — an applied row no file provides refuses', () => {
  it('names the ghost id and applies nothing', async () => {
    writeThree()
    const fake = new FakeTeamStorage({
      applied: [{ id: '0009_ghost', checksum: 'deadbeef', appliedAt: '1970-01-01T00:00:00.000Z' }],
    })

    const result = await runMigrations(fake, dir)

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('0009_ghost')
    expect(fake.applyAttempts).toEqual([])
  })
})

describe('case 15 — a misnamed .sql refuses rather than being skipped', () => {
  it('names the file', async () => {
    write('0001_events.sql', 'CREATE TABLE events ();\n')
    write('add-index.sql', 'CREATE INDEX i ON events (n);\n')
    const fake = new FakeTeamStorage()

    const result = await runMigrations(fake, dir)

    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('add-index.sql')
    expect(fake.applyAttempts).toEqual([])
  })

  it('a non-.sql file beside the migrations is ignored, not refused', () => {
    write('0001_events.sql', 'CREATE TABLE events ();\n')
    write('README.md', 'notes\n')
    const files = readMigrationDir(dir)
    expect(Array.isArray(files)).toBe(true)
    expect(Array.isArray(files) ? files.map((f) => f.id) : []).toEqual(['0001_events'])
  })

  it('the name rule really is a rule — uppercase, spaces and a missing ordinal all refuse', async () => {
    for (const bad of ['0001-events.sql', '001_events.sql', 'Zero_events.sql', '0001_Events.sql']) {
      const scratch = mkdtempSync(path.join(tmpdir(), 'rz-team-name-'))
      try {
        writeFileSync(path.join(scratch, bad), '-- x\n', 'utf8')
        const result = readMigrationDir(scratch)
        expect(Array.isArray(result)).toBe(false)
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    }
  })
})

describe('case 16 — atomicity is per migration, and a run resumes', () => {
  it('leaves the applied prefix, names the failure, and resumes on the next run', async () => {
    writeThree()
    const fake = new FakeTeamStorage({ failApply: ['0002_projections'] })

    const first = await runMigrations(fake, dir)

    expect(first.ok).toBe(false)
    expect(first.ok ? '' : first.error).toContain('0002_projections')
    expect(fake.committed).toEqual(['0001_events'])
    // 0003 was never attempted: the run stopped at the failure.
    expect(fake.applyAttempts).toEqual(['0001_events', '0002_projections'])

    fake.failApply.clear()
    const second = await runMigrations(fake, dir)

    expect(second).toMatchObject({ ok: true, applied: ['0002_projections', '0003_roles_rls'] })
    expect(second.ok && second.alreadyApplied).toEqual(['0001_events'])
    expect(fake.committed).toEqual(['0001_events', '0002_projections', '0003_roles_rls'])
  })
})

describe('case 17 — the walk really reads a directory', () => {
  it('reads the three tracked migrations that ship with this package', () => {
    const files = readMigrationDir()
    expect(Array.isArray(files)).toBe(true)
    expect(Array.isArray(files) ? files.map((f) => f.id) : []).toEqual([
      '0001_events',
      '0002_projections',
      '0003_roles_rls',
    ])
    // Not a glob that matched nothing: the bodies are real SQL from real files.
    expect(Array.isArray(files) ? files[0]?.sql : '').toContain('PARTITION BY RANGE (ts)')
    expect(MIGRATIONS_DIR.endsWith(path.join('src', 'migrations'))).toBe(true)
  })

  it('a directory that does not exist refuses by name rather than reading as empty', () => {
    const missing = path.join(dir, 'nope')
    const result = readMigrationDir(missing)
    expect(Array.isArray(result)).toBe(false)
    expect(Array.isArray(result) ? '' : result.error).toContain(missing)
  })

  it('an empty directory applies nothing and succeeds', async () => {
    const fake = new FakeTeamStorage()
    expect(await runMigrations(fake, dir)).toEqual({ ok: true, applied: [], alreadyApplied: [] })
  })
})
