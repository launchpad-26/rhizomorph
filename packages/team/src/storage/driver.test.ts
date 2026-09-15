import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSql, reportNotice } from './driver.js'

/**
 * THE NOTICE FILTER, AGAINST NO DATABASE (#551).
 *
 * openSql's postgres() call is synchronous and opens no socket until a query
 * runs (verified against the installed postgres package before this file was
 * written) — so every case here constructs a real driver instance, or calls
 * reportNotice directly, and none needs a live Postgres.
 *
 * What this file does NOT prove: that a real Postgres server actually sends
 * exactly these field names and values for a DROP POLICY IF EXISTS or a
 * CREATE TABLE IF NOT EXISTS — that is a wire fact about Postgres itself, and
 * this package's storage tests already draw that line: a real host is what
 * proves the wire, not this suite. What is proven here is reportNotice's own
 * behaviour given the notice shape the #551 issue measured on a real first
 * boot, and that openSql actually wires it in.
 */

type RawSql = {
  readonly options: { readonly onnotice: unknown }
  end(opts?: { timeout: number }): Promise<void>
}

const EXPECTED_MIGRATION_NOTICE = {
  severity: 'NOTICE',
  severity_local: 'AVIS', // deliberately NOT 'NOTICE' — proves the gate reads severity, never severity_local
  code: '00000',
  message: 'policy "events_by_project" for relation "events" does not exist, skipping',
  file: 'dropcmds.c',
  line: '523',
  routine: 'does_not_exist_skipping',
}

const A_REAL_WARNING = {
  severity: 'WARNING',
  severity_local: 'WARNING',
  code: '01000',
  message: 'nonstandard use of \\ in a string literal',
  detail: "Use the escape string syntax for escapes, e.g., E'\\r\\n'.",
  file: 'scan.l',
  line: '1234',
  routine: 'scanner_yyerror',
}

const NO_SEVERITY_AT_ALL = {
  code: '00000',
  message: 'an unclassifiable notice this driver has never seen the shape of',
}

describe('reportNotice — the driver installs it and it is the only place #551 lives', () => {
  // Restored here, not inline at the end of each `it`: an inline `mockRestore()`
  // never runs when an assertion above it throws, which leaves the spy installed
  // on the global `console` and leaks its call history into the next test in this
  // file (#551 — `afterEach` runs even when the test body fails).
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('openSql installs reportNotice as the onnotice handler, by identity', async () => {
    const sql = openSql('postgres://user:pass@localhost:59999/rz_test') as unknown as RawSql
    expect(sql.options.onnotice).toBe(reportNotice)
    await sql.end({ timeout: 0 })
  })

  it('a NOTICE-severity notice condenses to exactly one line, on stdout, keeping the message', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportNotice(EXPECTED_MIGRATION_NOTICE)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
    const line = String(logSpy.mock.calls[0]?.[0])
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('policy "events_by_project"')
  })

  it('a WARNING survives in full — every field, unmodified, never condensed', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportNotice(A_REAL_WARNING)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy.mock.calls[0]?.[0]).toEqual(A_REAL_WARNING)
  })

  it('a notice with no severity field at all also survives in full — the safe default', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportNotice(NO_SEVERITY_AT_ALL)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy.mock.calls[0]?.[0]).toEqual(NO_SEVERITY_AT_ALL)
  })

  it('repetition — the same NOTICE reported twice condenses identically both times', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    reportNotice(EXPECTED_MIGRATION_NOTICE)
    reportNotice(EXPECTED_MIGRATION_NOTICE)
    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(logSpy.mock.calls[0]?.[0]).toBe(logSpy.mock.calls[1]?.[0])
  })

  it('repetition — the same WARNING reported twice is shown in full BOTH times, never throttled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reportNotice(A_REAL_WARNING)
    reportNotice(A_REAL_WARNING)
    expect(warnSpy).toHaveBeenCalledTimes(2)
    expect(warnSpy.mock.calls[0]?.[0]).toEqual(A_REAL_WARNING)
    expect(warnSpy.mock.calls[1]?.[0]).toEqual(A_REAL_WARNING)
  })

  it('acceptance: a dozen expected migration NOTICEs do not bury the two lines an operator needs — captured with no filtering', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // The boot report's own two lines are out of this issue's fence, so they are
    // reproduced here verbatim (the shapes the boot report actually prints)
    // around a dozen NOTICEs — the count #551 measured on a real host — built
    // from the two DDL shapes that issue named.
    console.log('config: 8 effective values')
    for (let i = 0; i < 12; i++) {
      reportNotice(
        i % 2 === 0
          ? {
              ...EXPECTED_MIGRATION_NOTICE,
              severity_local: 'NOTICE',
              message: `policy "p_${i}" for relation "events" does not exist, skipping`,
            }
          : {
              severity: 'NOTICE',
              severity_local: 'NOTICE',
              code: '00000',
              message: `relation "events_y2026m${i}" already exists, skipping`,
              file: 'tablecmds.c',
              line: String(500 + i),
              routine: 'heap_create_with_catalog',
            },
      )
    }
    console.log('migrations: 5 applied (0001_init, 0002_events, 0003_roles_rls, 0004_settings, 0005_partitions)')
    console.log('ingest key: seeded for project acme-widgets.')

    // Nothing in this corpus is above NOTICE, so the full-fidelity path must stay silent.
    expect(warnSpy).not.toHaveBeenCalled()

    const lines = logSpy.mock.calls.map((args) => String(args[0]))
    for (const line of lines) expect(line.split('\n')).toHaveLength(1) // every emitted line really is one line
    expect(lines.filter((l) => l.startsWith('migrations: '))).toHaveLength(1)
    expect(lines.filter((l) => l.startsWith('ingest key: '))).toHaveLength(1)
    // 12 notices + 3 boot lines, one line each — not 8 lines per notice (96+),
    // which is the defect #551 measured.
    expect(lines.length).toBeLessThanOrEqual(15)
  })
})
