import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Exec } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import {
  WINDOWS_CIM_ARGV,
  parseDotNetDate,
  parseWindowsCimJson,
  readWindowsTable,
  splitWindowsCommandLine,
} from './read-table-windows.js'

/**
 * The Windows leg, driven by the **real capture** — prd-57 ruling 2 and prd-15
 * ruling 7: a platform leg lands behind a capture, never from a man page.
 *
 * `fixtures/windows-cim.json` was taken on a native Windows machine with three
 * real Claude Code sessions running, 2026-09-16, and sanitised before commit.
 * Every assertion below runs against those bytes, so this leg is verifiable by
 * someone who has never touched a Windows machine.
 */

const CAPTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'windows-cim.json'),
  'utf8',
)

describe('the committed capture is what it claims to be', () => {
  it('parses, and holds both the identifiable and the unreadable case', () => {
    const reading = parseWindowsCimJson(CAPTURE)
    expect(reading).not.toBeNull()
    // Five rows captured: three agents, and two system processes whose command
    // line this user may not read. The second pair is not padding — it is the
    // Windows form of the probe's fourth law, and the reason the parser cannot
    // assume `CommandLine` is a string.
    expect(reading?.rows).toHaveLength(3)
  })

  it('carries no username, home directory or machine name — sanitised before commit', () => {
    // AGENTS.md makes a capture the main source of a personal path reaching a
    // tracked file, so this is asserted rather than trusted to the procedure.
    for (const leak of [/\\Users\\(?!operator)[a-z]+\\/i, /LACHLAN/i]) {
      expect(CAPTURE, `capture leaks ${leak}`).not.toMatch(leak)
    }
  })
})

describe('what the capture taught, which documentation would not have', () => {
  it('CreationDate is .NET JSON, not ISO 8601 — the parse that would have been written blind', () => {
    // `"\/Date(1788956011002)\/"`. A parser expecting an ISO string produces
    // NaN here, and NaN is half of an actor's identity.
    expect(CAPTURE).toMatch(/\\?\/Date\(\d+\)\\?\//)
    expect(parseDotNetDate('/Date(1788956011002)/')).toBe(1788956011002)
    expect(parseDotNetDate('2026-09-10T00:13:31Z')).toBeNull()
    expect(parseDotNetDate(null)).toBeNull()
  })

  it('a null CommandLine is skipped, not thrown on — two of the five captured rows have one', () => {
    const withNulls = JSON.stringify([
      { ProcessId: 1, CommandLine: null, CreationDate: '/Date(1000)/' },
      { ProcessId: 2, CommandLine: '"C:\\bin\\claude.exe"', CreationDate: '/Date(2000)/', WorkingSetSize: 1, UserModeTime: 0, KernelModeTime: 0, ParentProcessId: 1 },
    ])
    expect(parseWindowsCimJson(withNulls)?.rows.map((r) => r.pid)).toEqual([2])
  })

  it('the command line is ONE STRING and is split, quotes respected — the path has spaces', () => {
    expect(splitWindowsCommandLine('"C:\\Program Files\\x\\claude.exe" --resume abc')).toEqual([
      'C:\\Program Files\\x\\claude.exe',
      '--resume',
      'abc',
    ])
    expect(splitWindowsCommandLine('claude')).toEqual(['claude'])
    expect(splitWindowsCommandLine('')).toEqual([])
  })

  it('a single process serialises as an object, not an array — PowerShell does that', () => {
    const one = JSON.stringify({
      ProcessId: 7,
      ParentProcessId: 1,
      CreationDate: '/Date(5000)/',
      CommandLine: 'claude',
      WorkingSetSize: 10,
      UserModeTime: 0,
      KernelModeTime: 0,
    })
    expect(parseWindowsCimJson(one)?.rows).toHaveLength(1)
  })
})

describe('the gap this leg declares rather than guesses', () => {
  it('every row has a null cwd — Win32_Process exposes no working directory at all', () => {
    // Not an omission in the query: the CIM class has no such property. This is
    // the fact that makes the Windows leg identify-but-not-place, and it is
    // why the query below asks for seven fields and not eight.
    const reading = parseWindowsCimJson(CAPTURE)
    for (const row of reading?.rows ?? []) expect(row.cwd).toBeNull()
  })

  it('the query names exactly the fields this leg reads, and no working directory among them', () => {
    const query = WINDOWS_CIM_ARGV[WINDOWS_CIM_ARGV.length - 1] ?? ''
    for (const field of ['ProcessId', 'ParentProcessId', 'CreationDate', 'CommandLine', 'WorkingSetSize', 'UserModeTime', 'KernelModeTime']) {
      expect(query).toContain(field)
    }
    for (const absent of ['WorkingDirectory', 'CurrentDirectory', 'Path', 'Environment']) {
      expect(query, `the query asks for ${absent}, which this leg must not read`).not.toContain(absent)
    }
  })

  it('runs through an argv array with no shell and no interpolation', () => {
    // The whole command is a constant. There is no value from a request, a
    // repo or a lane anywhere in it, so there is nothing to inject into.
    expect(WINDOWS_CIM_ARGV).toContain('-NoProfile')
    expect(WINDOWS_CIM_ARGV).toContain('-NonInteractive')
    expect(WINDOWS_CIM_ARGV.join(' ')).not.toMatch(/\$\{|`/)
  })
})

describe('real CPU and memory, from the real bytes', () => {
  it('converts FILETIME ticks to milliseconds and reports working set as bytes', () => {
    const reading = parseWindowsCimJson(CAPTURE)
    const row = reading?.rows[0]
    expect(row).toBeDefined()
    // Windows reports CPU in 100-nanosecond intervals. The captured agent had
    // burned real time, so this is a positive number rather than a placeholder.
    expect(row!.cpuMs).toBeGreaterThan(0)
    expect(row!.rssBytes).toBeGreaterThan(0)
    expect(Number.isInteger(row!.cpuMs)).toBe(true)
  })

  it('every captured agent is identified by argv — which is all this leg claims to do', () => {
    const reading = parseWindowsCimJson(CAPTURE)
    for (const row of reading?.rows ?? []) {
      expect(row.argv.length).toBeGreaterThan(0)
      expect(row.argv[0]).toMatch(/claude/i)
    }
  })
})

describe('unknown is never death, on this leg too', () => {
  const failing: Exec = async () => ({ stdout: '', stderr: 'not found', code: null, failed: true, errorMessage: 'ENOENT' })
  const empty: Exec = async () => ({ stdout: '   ', stderr: '', code: 0, failed: false })
  const garbage: Exec = async () => ({ stdout: 'not json', stderr: '', code: 0, failed: false })

  it.each([
    ['PowerShell is not on PATH', failing],
    ['the command produced nothing', empty],
    ['the output is not JSON', garbage],
  ])('answers null when %s', async (_label, exec) => {
    expect(await readWindowsTable(exec)).toBeNull()
  })

  it('answers a READING, not null, when the real capture comes back', async () => {
    // The control the three above would be vacuous without: a reader that
    // always returned null would pass every one of them.
    const good: Exec = async () => ({ stdout: CAPTURE, stderr: '', code: 0, failed: false })
    const reading = await readWindowsTable(good)
    expect(reading?.rows).toHaveLength(3)
  })
})
