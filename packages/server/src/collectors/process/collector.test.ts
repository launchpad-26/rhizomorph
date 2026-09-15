import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CollectorContext, RhizomorphEvent } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProcessCollector, type ProcessSnapshot } from './collector.js'
import type { ProcessRow, ProcessTableReading } from './read-table.js'

/**
 * The collector's job is the DIFF: what is new, what changed, what went. The
 * reader is injected, so none of this needs a live process table — which is the
 * property that lets the macOS and Windows legs be tested from committed
 * captures by someone who does not own the machine they came from.
 */

let repoRoot: string
const roots: string[] = []

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'rhizo-proc-repo-'))
  roots.push(repoRoot)
  mkdirSync(path.join(repoRoot, 'wt', 'lane-a'), { recursive: true })
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

let idSeed = 0
function contextFor(now: number): CollectorContext {
  return {
    repoPath: repoRoot,
    now,
    exec: async () => ({ stdout: '', stderr: '', code: 0, failed: false }),
    nextId: () => `evt-${(idSeed += 1)}`,
    emit: (type: Parameters<typeof createEvent>[0], payload: never, options?: { ts?: number }) =>
      createEvent(type, payload, { id: `evt-${(idSeed += 1)}`, ts: options?.ts ?? now }),
  } as unknown as CollectorContext
}

function row(overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    pid: 4321,
    argv: ['claude', '--resume'],
    cwd: path.join(repoRoot, 'wt', 'lane-a'),
    startedAt: 1_788_000_000_000,
    cpuMs: 100,
    rssBytes: 4096,
    parentPid: 1,
    ...overrides,
  }
}

function readerFor(...readings: (ProcessTableReading | null)[]) {
  let tick = 0
  return async () => readings[Math.min(tick++, readings.length - 1)] ?? null
}

const typesOf = (events: RhizomorphEvent[]): string[] => events.map((e) => e.type)

describe('the collector says what the table showed', () => {
  it('emits process.seen for a matched agent placed inside the watched repo', async () => {
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row()] }) })
    const { events, nextSnapshot } = await collector.poll(collector.initialSnapshot(), contextFor(1000))

    expect(typesOf(events)).toEqual(['process.seen'])
    const payload = events[0]?.payload as { pid: number; dialect: string; placement: string }
    expect(payload.pid).toBe(4321)
    expect(payload.dialect).toBe('claude')
    expect(payload.placement).toBe('rooted')
    expect((nextSnapshot as ProcessSnapshot).readable).toBe(true)
  })

  it('says nothing about a process that is not an agent — it is not counted, named or reported', async () => {
    // The non-goal with the sharpest edge: this is not a general process
    // monitor. "What is running on my machine" is a question it must not answer.
    const collector = createProcessCollector({
      readTable: readerFor({ rows: [row({ argv: ['vim', 'claude.ts'] }), row({ pid: 99, argv: ['bash'] })] }),
    })
    const { events, nextSnapshot } = await collector.poll(collector.initialSnapshot(), contextFor(1000))

    expect(events).toEqual([])
    expect(Object.keys((nextSnapshot as ProcessSnapshot).actors)).toEqual([])
  })

  it('says nothing about an agent outside the watched repo — wave 2 watches one repo', async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'rhizo-other-repo-'))
    roots.push(elsewhere)
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row({ cwd: elsewhere })] }) })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    expect(events).toEqual([])
  })

  it('records parentage only among matched actors — never a shell, never init', async () => {
    const conductor = row({ pid: 100, cpuMs: 1 })
    const worker = row({ pid: 200, parentPid: 100 })
    const shellChild = row({ pid: 300, parentPid: 999 })
    const collector = createProcessCollector({ readTable: readerFor({ rows: [conductor, worker, shellChild] }) })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor(1000))

    const byPid = new Map(events.map((e) => [(e.payload as { pid: number }).pid, e.payload as { parentPid: number | null }]))
    expect(byPid.get(200)?.parentPid).toBe(100)
    // 999 is a real parent and not an actor, so it is not recorded at all.
    expect(byPid.get(300)?.parentPid).toBeNull()
    expect(byPid.get(100)?.parentPid).toBeNull()
  })
})

describe('activity is edge-triggered, never a heartbeat', () => {
  it('emits nothing on a tick where nothing changed', async () => {
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row()] }) })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(typesOf(first.events)).toEqual(['process.seen'])
    // A collector that re-announced every tick would refresh the very silence
    // FROZEN and WAITING are measured against — `buildFleet` folds these into
    // `lastWorkTs`. That is the prd3 keystone bug, and this is the assertion
    // that stops it coming back.
    expect(second.events).toEqual([])
  })

  it('emits process.activity only when CPU or RSS moved, with a delta that cannot go negative', async () => {
    const collector = createProcessCollector({
      readTable: readerFor({ rows: [row({ cpuMs: 100 })] }, { rows: [row({ cpuMs: 350, rssBytes: 8192 })] }),
    })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(typesOf(second.events)).toEqual(['process.activity'])
    const payload = second.events[0]?.payload as { cpuMsDelta: number; rssBytes: number }
    expect(payload.cpuMsDelta).toBe(250)
    expect(payload.rssBytes).toBe(8192)
  })
})

describe('gone, and the two ways it happens', () => {
  it('emits process.gone with reason absent when the pid leaves the table', async () => {
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row()] }, { rows: [] }) })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(typesOf(second.events)).toEqual(['process.gone'])
    expect((second.events[0]?.payload as { reason: string }).reason).toBe('absent')
  })

  it('a recycled pid is gone-then-seen, and says which — never a silent substitution', async () => {
    const before = row({ startedAt: 1_788_000_000_000 })
    const after = row({ startedAt: 1_788_000_009_000 })
    const collector = createProcessCollector({ readTable: readerFor({ rows: [before] }, { rows: [after] }) })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(typesOf(second.events).sort()).toEqual(['process.gone', 'process.seen'])
    const gone = second.events.find((e) => e.type === 'process.gone')?.payload as { reason: string; startedAt: number }
    expect(gone.reason).toBe('recycled')
    expect(gone.startedAt).toBe(1_788_000_000_000)
  })
})

describe('unknown is never death — the law this collector could most easily break', () => {
  it('a reader that cannot look emits NOTHING, and never gone', async () => {
    // The failure this guards: a platform with no leg, or a denied read,
    // reporting an unreadable table as an empty one — which would flatline
    // every lane at once. `null` and `{ rows: [] }` must not mean the same
    // thing, and this is where that distinction earns its keep.
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row()] }, null) })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(typesOf(first.events)).toEqual(['process.seen'])
    expect(second.events).toEqual([])
    expect((second.nextSnapshot as ProcessSnapshot).readable).toBe(false)
  })

  it('an EMPTY table does emit gone — that is the difference from null, stated as a pair', async () => {
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row()] }, { rows: [] }) })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))
    expect(typesOf(second.events)).toEqual(['process.gone'])
  })

  it('a first tick never emits gone, however the snapshot arrived', async () => {
    const collector = createProcessCollector({ readTable: readerFor({ rows: [] }) })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    expect(events).toEqual([])
  })

  it('recovering visibility re-reports the actor rather than assuming it survived', async () => {
    // After a blind tick the collector knows nothing, so the actor is `seen`
    // again. That is at-least-once, which ADR-0029 admits on the poll path, and
    // the fold keys on `pid:startedAt` so the repeat lands on the same actor.
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row()] }, null, { rows: [row()] }) })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const blind = await collector.poll(first.nextSnapshot, contextFor(2000))
    const back = await collector.poll(blind.nextSnapshot, contextFor(3000))

    expect(blind.events).toEqual([])
    expect(typesOf(back.events)).toEqual(['process.seen'])
  })
})

describe('what the collector declares it cannot do (ADR-0010)', () => {
  it('names a reason for every signal it does not provide', async () => {
    const capabilities = createProcessCollector().capabilities
    expect(capabilities).toBeDefined()
    for (const [signal, detail] of Object.entries(capabilities ?? {})) {
      if (detail.level === 'provided') continue
      expect(detail.reason, `${signal} is not provided and gives no reason`).toBeTruthy()
    }
  })

  it('does not claim cost or attention — CPU is not dollars, and a process never asks for a human', () => {
    const capabilities = createProcessCollector().capabilities
    expect(capabilities?.cost.level).toBe('absent')
    expect(capabilities?.attention.level).toBe('absent')
    expect(capabilities?.liveness.level).toBe('provided')
  })
})

describe('the Windows basename — the defect no fixture test could have found', () => {
  /**
   * The first live run, on a machine with three real `claude.exe` processes,
   * matched ZERO — while every fixture test in this directory passed. They
   * asserted that the capture PARSED (`argv[0]` matching `/claude/i`) and the
   * roster is matched against, never regex-searched. So these assert the MATCH,
   * through `poll`, which is the only surface that was actually wrong.
   */
  /**
   * `String.raw` throughout, and not as a style preference. A Windows path in
   * an ordinary quoted string is an escape-sequence minefield: `'C:\bin\x'`
   * COMPILES, and evaluates to a backspace character where the separator
   * should be — a test that passes while asserting nothing about the thing it
   * names. Every layer between here and the file (a heredoc, a generator, a
   * patch) eats one level. `String.raw` has no level to eat.
   */
  const WINDOWS_AGENT_PATH = String.raw`C:\bin\claude.exe`

  it.each([
    [String.raw`C:\Users\operator\AppData\Local\claude.exe`],
    [String.raw`C:\bin\claude.CMD`],
    [String.raw`C:\bin\claude.bat`],
  ])('identifies an agent launched as %s', async (executable) => {
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row({ argv: [executable, '--resume'] })] }) })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor(1000))

    expect(typesOf(events)).toEqual(['process.seen'])
    expect((events[0]?.payload as { dialect: string }).dialect).toBe('claude')
  })

  it('runs that match on THIS machine, whatever it is — the fixture is parsed everywhere', async () => {
    // Not a duplicate of the cases above: it names why they are written with
    // literal backslashes rather than `path.join`. `path.basename` is the
    // runtime's flavour, so a Windows row matched through it would be found on
    // Windows and invisible on the Linux box running the suite — a leg green in
    // CI and blind in the field, which is the shape this whole PRD is about.
    // Proven here rather than asserted: the separator really is a backslash.
    expect(WINDOWS_AGENT_PATH).toContain(String.fromCharCode(92))
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row({ argv: [WINDOWS_AGENT_PATH] })] }) })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    expect(typesOf(events), `matched nothing on ${process.platform}`).toEqual(['process.seen'])
  })

  it('invents no agent out of a suffix — stripping `.exe` must not widen the roster', async () => {
    // The mirror of the fix, and the assertion that keeps it honest:
    // `vim.exe` normalises to `vim`, which is not an agent and stays invisible.
    const collector = createProcessCollector({
      readTable: readerFor({ rows: [row({ argv: [String.raw`C:\bin\vim.exe`, 'claude.ts'] })] }),
    })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    expect(events).toEqual([])
  })

  it('a matched Windows agent with no readable cwd reaches no lane, and that is wave 2 working', async () => {
    // The real Windows row: identified, unplaceable. `Win32_Process` exposes no
    // working directory, a lane is a place, so this actor is known to the leg
    // and reported nowhere. Placement arrives with the hook join in wave 3;
    // until then `doctor` says `partial` rather than pretending either way.
    const collector = createProcessCollector({
      readTable: readerFor({ rows: [row({ argv: [WINDOWS_AGENT_PATH], cwd: null })] }),
    })
    const { events, nextSnapshot } = await collector.poll(collector.initialSnapshot(), contextFor(1000))

    expect(events).toEqual([])
    expect(Object.keys((nextSnapshot as ProcessSnapshot).actors)).toEqual([])
    // Distinct from the blind case: the table WAS readable. An unplaceable
    // actor must not be mistaken for an unreadable table, or Windows would
    // suppress `gone` for every Linux actor the same server is watching.
    expect((nextSnapshot as ProcessSnapshot).readable).toBe(true)
  })
})
