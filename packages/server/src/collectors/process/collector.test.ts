import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CollectorContext, RhizomorphEvent } from '@rhizomorph/core'
import { createEvent } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonicalize } from '../../paths/containment.js'
import { createProcessCollector, type ProcessSnapshot, signatureToken } from './collector.js'
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

  it('normalises a Windows path on EVERY platform, which `poll` alone cannot show', () => {
    // Why this one drops to the function while every other case here goes
    // through `poll`: on win32 `path.basename` splits backslashes itself, so
    // the cases above pass whether or not `signatureToken` splits — proven by
    // mutation, which left the entire collector suite green on this machine.
    // The portability claim is invisible from the fold here and would redden
    // only on a POSIX runner, and an assertion that can fail only on someone
    // else's machine is not an assertion. So this one asserts the string.
    expect(WINDOWS_AGENT_PATH).toContain(String.fromCharCode(92))
    expect(signatureToken(WINDOWS_AGENT_PATH)).toBe('claude')
    expect(signatureToken(String.raw`C:\Program Files\x\claude.exe`)).toBe('claude')
    expect(signatureToken('/usr/local/bin/claude')).toBe('claude')
    expect(signatureToken('claude')).toBe('claude')
    // And it takes a suffix off without inventing one that is not there.
    expect(signatureToken('/usr/bin/node')).toBe('node')
    expect(signatureToken(String.raw`C:\bin\vim.exe`)).toBe('vim')
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

describe('unknown is never death AT THE ROW, not only at the table (review of #555, finding 1)', () => {
  /**
   * The gap the third law had. `readable` enforced it for the whole TABLE — a
   * platform with no leg, or a denied read, emits nothing. `placementOf`'s own
   * `'unknown'` walked straight through that at the ROW level: any actor that
   * was rooted last tick and is not rooted this tick was dropped before it
   * reached `actors`, and then reported `gone` with `reason: 'absent'` while its
   * pid sat in the table the collector had just read.
   *
   * Both triggers below were executed against the old code by the reviewer on
   * darwin and both passed — that is, both produced the phantom death.
   *
   * The one that matters is the second. `read-table.ts` produces `cwd: null`
   * DELIBERATELY: a failed `readlink` keeps the row, because "the process is
   * real and its placement is what is unknown". The reader preserved the
   * distinction and the collector collapsed it into death.
   */
  const stillThere = (overrides: Partial<ProcessRow>) => ({ rows: [row(overrides)] })

  it('a live actor whose cwd can no longer be READ is not gone — the Windows shape, mid-session', async () => {
    const collector = createProcessCollector({
      readTable: readerFor({ rows: [row()] }, stillThere({ cwd: null })),
    })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(typesOf(first.events)).toEqual(['process.seen'])
    expect(second.events).toEqual([])
    // And it is still HELD, which is what stops the next tick reporting it gone.
    expect(Object.keys((second.nextSnapshot as ProcessSnapshot).actors)).toHaveLength(1)
  })

  it('a live actor that walked OUT of the watched repo is not gone either', async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'rhizo-elsewhere-'))
    roots.push(elsewhere)
    const collector = createProcessCollector({
      readTable: readerFor({ rows: [row()] }, stillThere({ cwd: elsewhere })),
    })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(typesOf(first.events)).toEqual(['process.seen'])
    expect(second.events).toEqual([])
  })

  it('and it still goes gone when the pid REALLY leaves — the carry-forward is not a leak', async () => {
    // The control the two above would be worthless without: a collector that
    // simply never emitted `gone` would pass both of them.
    const collector = createProcessCollector({
      readTable: readerFor({ rows: [row()] }, stillThere({ cwd: null }), { rows: [] }),
    })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const blind = await collector.poll(first.nextSnapshot, contextFor(2000))
    const third = await collector.poll(blind.nextSnapshot, contextFor(3000))

    expect(typesOf(third.events)).toEqual(['process.gone'])
    expect((third.events[0]?.payload as { reason: string }).reason).toBe('absent')
  })

  it('`absent` now means what the schema says — a pid absent from the table', async () => {
    // The word was separately wrong on its own terms: `processGonePayloadSchema`
    // defines `absent` as "a pid absent from the table", and the old path
    // emitted it for a pid that was present. This asserts the invariant rather
    // than a case: every `gone` this collector emits names a pid the reading did
    // not contain.
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'rhizo-elsewhere-'))
    roots.push(elsewhere)
    const collector = createProcessCollector({
      readTable: readerFor({ rows: [row()] }, { rows: [row({ cwd: elsewhere }), row({ pid: 77, argv: ['bash'] })] }),
    })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(first.events).toHaveLength(1)
    expect(second.events.filter((e) => e.type === 'process.gone')).toEqual([])
  })

  it('an agent that was NEVER ours is still recorded nowhere — the non-goal is not weakened', async () => {
    // The carry-forward must not become a way for every agent on the machine to
    // enter the snapshot. Only an actor this collector already announced is
    // held through a placement change; one that was never rooted is invisible,
    // which is ADR-0052's sharpest non-goal.
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'rhizo-elsewhere-'))
    roots.push(elsewhere)
    const collector = createProcessCollector({ readTable: readerFor({ rows: [row({ cwd: elsewhere })] }, { rows: [] }) })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(first.events).toEqual([])
    expect(Object.keys((first.nextSnapshot as ProcessSnapshot).actors)).toEqual([])
    // And therefore no `gone` when it leaves — a death for a process this
    // collector never mentioned would be noise about the operator's machine.
    expect(second.events).toEqual([])
  })

  it('no activity is emitted while an actor is unplaceable — work outside the repo is not ours to report', async () => {
    const collector = createProcessCollector({
      readTable: readerFor({ rows: [row({ cpuMs: 100 })] }, stillThere({ cwd: null, cpuMs: 9_000 })),
    })
    const first = await collector.poll(collector.initialSnapshot(), contextFor(1000))
    const second = await collector.poll(first.nextSnapshot, contextFor(2000))

    expect(typesOf(first.events)).toEqual(['process.seen'])
    expect(second.events).toEqual([])
  })
})

describe('parentPid names an actor that was actually announced (review of #555, offered)', () => {
  it('a parent OUTSIDE the repo is not named — null beats a dangling reference', async () => {
    // The parent set was built from every signature match, before the rooted
    // filter, so a rooted worker whose conductor ran elsewhere was emitted with
    // `parentPid: 900` — a pid no `process.seen` ever mentioned. Any consumer
    // joining that to a known actor gets a dangling reference, and wave 4 is
    // where something will want that join. "No known actor parent" is true;
    // a pid nobody announced is not.
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'rhizo-elsewhere-'))
    roots.push(elsewhere)
    const conductor = row({ pid: 900, cwd: elsewhere })
    const worker = row({ pid: 200, parentPid: 900 })
    const collector = createProcessCollector({ readTable: readerFor({ rows: [conductor, worker] }) })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor(1000))

    expect(typesOf(events)).toEqual(['process.seen'])
    expect((events[0]?.payload as { pid: number }).pid).toBe(200)
    expect((events[0]?.payload as { parentPid: number | null }).parentPid).toBeNull()
  })

  it('every parentPid emitted in a tick is a pid that tick also announced', async () => {
    // The invariant rather than the case, so a future change that reintroduces
    // a dangling parent fails here whatever shape it takes.
    const conductor = row({ pid: 100, cpuMs: 1 })
    const worker = row({ pid: 200, parentPid: 100 })
    const orphan = row({ pid: 300, parentPid: 999 })
    const collector = createProcessCollector({ readTable: readerFor({ rows: [conductor, worker, orphan] }) })
    const { events } = await collector.poll(collector.initialSnapshot(), contextFor(1000))

    const announced = new Set(events.map((e) => (e.payload as { pid: number }).pid))
    for (const event of events) {
      const parent = (event.payload as { parentPid: number | null }).parentPid
      if (parent !== null) expect(announced, `parentPid ${parent} was never announced`).toContain(parent)
    }
  })
})

describe('placement — a LANE is the repo, not another repository (#645)', () => {
  /**
   * The fixture every earlier test in this file got wrong, and the reason the
   * defect shipped: `beforeEach` above puts its worktree at
   * `repoRoot/wt/lane-a`, INSIDE the repo directory, where plain containment
   * happens to be right. `git worktree add` normally puts a lane outside it —
   * this repo's own lanes live under `~/.local/share/rhizomorph/lab/worktrees/`
   * — and there containment alone called every real agent `unrooted`, a word
   * `actorPlacementSchema` reserves for *belongs to no repository*, and dropped
   * it. The instrument was blind to every agent it existed to watch.
   */
  let lane: string
  let elsewhere: string

  beforeEach(() => {
    const outside = mkdtempSync(path.join(tmpdir(), 'rhizo-proc-lanes-'))
    roots.push(outside)
    lane = path.join(outside, 'worktrees', 'lane-a')
    elsewhere = path.join(outside, 'another-repo')
    mkdirSync(lane, { recursive: true })
    mkdirSync(elsewhere, { recursive: true })
  })

  const pollWith = async (options: Parameters<typeof createProcessCollector>[0], cwd: string) => {
    const collector = createProcessCollector({ ...options, readTable: readerFor({ rows: [row({ cwd })] }) })
    return collector.poll(collector.initialSnapshot(), contextFor(1_788_000_100_000))
  }

  it('announces an agent working in a linked worktree OUTSIDE the repo directory', async () => {
    const result = await pollWith({ worktreePaths: () => [lane] }, lane)

    const seen = result.events.filter((event) => event.type === 'process.seen')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.payload).toMatchObject({ placement: 'rooted', worktreePath: canonicalize(lane) })
  })

  it('and does NOT, given the same row, when the worktree list is empty — the control', async () => {
    // Without this arm the test above passes for a collector that announces
    // every agent anywhere, which is the opposite defect. The single bit of
    // difference between the two cases is the list the instrument already holds.
    const result = await pollWith({}, lane)
    expect(typesOf(result.events)).not.toContain('process.seen')
  })

  it('an agent in ANOTHER repository is still not this colony to record — ruling 2 intact', async () => {
    // Widening placement must not widen the RECORDING. Another repo's agent
    // belongs in that repo's recording, and discovery is how it gets one.
    const result = await pollWith({ worktreePaths: () => [lane] }, elsewhere)
    expect(typesOf(result.events)).not.toContain('process.seen')
  })

  it('reads the worktree list FRESH on every tick, so a lane added mid-run is seen', async () => {
    // A boot-time copy would route by the fleet as it was at start-up forever.
    let known: string[] = []
    const collector = createProcessCollector({
      worktreePaths: () => known,
      readTable: readerFor({ rows: [row({ cwd: lane })] }, { rows: [row({ cwd: lane })] }),
    })

    const first = await collector.poll(collector.initialSnapshot(), contextFor(1_788_000_100_000))
    expect(typesOf(first.events)).not.toContain('process.seen')

    known = [lane]
    const second = await collector.poll(first.nextSnapshot, contextFor(1_788_000_200_000))
    expect(typesOf(second.events)).toContain('process.seen')
  })
})

describe('the census — the machine-wide reading discovery needs (#645)', () => {
  it('publishes every matched agent, INCLUDING the ones the repo filter drops', async () => {
    /**
     * The circularity this breaks: discovery used to read the fold, the fold
     * held only what survived the filter, and the filter kept only this repo —
     * so a repo could be discovered only once an actor in it had already been
     * recorded, and it was recorded only once its repo had been discovered.
     */
    const foreign = mkdtempSync(path.join(tmpdir(), 'rhizo-proc-foreign-'))
    roots.push(foreign)

    const published: { pid: number; worktreePath: string | null }[][] = []
    const collector = createProcessCollector({
      onCensus: (sightings) => published.push(sightings.map((s) => ({ pid: s.pid, worktreePath: s.worktreePath }))),
      readTable: readerFor({
        rows: [
          row({ pid: 1, cwd: path.join(repoRoot, 'wt', 'lane-a') }),
          row({ pid: 2, cwd: foreign }),
          row({ pid: 3, argv: ['vim'], cwd: foreign }),
        ],
      }),
    })

    const result = await collector.poll(collector.initialSnapshot(), contextFor(1_788_000_100_000))

    // pid 2 is in the census and in NO event: seen by discovery, recorded by
    // nobody. pid 3 is in neither, because it is not an agent.
    expect(published).toHaveLength(1)
    expect(published[0]?.map((s) => s.pid)).toEqual([1, 2])
    expect(published[0]?.find((s) => s.pid === 2)?.worktreePath).toBe(canonicalize(foreign))
    expect(result.events.filter((event) => event.type === 'process.seen')).toHaveLength(1)
  })

  it('publishes NOTHING when the table could not be read — an empty census is a lie', async () => {
    // `[]` would be indistinguishable from an idle machine, and the sweep that
    // read it would stop finding colonies that are still there.
    const published: unknown[] = []
    const collector = createProcessCollector({ onCensus: (s) => published.push(s), readTable: readerFor(null) })

    await collector.poll(collector.initialSnapshot(), contextFor(1_788_000_100_000))
    expect(published).toHaveLength(0)
  })
})
