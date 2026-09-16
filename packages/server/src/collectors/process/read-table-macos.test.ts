import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CollectorContext, Exec, RhizomorphEvent } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { canonicalize } from '../../paths/containment.js'
import { createProcessCollector } from './collector.js'
import {
  MACOS_LSOF_ARGV,
  MACOS_PS_ARGS_ARGV,
  MACOS_PS_ARGV,
  parseMacosCpuTime,
  parseMacosCwdMap,
  parseMacosLstart,
  parseMacosTable,
  readMacosTable,
} from './read-table-macos.js'

/**
 * The macOS leg, driven by the **real capture** — prd-57 ruling 2 and prd-15
 * ruling 7: a platform leg lands behind a capture, never from a man page.
 *
 * `fixtures/macos-ps.txt` and its two siblings were taken on a real Apple
 * silicon machine with three real Claude Code sessions running in three
 * different directories, 2026-09-16, and sanitised before commit. Every
 * assertion below runs against those bytes, so this leg is verifiable by
 * someone who has never touched a Mac.
 *
 * ## The one thing this file is careful NOT to do
 *
 * The Windows leg's fixture tests passed while it matched **zero** of three
 * real agents, because they asserted that the capture PARSED — `argv[0]`
 * matching `/claude/i` — and the roster is matched against, never
 * regex-searched. So the matching assertions here go through the collector's
 * `poll`, which is the surface that was actually wrong, and
 * `docs/review/2026-09-16-prd57-macos-witness.md` records the live run that no
 * fixture can stand in for.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const read = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8')

const PS = read('macos-ps.txt')
const ARGS = read('macos-ps-args.txt')
const LSOF = read('macos-lsof-cwd.txt')

/** The three pids that were live Claude Code sessions when the capture was taken. */
const AGENT_PIDS = [5001, 5090, 6132]
/** argv[0] of every one of them, and the space in it is the whole finding. */
const AGENT_EXECUTABLE =
  '/home/operator/Library/Application Support/Claude/claude-code/2.1.270/claude.app/Contents/MacOS/claude'

let idSeed = 0
function contextFor(repoPath: string): CollectorContext {
  return {
    repoPath,
    now: 1_788_000_000_000,
    exec: async () => ({ stdout: '', stderr: '', code: 0, failed: false }),
    nextId: () => `evt-${(idSeed += 1)}`,
    emit: (type: Parameters<typeof createEvent>[0], payload: never, options?: { ts?: number }) =>
      createEvent(type, payload, { id: `evt-${(idSeed += 1)}`, ts: options?.ts ?? 1_788_000_000_000 }),
  } as unknown as CollectorContext
}

/** One tick of the real collector over the captured table, placed against `repoPath`. */
async function pollCapture(repoPath: string): Promise<RhizomorphEvent[]> {
  const collector = createProcessCollector({ readTable: async () => parseMacosTable(PS, ARGS, LSOF) })
  const { events } = await collector.poll(collector.initialSnapshot(), contextFor(repoPath))
  return events
}

describe('the committed capture is what it claims to be', () => {
  it('parses, and holds both the agent rows and the ones that are nobody', () => {
    const reading = parseMacosTable(PS, ARGS, LSOF)
    expect(reading).not.toBeNull()
    // Seven rows: three live agents, and four system processes kept because
    // each one breaks a parser written the obvious way. The four are not
    // padding — see the fixture's own header for which and why.
    expect(reading?.rows).toHaveLength(7)
    expect(reading?.rows.map((row) => row.pid)).toEqual([1, 350, 421, 537, 5001, 5090, 6132])
  })

  it('carries no username, home directory or machine name — sanitised before commit', () => {
    // AGENTS.md makes a capture the main source of a personal path reaching a
    // tracked file, so this is asserted rather than trusted to the procedure.
    // `/Users/` at all, not one particular name: this is a macOS capture, so
    // the real home it replaced was a `/Users/` path and the convention these
    // fixtures use is `/home/operator`.
    for (const capture of [PS, ARGS, LSOF]) {
      expect(capture).not.toMatch(/\/Users\//)
      expect(capture).not.toMatch(/-Users-/)
      expect(capture).not.toMatch(/\bMac-mini\b/i)
      // The substitution actually landed, rather than the capture simply
      // having contained nothing — a sweep that passes on an empty file is the
      // shape this repo calls vacuous.
      expect(capture).toMatch(/\/home\/operator|HOST-REDACTED|\/repo/)
    }
  })
})

describe('what the capture taught, which documentation would not have', () => {
  it('argv[0] CONTAINS A SPACE, and comes from `comm` — the defect that would have shipped', () => {
    // The macOS twin of the Windows `.exe` bug. `ps -o command=` joins argv
    // with spaces and quotes nothing, so the executable path and its first
    // argument are indistinguishable.
    expect(AGENT_EXECUTABLE).toContain(' ')
    const reading = parseMacosTable(PS, ARGS, LSOF)
    for (const pid of AGENT_PIDS) {
      const row = reading?.rows.find((candidate) => candidate.pid === pid)
      expect(row?.argv[0], `pid ${pid}`).toBe(AGENT_EXECUTABLE)
    }
  })

  it('the naive whitespace split really does match nothing — the finding, made executable', async () => {
    // Not a story about what would have happened: the wrong argv[0] is fed to
    // the real collector and the real roster, and the result is silence. If
    // this ever starts emitting, the claim in `read-table-macos.ts` about why
    // `comm` is read has stopped being true and should be rewritten.
    const naive = AGENT_EXECUTABLE.split(' ')[0]
    expect(naive).toBe('/home/operator/Library/Application')
    const collector = createProcessCollector({
      readTable: async () => ({
        rows: [
          { pid: 5001, argv: [naive!, 'Support/Claude/claude-code/2.1.270/claude.app/Contents/MacOS/claude'], cwd: '/repo', startedAt: 1, cpuMs: 1, rssBytes: 1, parentPid: 1 },
        ],
      }),
    })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor('/repo'))
    expect(events).toEqual([])
  })

  it('`lstart` sits in the MIDDLE and is parsed from an anchor, so the fields after it survive', () => {
    // The classic /proc `comm` bug in its macOS costume. A left-to-right
    // whitespace split reads `time` as `Sep`, and every later field shifts —
    // plausibly, not loudly. These three come AFTER the date in the row, so
    // they can only be right if the anchor held.
    const reading = parseMacosTable(PS, ARGS, LSOF)
    const windowServer = reading?.rows.find((row) => row.pid === 421)
    expect(windowServer?.parentPid).toBe(1)
    // `404:34.97` — four hundred and four MINUTES, from the real row.
    expect(windowServer?.cpuMs).toBe((404 * 60 + 34.97) * 1000)
    // `37232` kilobytes, as `ps` reports it, in the bytes the contract wants.
    expect(windowServer?.rssBytes).toBe(37232 * 1024)
  })

  it('`time` minutes are not bounded at 60, and the LAST field is always seconds', () => {
    // The reading that magnitude-guessing gets wrong: `404:34.97` is minutes,
    // not hours, and it is a real value from the capture.
    expect(parseMacosCpuTime('404:34.97')).toBe(24_274_970)
    expect(parseMacosCpuTime('0:24.11')).toBe(24_110)
    expect(parseMacosCpuTime('27:46.42')).toBe(1_666_420)
    // Documented by `ps(1)` and NOT exercised by the fixture — said here
    // rather than left for a reader to assume the capture covered it.
    expect(parseMacosCpuTime('1:02:03')).toBe(3_723_000)
    expect(parseMacosCpuTime('2-01:00:00')).toBe(176_400_000)
    expect(parseMacosCpuTime('not a time')).toBeNull()
  })

  it('`lstart` is local time built field by field, never handed to Date.parse', () => {
    // Asserted as a DIFFERENCE as well as a value, because a difference is the
    // one thing that holds in every timezone: these two rows are 22 seconds
    // apart in the capture whatever machine reads them.
    const first = parseMacosLstart('Sun Sep 13 12:41:26 2026')
    const second = parseMacosLstart('Sun Sep 13 12:41:48 2026')
    expect(second! - first!).toBe(22_000)
    // And the month name really is being mapped, rather than a fixed offset
    // happening to line up: September is month index 8.
    expect(first).toBe(new Date(2026, 8, 13, 12, 41, 26).getTime())
    expect(parseMacosLstart('Sun Foo 13 12:41:26 2026')).toBeNull()
    expect(parseMacosLstart('2026-09-13T12:41:26Z')).toBeNull()
  })

  it('an executable whose own NAME holds spaces and parentheses survives — pid 537 is real', () => {
    const reading = parseMacosTable(PS, ARGS, LSOF)
    const row = reading?.rows.find((candidate) => candidate.pid === 537)
    expect(row?.argv[0]).toBe('Core Audio Driver (MSTeamsAudioDevice.driver)')
    // Its whole command line IS that name, so nothing was appended to argv.
    expect(row?.argv).toHaveLength(1)
  })

  it('a header comment or a blank line is skipped, not counted as a row and not fatal', () => {
    // Every committed capture carries the header block CAPTURE.md specifies,
    // and `ps` never emits one. The parser steps over anything that is not a
    // row rather than special-casing `#`, which is the same tolerance the
    // Linux leg shows a pid that exits mid-read.
    expect(PS).toMatch(/^# captured:/)
    expect(parseMacosTable(PS, ARGS, LSOF)?.rows).toHaveLength(7)
  })
})

describe('placement, which macOS CAN do and Windows cannot', () => {
  it('reads a working directory for every process the capturing user owned', () => {
    const reading = parseMacosTable(PS, ARGS, LSOF)
    for (const pid of AGENT_PIDS) {
      expect(reading?.rows.find((row) => row.pid === pid)?.cwd, `pid ${pid}`).toBeTruthy()
    }
    expect(reading?.rows.find((row) => row.pid === 5090)?.cwd).toBe('/repo')
  })

  it('a process the user does NOT own keeps a null cwd — real, placement unknown', () => {
    // `lsof` declines silently for another user's process: exit 1, empty
    // stdout, empty stderr. Four captured rows are root-owned and absent from
    // the lsof capture for that reason. The row is not dropped — the process
    // exists and it is the PLACEMENT that is unknown.
    const reading = parseMacosTable(PS, ARGS, LSOF)
    for (const pid of [1, 350, 421, 537]) {
      expect(reading?.rows.find((row) => row.pid === pid)?.cwd, `pid ${pid}`).toBeNull()
    }
  })

  it('a missing lsof leaves every row placeable-by-nobody, and never removes a row', () => {
    // The degradation that is NOT `null`: the process table WAS read, so the
    // collector may still retire an actor that really exited. Only placement
    // is lost.
    const reading = parseMacosTable(PS, ARGS, null)
    expect(reading?.rows).toHaveLength(7)
    for (const row of reading?.rows ?? []) expect(row.cwd).toBeNull()
  })

  it('parses lsof’s field stream by DESCRIPTOR, so a non-cwd fd could never become a placement', () => {
    expect(parseMacosCwdMap(LSOF).get(5090)).toBe('/repo')
    // Rigged: the same pid with a regular file open. `-d cwd` should mean this
    // never arrives, and reading the `f` field is what makes that a fact
    // rather than a hope.
    const rigged = 'p42\nfcwd\n/real/cwd\nf3\nn/some/open/file\n'.replace('\n/real/cwd', '\nn/real/cwd')
    expect(parseMacosCwdMap(rigged).get(42)).toBe('/real/cwd')
  })
})

describe('the MATCH, through poll — what no capture can prove and the Windows leg got wrong', () => {
  it('identifies all three captured sessions as `claude`, from a seven-row table', async () => {
    // Through the collector, not through a regex over argv[0]. `dialectOf`
    // matches basenames against the roster, and the roster holds `claude`;
    // asserting `/claude/i` over the capture is what let Windows ship blind.
    const events = await pollCapture('/')
    expect(events.map((event) => event.type)).toEqual(['process.seen', 'process.seen', 'process.seen'])
    const payloads = events.map((event) => event.payload as { pid: number; dialect: string })
    expect(payloads.map((payload) => payload.pid)).toEqual(AGENT_PIDS)
    for (const payload of payloads) expect(payload.dialect).toBe('claude')
  })

  it('says nothing about the four processes that are not agents', async () => {
    // Same tick as above: seven rows in, three events out. This is not a
    // general process monitor, and "what is running on my machine" is a
    // question it must not answer.
    const events = await pollCapture('/')
    const pids = events.map((event) => (event.payload as { pid: number }).pid)
    for (const pid of [1, 350, 421, 537]) expect(pids).not.toContain(pid)
  })

  it('places the session that was inside the watched repo, and drops the two that were not', async () => {
    // The capture's second session was running in a rhizomorph checkout —
    // `/repo` after sanitising. The other two were elsewhere on the same
    // machine, and wave 2 watches one repo.
    const events = await pollCapture('/repo')
    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as { pid: number; placement: string; worktreePath: string }
    expect(payload.pid).toBe(5090)
    expect(payload.placement).toBe('rooted')
    // Compared against the CANONICAL form rather than the literal `/repo`,
    // because the collector canonicalises before the event leaves it (prd-57
    // ruling 3) and `canonicalize` is the runtime's flavour: on native Windows
    // `/repo` resolves to `C:\repo`, so the literal made this the one assertion
    // in the file that could pass only on POSIX. Found by running this suite on
    // Windows — 105 of 106 green, and this was the one.
    //
    // Third time in this wave that a claim could only hold on one platform,
    // after `signatureToken` and `checkEnrichmentLadder`'s injected platform.
    // The fixture stays POSIX bytes — that is what a macOS capture IS — and
    // only the expectation learns that the comparison happens on the reader's
    // machine rather than on the captured one.
    expect(payload.worktreePath).toBe(canonicalize('/repo'))
  })

  it('carries real CPU, real memory and a real start time out of the fold', async () => {
    const reading = parseMacosTable(PS, ARGS, LSOF)
    const agent = reading?.rows.find((row) => row.pid === 5001)
    // `24:09.95` and `85232` kilobytes, from the real row.
    expect(agent?.cpuMs).toBe((24 * 60 + 9.95) * 1000)
    expect(agent?.rssBytes).toBe(85232 * 1024)
    expect(agent?.startedAt).toBe(new Date(2026, 8, 15, 12, 32, 30).getTime())
    // The desktop app launches the session from a helper, so the parent is a
    // real pid and is NOT itself an agent — the collector drops it for that
    // reason, and this is the row that proves parentage was read at all.
    expect(agent?.parentPid).toBe(5000)
  })
})

describe('the commands this leg runs, and the fields it refuses to ask for', () => {
  it('runs through argv arrays with no shell and no interpolation', () => {
    // The whole command is a constant. There is no value from a request, a
    // repo or a lane anywhere in it, so there is nothing to inject into.
    for (const argv of [MACOS_PS_ARGV, MACOS_PS_ARGS_ARGV, MACOS_LSOF_ARGV]) {
      expect(argv.join(' ')).not.toMatch(/\$\{|`|\$\(/)
    }
  })

  it('asks `ps` for exactly the fields it reads, and `comm` rather than `command` for the spine', () => {
    const spine = MACOS_PS_ARGV[MACOS_PS_ARGV.length - 1] ?? ''
    expect(spine).toBe('pid=,ppid=,lstart=,time=,rss=,comm=')
    // The substitution that is the finding: `command=` in the spine is the
    // defect, so its absence there is asserted rather than assumed.
    expect(spine).not.toContain('command=')
    expect(MACOS_PS_ARGS_ARGV[MACOS_PS_ARGS_ARGV.length - 1]).toBe('pid=,command=')
    // `-ww` on both, so a human running the same command by hand at a terminal
    // sees what the leg sees rather than a width-truncated version of it.
    expect(MACOS_PS_ARGV).toContain('-axww')
    expect(MACOS_PS_ARGS_ARGV).toContain('-axww')
  })

  it('asks `lsof` for working directories only, and for no other open file', () => {
    expect(MACOS_LSOF_ARGV).toEqual(['-d', 'cwd', '-Fpn'])
    // A leg that listed a process's open FILES would be reading the operator's
    // machine far past what ADR-0052 licenses. `-d cwd` is the narrowing, and
    // it is asserted so a later widening cannot be silent.
    expect(MACOS_LSOF_ARGV).toContain('cwd')
  })
})

describe('unknown is never death, on this leg too', () => {
  const failing: Exec = async () => ({ stdout: '', stderr: 'not found', code: null, failed: true, errorMessage: 'ENOENT' })
  const empty: Exec = async () => ({ stdout: '   ', stderr: '', code: 0, failed: false })
  const garbage: Exec = async () => ({ stdout: 'not a process table\nnor this line either\n', stderr: '', code: 0, failed: false })

  it.each([
    ['ps is not on PATH', failing],
    ['the command produced nothing', empty],
    ['the output is not a process table', garbage],
  ])('answers null when %s', async (_label, exec) => {
    expect(await readMacosTable(exec)).toBeNull()
  })

  it('answers a READING, not null, when the real capture comes back', async () => {
    // The control the three above would be vacuous without: a reader that
    // always returned null would pass every one of them.
    const good: Exec = async (command, argv) => ({
      stdout: command === 'lsof' ? LSOF : argv[argv.length - 1] === 'pid=,command=' ? ARGS : PS,
      stderr: '',
      code: 0,
      failed: false,
    })
    expect((await readMacosTable(good))?.rows).toHaveLength(7)
  })

  it('a table with rows and NO agent in it is an empty answer, never null — the pair', async () => {
    // "I looked and there are no agents" versus "I cannot look". The first may
    // retire actors; the second may not. Collapse them and every lane on the
    // machine flatlines at once.
    const noAgents = PS.split('\n').filter((line) => !/claude/.test(line)).join('\n')
    const reading = parseMacosTable(noAgents, ARGS, LSOF)
    expect(reading).not.toBeNull()
    expect(reading?.rows).toHaveLength(4)
    const collector = createProcessCollector({ readTable: async () => reading })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor('/'))
    expect(events).toEqual([])
  })

  it('a missing `command` read costs argv[1..] and nothing else — the row still stands', async () => {
    // The two `ps` reads are not one atomic snapshot. A pid in the first and
    // not the second must not vanish, or the race becomes a `gone` for a
    // process that never left.
    const reading = parseMacosTable(PS, null, LSOF)
    expect(reading?.rows).toHaveLength(7)
    for (const pid of AGENT_PIDS) {
      expect(reading?.rows.find((row) => row.pid === pid)?.argv).toEqual([AGENT_EXECUTABLE])
    }
    // And the agents are still identified, because identity is argv[0].
    const collector = createProcessCollector({ readTable: async () => reading })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor('/'))
    expect(events).toHaveLength(3)
  })
})
