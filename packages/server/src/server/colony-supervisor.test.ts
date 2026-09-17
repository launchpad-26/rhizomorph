import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { repoSlug, sessionDirFor } from '../log/paths.js'
import { createColonyRecorders } from '../recorder/colony-recorders.js'
import { SessionRecorder } from '../recorder/session-recorder.js'
import type { Colony } from './colonies.js'
import { createColonySupervisor } from './colony-supervisor.js'
import type { PollLoop } from './poll-loop.js'

/** prd-58 ruling 2: one poll loop and one recorder per colony, under one server. */

let dataRoot: string
const PINNED_PATH = '/repo/main'

function colony(repoPath: string, pinned = false): Colony {
  return { id: repoSlug(repoPath), path: repoPath, pinned }
}

const PINNED = colony(PINNED_PATH, true)
const OTHER = colony('/elsewhere/proj')
const THIRD = colony('/elsewhere/third')

beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizo-colsup-'))
})

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true })
})

/** A loop that records what was asked of it, and never touches a real process. */
function fakeLoop(): PollLoop & { stopped: number } {
  const loop = {
    stopped: 0,
    start: () => {},
    stop: async () => {
      loop.stopped += 1
    },
    tick: async () => {},
    reset: () => {},
  }
  return loop as PollLoop & { stopped: number }
}

function make(overrides: { startColony?: (c: Colony, r: SessionRecorder) => Promise<PollLoop> } = {}) {
  const started: Colony[] = []
  const loops = new Map<string, PollLoop & { stopped: number }>()
  const failures: { colony: Colony; cause: unknown }[] = []

  const recorders = createColonyRecorders({
    dataRoot,
    pinned: {
      colony: PINNED,
      recorder: new SessionRecorder('boot', path.join(sessionDirFor(PINNED_PATH, dataRoot), 'boot.jsonl')),
    },
    now: () => 7_000_000,
  })

  const supervisor = createColonySupervisor({
    recorders,
    startColony:
      overrides.startColony ??
      (async (c) => {
        started.push(c)
        const loop = fakeLoop()
        loops.set(c.id, loop)
        return loop
      }),
    onStartFailed: (colony, cause) => failures.push({ colony, cause }),
  })

  return { supervisor, started, loops, failures, recorders }
}

describe('createColonySupervisor', () => {
  it('starts one loop per colony, and each gets its own recorder', async () => {
    const { supervisor, started } = make()
    await supervisor.sync([PINNED, OTHER])

    expect(started.map((c) => c.id)).toEqual([PINNED.id, OTHER.id])

    const recorders = supervisor.running().map((entry) => entry.recorder)
    expect(recorders[0]).not.toBe(recorders[1])
    expect(new Set(recorders.map((r) => r.filePath)).size).toBe(2)
  })

  it('does NOT start the ADOPTED colony — the boot already runs it', async () => {
    /**
     * The defect the Linux gate caught, kept as a permanent case.
     *
     * The boot opens the pinned colony's recorder, collectors and loop before
     * discovery has run once, and discovery reports that colony every tick
     * because the pin is always in the watched set. Without the adoption the
     * supervisor starts a SECOND loop against the same recorder — two writers,
     * one log, every event recorded twice. It surfaced as a rotated session
     * whose fresh file held three events where one was expected.
     */
    const started: Colony[] = []
    const bootLoop = fakeLoop()
    const recorders = createColonyRecorders({
      dataRoot,
      pinned: {
        colony: PINNED,
        recorder: new SessionRecorder('boot', path.join(sessionDirFor(PINNED_PATH, dataRoot), 'boot.jsonl')),
      },
      now: () => 7_000_000,
    })
    const bootRecorder = recorders.forColony(PINNED)
    const supervisor = createColonySupervisor({
      recorders,
      adopt: { colony: PINNED, recorder: bootRecorder, pollLoop: bootLoop },
      startColony: async (c) => {
        started.push(c)
        return fakeLoop()
      },
      onStartFailed: () => {},
    })

    await supervisor.sync([PINNED, OTHER])

    expect(started.map((c) => c.id)).toEqual([OTHER.id])
    expect(supervisor.running().map((e) => e.colony.id).sort()).toEqual([PINNED.id, OTHER.id].sort())

    // And shutdown does not stop a loop it never started: the boot owns that
    // one, and stopping it here would make `stop()` mean two different things.
    await supervisor.stop()
    expect(bootLoop.stopped).toBe(0)
  })

  it('does NOT restart a colony it already runs', async () => {
    // Re-starting drops every collector back to `initialSnapshot()`, which
    // re-emits the whole world as freshly discovered. Discovery reports the
    // same colonies every two seconds, so this is the ordinary case rather
    // than an edge one.
    const { supervisor, started } = make()
    await supervisor.sync([PINNED, OTHER])
    await supervisor.sync([PINNED, OTHER])
    await supervisor.sync([PINNED, OTHER, THIRD])

    expect(started.map((c) => c.id)).toEqual([PINNED.id, OTHER.id, THIRD.id])
  })

  it('two overlapping syncs do not build two loops for one colony', async () => {
    // A discovery tick can land while the previous one's start is still
    // awaiting. Without the in-flight guard both see "not running" and open two
    // recorders on one file — two writers, one log.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started: Colony[] = []
    const { supervisor } = make({
      startColony: async (c) => {
        started.push(c)
        await gate
        return fakeLoop()
      },
    })

    const first = supervisor.sync([OTHER])
    const second = supervisor.sync([OTHER])
    release()
    await Promise.all([first, second])

    expect(started).toHaveLength(1)
    expect(supervisor.running()).toHaveLength(1)
  })

  it('keeps a colony whose agents went away — the repo did not stop existing', async () => {
    // Stopping on absence would make the watched set flicker against a process
    // table re-read every two seconds, and would throw away the history the
    // operator came to read.
    const { supervisor } = make()
    await supervisor.sync([PINNED, OTHER])
    await supervisor.sync([PINNED])

    expect(supervisor.running().map((e) => e.colony.id).sort()).toEqual([PINNED.id, OTHER.id].sort())
  })

  it('one colony that cannot start does not take the others down', async () => {
    // The instrument watching two repos beats the instrument watching none
    // because a third had a bad `.git`.
    const { supervisor, failures } = make({
      startColony: async (c) => {
        if (c.id === OTHER.id) throw new Error('no git here')
        return fakeLoop()
      },
    })

    await supervisor.sync([PINNED, OTHER, THIRD])

    expect(supervisor.running().map((e) => e.colony.id).sort()).toEqual([PINNED.id, THIRD.id].sort())
    expect(failures.map((f) => f.colony.id)).toEqual([OTHER.id])
  })

  it('a failed start is REPORTED, never swallowed', async () => {
    // Silence here is indistinguishable from a repo with no agents, which is
    // the one reading that would make the gap invisible.
    const { supervisor, failures } = make({
      startColony: async () => {
        throw new Error('boom')
      },
    })

    await supervisor.sync([OTHER])

    expect(failures).toHaveLength(1)
    expect((failures[0]?.cause as Error).message).toBe('boom')
  })

  it('a failed colony is retried on the next sync, not written off', async () => {
    // A transient failure — a worktree mid-creation, a lock — must not exile a
    // colony for the life of the process.
    let attempts = 0
    const { supervisor } = make({
      startColony: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        return fakeLoop()
      },
    })

    await supervisor.sync([OTHER])
    expect(supervisor.running()).toHaveLength(0)

    await supervisor.sync([OTHER])
    expect(supervisor.running()).toHaveLength(1)
  })

  it('stop() stops every loop, once, and is idempotent', async () => {
    const { supervisor, loops } = make()
    await supervisor.sync([PINNED, OTHER, THIRD])

    await supervisor.stop()
    await supervisor.stop()

    expect([...loops.values()].map((l) => l.stopped)).toEqual([1, 1, 1])
    expect(supervisor.running()).toHaveLength(0)
  })

  it('running() is ordered by colony id, not by start order', async () => {
    const { supervisor } = make()
    await supervisor.sync([colony('/repo/zzz'), colony('/repo/aaa')])
    const ids = supervisor.running().map((e) => e.colony.id)
    expect(ids).toEqual([...ids].sort())
  })
})

describe('shutdown is final (review of #621)', () => {
  /**
   * The boot's discovery sweep is a `setInterval` whose promise nothing awaits,
   * and `syncColonies` awaits `discovery.discover(...)` — which execs `git`
   * with a 5 s timeout — before it ever calls `sync`. So a `^C` landing between
   * those two is the ordinary case rather than the unlucky one.
   *
   * Before this fix `stop()` cleared the running set and left `sync` open, so
   * the late sweep found every colony absent and started it again: a fresh
   * loop for each, the PINNED one included, on the boot's own recorder, while
   * the boot was closing the app and releasing the session lock. Two live
   * writers on one recording — what `adopt` exists to prevent — plus loops
   * nothing would ever stop.
   */
  it('a sweep that reaches sync() after stop() starts nothing', async () => {
    const started: Colony[] = []
    const bootLoop = fakeLoop()
    const recorders = createColonyRecorders({
      dataRoot,
      pinned: {
        colony: PINNED,
        recorder: new SessionRecorder('boot', path.join(sessionDirFor(PINNED_PATH, dataRoot), 'boot.jsonl')),
      },
      now: () => 7_000_000,
    })
    const bootRecorder = recorders.forColony(PINNED)
    const supervisor = createColonySupervisor({
      recorders,
      adopt: { colony: PINNED, recorder: bootRecorder, pollLoop: bootLoop },
      startColony: async (c) => {
        started.push(c)
        return fakeLoop()
      },
      onStartFailed: () => {},
    })

    await supervisor.sync([PINNED, OTHER])
    started.length = 0

    await supervisor.stop()
    await supervisor.sync([PINNED, OTHER, THIRD]) // the sweep, arriving late

    expect(started).toEqual([])
    expect(supervisor.running()).toEqual([])
    // Nothing was handed the boot's recorder a second time.
    expect(supervisor.running().some((e) => e.recorder === bootRecorder)).toBe(false)
  })

  it('a start still in flight when stop() lands is awaited and then stopped', async () => {
    // The other half: `stop()` must not return while a colony is half-built,
    // or that loop finishes starting into a set nobody will ever stop.
    const loops = new Map<string, PollLoop & { stopped: number }>()
    const recorders = createColonyRecorders({
      dataRoot,
      pinned: {
        colony: PINNED,
        recorder: new SessionRecorder('boot', path.join(sessionDirFor(PINNED_PATH, dataRoot), 'boot.jsonl')),
      },
      now: () => 7_000_000,
    })
    const supervisor = createColonySupervisor({
      recorders,
      startColony: async (c) => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        const loop = fakeLoop()
        loops.set(c.id, loop)
        return loop
      },
      onStartFailed: () => {},
    })

    const inFlight = supervisor.sync([OTHER])
    await supervisor.stop()
    await inFlight

    expect(loops.get(OTHER.id)?.stopped).toBe(1)
    expect(supervisor.running()).toEqual([])
  })
})
