import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AnyCollector, CollectorContext, Exec, ExecResult } from '@rhizomorph/core'
import { createEvent, createIdFactory, initialSessionState, reduceAll } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_FAILURE_THRESHOLD, DEFAULT_RETRY_INTERVAL_MS } from '../collectors/resilience.js'
import { loadCollectors } from './collector-loader.js'
import { createPollLoop } from './poll-loop.js'
import type { SessionRecorder } from './recorder.js'

describe('loadCollectors', () => {
  it('registers all seven collectors', async () => {
    const collectors = await loadCollectors({ warn: () => {} })

    expect(collectors.map((c) => c.name).sort()).toEqual(['beacon', 'git', 'judge', 'pi', 'sessionlog', 'tmux', 'workmux'])
  })

  it('never warns for the real collectors, which are always present', async () => {
    const warnings: string[] = []
    await loadCollectors({ warn: (m) => warnings.push(m) })

    expect(warnings).toEqual([])
  })
})

function makeCollector(name: string, options: { throws?: boolean } = {}): AnyCollector {
  return {
    name,
    initialSnapshot: () => ({ polls: 0 }),
    poll: (prevSnapshot: { polls: number }, context: CollectorContext) => {
      if (options.throws) throw new Error(`${name} blew up`)
      return {
        nextSnapshot: { polls: prevSnapshot.polls + 1 },
        events: [context.emit('collector.error', { collector: name, message: 'ok' })],
      }
    },
  }
}

describe('a collector that throws on poll', () => {
  it('is isolated from the others', async () => {
    const events: unknown[] = []
    const recorder = {
      record: async (event: unknown) => {
        events.push(event)
      },
      // The degrade path goes through `recordAlarm` since ADR-0030, and the
      // broken collector below drives it. A writable disk, so it appends.
      recordAlarm: async (event: unknown) => {
        events.push(event)
        return { appended: true }
      },
      // prd17 ruling 5: every tick's raiser reads `foldSoFar()` — absent here
      // before this fence widening (#278), which is exactly why it went
      // unnoticed until a tick finally called it. `initialSessionState()` has
      // no worktrees and no telemetry, so `buildFleet` folds it to zero lanes
      // and zero pathologies: the raiser sees nothing to raise, and this test
      // stays about collector isolation, not the raiser — `collectorsHeardFrom`
      // is still exactly `['broken', 'healthy']`.
      foldSoFar: () => initialSessionState(),
      // Still a partial double even with `foldSoFar` added — no `subscribe`,
      // `eventsSoFar`, `sessionId`, `isSealed`/`close` — so the cast stays;
      // this test exercises none of those.
    } as unknown as SessionRecorder

    const healthy = makeCollector('healthy')
    const broken = makeCollector('broken', { throws: true })

    const pollLoop = createPollLoop({
      repoPath: '/tmp/repo',
      collectors: [broken, healthy],
      recorder,
      exec: async () => ({ stdout: '', stderr: '', code: 0, failed: false }),
      now: () => 0,
    })

    await pollLoop.tick()

    const collectorsHeardFrom = events.map(
      (event) => (event as { payload: { collector: string } }).payload.collector,
    )
    expect(collectorsHeardFrom).toEqual(['broken', 'healthy'])

    const brokenErrorEvent = events[0] as { type: string; payload: { message: string } }
    expect(brokenErrorEvent.type).toBe('collector.error')
    expect(brokenErrorEvent.payload.message).toBe('broken blew up')
  })
})

describe('loadCollectors — resume reconciliation (#111)', () => {
  it('clears a stale collector.disabled left in the resumed session once a fresh poll succeeds', async () => {
    // The exact shape of the bug: this session's log already folds tmux to
    // "disabled" — from a run that ended before this process ever polled —
    // and this process's own resilience snapshot has no memory of that
    // failure (a fresh boot, or a snapshot from before #110's envelope
    // existed). tmux itself is fine right now.
    const nextId = createIdFactory('evt')
    const priorEvents = [
      createEvent(
        'collector.disabled',
        { collector: 'tmux', reason: 'tmux exited with code 1', consecutiveFailures: 3 },
        { id: nextId(), ts: 1000 },
      ),
    ]
    const foldedBefore = reduceAll(priorEvents)
    expect(foldedBefore.collectors.tmux?.status).toBe('disabled')

    const collectors = await loadCollectors({ warn: () => {} }, priorEvents)
    const tmux = collectors.find((c) => c.name === 'tmux')
    if (!tmux) throw new Error('tmux collector missing')

    const ok: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }
    const exec: Exec = async () => ok
    const recorded: unknown[] = []
    const context: CollectorContext = {
      repoPath: '/repo',
      now: 2000,
      exec,
      nextId,
      emit: (type, payload) => {
        const event = createEvent(type, payload, { id: nextId(), ts: 2000 })
        recorded.push(event)
        return event
      },
    }

    const result = await tmux.poll(tmux.initialSnapshot(), context)

    expect(result.events.some((event) => event.type === 'collector.recovered')).toBe(true)

    const foldedAfter = reduceAll([...priorEvents, ...result.events])
    expect(foldedAfter.collectors.tmux?.status).toBe('healthy')
  })
})

describe('loadCollectors — agent reconciliation (#418)', () => {
  it('retires a folded agent absent from the first live poll, when the workmux snapshot is missing', async () => {
    // The exact shape of the bug: this session's log already folds
    // 'old-lane' to present — from a run that ended before this process
    // ever polled — and workmux's own snapshot has no memory of that
    // departure (a fresh boot, or a lost/pruned snapshot dir). workmux
    // itself reports zero agents right now.
    const nextId = createIdFactory('evt')
    const priorEvents = [
      createEvent(
        'agent.status',
        { handle: 'old-lane', status: 'working', branch: 'old-lane', worktreePath: '../old-lane', elapsedSeconds: 60 },
        { id: nextId(), ts: 1000 },
      ),
    ]
    const foldedBefore = reduceAll(priorEvents)
    expect(foldedBefore.agents['old-lane']?.present).toBe(true)

    const collectors = await loadCollectors({ warn: () => {} }, priorEvents)
    const workmux = collectors.find((c) => c.name === 'workmux')
    if (!workmux) throw new Error('workmux collector missing')

    const emptyStatus: ExecResult = { stdout: '[]', stderr: '', code: 0, failed: false }
    const emptyList: ExecResult = { stdout: '[]', stderr: '', code: 0, failed: false }
    const exec: Exec = async (_command, args) => (args[0] === 'list' ? emptyList : emptyStatus)

    function context(now: number): CollectorContext {
      return {
        repoPath: '/repo',
        now,
        exec,
        nextId,
        emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: now }),
      }
    }

    const first = await workmux.poll(workmux.initialSnapshot(), context(2000))

    expect(first.events).toEqual([expect.objectContaining({ type: 'agent.removed', payload: { handle: 'old-lane' } })])

    const foldedAfter = reduceAll([...priorEvents, ...first.events])
    expect(foldedAfter.agents['old-lane']?.present).toBe(false)

    // Repetition: the wiring inherits the wrapper's own once-only latch, not
    // just the unit test's — a second poll on the same collector, with the
    // handle still missing, must not re-emit.
    const second = await workmux.poll(first.nextSnapshot, context(3000))
    expect(second.events).toHaveLength(0)
  })
})

describe('loadCollectors — branch reconciliation (#449)', () => {
  it('retires a folded ghost branch absent from the first live poll, when the git snapshot has no memory of it', async () => {
    // The exact shape of the bug: this session's log already folds
    // 'old-feature' into `folded.branches` — from a run that ended before
    // this process ever polled, or from before #137 taught the collector to
    // diff branch removals at all — and the git collector's own persisted
    // snapshot has no memory of it (a fresh boot with no snapshot). git
    // itself reports only 'main' right now.
    const nextId = createIdFactory('evt')
    const priorEvents = [
      createEvent('branch.updated', { branch: 'old-feature', head: 'aaaaaaaaaa' }, { id: nextId(), ts: 1000 }),
    ]
    const foldedBefore = reduceAll(priorEvents)
    expect(foldedBefore.branches['old-feature']).toBeDefined()

    const collectors = await loadCollectors({ warn: () => {} }, priorEvents)
    const git = collectors.find((c) => c.name === 'git')
    if (!git) throw new Error('git collector missing')

    const MAIN_HEAD = '1111111111111111111111111111111111111111'
    const worktreeList: ExecResult = {
      stdout: `worktree /repo\nHEAD ${MAIN_HEAD}\nbranch refs/heads/main\n`,
      stderr: '',
      code: 0,
      failed: false,
    }
    const refs: ExecResult = { stdout: `main ${MAIN_HEAD}\n`, stderr: '', code: 0, failed: false }
    const status: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }
    const exec: Exec = async (_command, args) => {
      if (args[0] === 'worktree') return worktreeList
      if (args[0] === 'for-each-ref') return refs
      return status
    }

    function context(now: number): CollectorContext {
      return {
        repoPath: '/repo',
        now,
        exec,
        nextId,
        emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: now }),
      }
    }

    const first = await git.poll(git.initialSnapshot(), context(2000))

    expect(first.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'branch.removed', payload: { branch: 'old-feature' } })]),
    )

    const foldedAfter = reduceAll([...priorEvents, ...first.events])
    expect(foldedAfter.branches['old-feature']).toBeUndefined()

    // Repetition: the wiring inherits the wrapper's own once-only latch, not
    // just the unit test's — a second poll on the same collector, with the
    // branch still missing, must not re-emit.
    const second = await git.poll(first.nextSnapshot, context(3000))
    expect(second.events.filter((event) => event.type === 'branch.removed')).toHaveLength(0)
  })
})

describe('loadCollectors — dirty-status reconciliation (#536)', () => {
  it('emits worktree.dirtyStatusRecovered for a folded open incident when the first live poll after resume is healthy', async () => {
    const nextId = createIdFactory('evt')
    const MAIN_HEAD = '1111111111111111111111111111111111111111'
    const priorEvents = [
      createEvent(
        'worktree.discovered',
        {
          path: '/repo',
          branch: 'main',
          head: MAIN_HEAD,
          isMain: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        { id: nextId(), ts: 1000 },
      ),
      createEvent(
        'worktree.dirtyStatusFailed',
        { worktreePath: '/repo', consecutiveFailures: 4, message: 'git status --porcelain failed' },
        { id: nextId(), ts: 1500 },
      ),
    ]
    const foldedBefore = reduceAll(priorEvents)
    expect(foldedBefore.worktrees['/repo']?.dirtyStatusFailedSince).toBe(1500)

    const collectors = await loadCollectors({ warn: () => {} }, priorEvents)
    const git = collectors.find((c) => c.name === 'git')
    if (!git) throw new Error('git collector missing')

    const worktreeList: ExecResult = {
      stdout: `worktree /repo\nHEAD ${MAIN_HEAD}\nbranch refs/heads/main\n`,
      stderr: '',
      code: 0,
      failed: false,
    }
    const refs: ExecResult = { stdout: `main ${MAIN_HEAD}\n`, stderr: '', code: 0, failed: false }
    const status: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }
    const exec: Exec = async (_command, args) => {
      if (args[0] === 'worktree') return worktreeList
      if (args[0] === 'for-each-ref') return refs
      return status
    }

    function context(now: number): CollectorContext {
      return {
        repoPath: '/repo',
        now,
        exec,
        nextId,
        emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: now }),
      }
    }

    const first = await git.poll(git.initialSnapshot(), context(2000))

    expect(first.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'worktree.dirtyStatusRecovered', payload: { worktreePath: '/repo' } }),
      ]),
    )

    const foldedAfter = reduceAll([...priorEvents, ...first.events])
    expect(foldedAfter.worktrees['/repo']?.dirtyStatusFailedSince).toBeNull()

    // Repetition: the wiring inherits the wrapper's one-shot latch.
    const second = await git.poll(first.nextSnapshot, context(3000))
    expect(second.events.filter((event) => event.type === 'worktree.dirtyStatusRecovered')).toHaveLength(0)
  })

  it('leaves a still-failing worktree open — not spuriously recovered', async () => {
    const nextId = createIdFactory('evt')
    const MAIN_HEAD = '1111111111111111111111111111111111111111'
    const priorEvents = [
      createEvent(
        'worktree.discovered',
        {
          path: '/repo',
          branch: 'main',
          head: MAIN_HEAD,
          isMain: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        { id: nextId(), ts: 1000 },
      ),
      createEvent(
        'worktree.dirtyStatusFailed',
        { worktreePath: '/repo', consecutiveFailures: 4, message: 'git status --porcelain failed' },
        { id: nextId(), ts: 1500 },
      ),
    ]
    const foldedBefore = reduceAll(priorEvents)
    expect(foldedBefore.worktrees['/repo']?.dirtyStatusFailedSince).toBe(1500)

    const collectors = await loadCollectors({ warn: () => {} }, priorEvents)
    const git = collectors.find((c) => c.name === 'git')
    if (!git) throw new Error('git collector missing')

    const worktreeList: ExecResult = {
      stdout: `worktree /repo\nHEAD ${MAIN_HEAD}\nbranch refs/heads/main\n`,
      stderr: '',
      code: 0,
      failed: false,
    }
    const refs: ExecResult = { stdout: `main ${MAIN_HEAD}\n`, stderr: '', code: 0, failed: false }
    const failingStatus: ExecResult = { stdout: '', stderr: 'fatal: unable to read index', code: 128, failed: true }
    const exec: Exec = async (_command, args) => {
      if (args[0] === 'worktree') return worktreeList
      if (args[0] === 'for-each-ref') return refs
      return failingStatus
    }

    function context(now: number): CollectorContext {
      return {
        repoPath: '/repo',
        now,
        exec,
        nextId,
        emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: now }),
      }
    }

    const first = await git.poll(git.initialSnapshot(), context(2000))

    expect(first.events.some((event) => event.type === 'worktree.dirtyStatusRecovered')).toBe(false)

    const foldedAfter = reduceAll([...priorEvents, ...first.events])
    expect(foldedAfter.worktrees['/repo']?.dirtyStatusFailedSince).not.toBeNull()
  })

  // #536 Finding A: the case the old boolean latch could not survive. Poll 1
  // hits a per-path status failure (no collector.disabled) and must not spend
  // the wrapper's only shot; poll 2 comes back clean and closes the incident.
  it('stays pending through a per-path failure with no collector.disabled and closes on the next healthy poll', async () => {
    const nextId = createIdFactory('evt')
    const MAIN_HEAD = '1111111111111111111111111111111111111111'
    const priorEvents = [
      createEvent(
        'worktree.discovered',
        {
          path: '/repo',
          branch: 'main',
          head: MAIN_HEAD,
          isMain: true,
          detached: false,
          locked: false,
          prunable: false,
        },
        { id: nextId(), ts: 1000 },
      ),
      createEvent(
        'worktree.dirtyStatusFailed',
        { worktreePath: '/repo', consecutiveFailures: 4, message: 'git status --porcelain failed' },
        { id: nextId(), ts: 1500 },
      ),
    ]
    const foldedBefore = reduceAll(priorEvents)
    expect(foldedBefore.worktrees['/repo']?.dirtyStatusFailedSince).toBe(1500)

    const collectors = await loadCollectors({ warn: () => {} }, priorEvents)
    const git = collectors.find((c) => c.name === 'git')
    if (!git) throw new Error('git collector missing')

    const worktreeList: ExecResult = {
      stdout: `worktree /repo\nHEAD ${MAIN_HEAD}\nbranch refs/heads/main\n`,
      stderr: '',
      code: 0,
      failed: false,
    }
    const refs: ExecResult = { stdout: `main ${MAIN_HEAD}\n`, stderr: '', code: 0, failed: false }
    const failingStatus: ExecResult = { stdout: '', stderr: 'fatal: unable to read index', code: 128, failed: true }
    const healthyStatus: ExecResult = { stdout: '', stderr: '', code: 0, failed: false }

    let statusCalls = 0
    const exec: Exec = async (_command, args) => {
      if (args[0] === 'worktree') return worktreeList
      if (args[0] === 'for-each-ref') return refs
      statusCalls += 1
      return statusCalls === 1 ? failingStatus : healthyStatus
    }

    function context(now: number): CollectorContext {
      return {
        repoPath: '/repo',
        now,
        exec,
        nextId,
        emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: now }),
      }
    }

    const first = await git.poll(git.initialSnapshot(), context(2000))
    expect(first.events.some((event) => event.type === 'worktree.dirtyStatusRecovered')).toBe(false)
    expect(first.events.some((event) => event.type === 'collector.disabled')).toBe(false)

    const second = await git.poll(first.nextSnapshot, context(3000))
    expect(second.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'worktree.dirtyStatusRecovered', payload: { worktreePath: '/repo' } }),
      ]),
    )

    const foldedAfter = reduceAll([...priorEvents, ...first.events, ...second.events])
    expect(foldedAfter.worktrees['/repo']?.dirtyStatusFailedSince).toBeNull()
  })
})

describe('loadCollectors — sessionlog (#240)', () => {
  let claudeProjectsRoot: string

  beforeEach(async () => {
    claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'collector-loader-sessionlog-'))
  })

  afterEach(async () => {
    await rm(claudeProjectsRoot, { recursive: true, force: true })
  })

  it('registers sessionlog wrapped in resilience, so it also reconciles a stale collector.disabled on resume', async () => {
    const nextId = createIdFactory('evt')
    const priorEvents = [
      createEvent(
        'collector.disabled',
        { collector: 'sessionlog', reason: 'no Claude Code session log directory', consecutiveFailures: 3 },
        { id: nextId(), ts: 1000 },
      ),
    ]
    const foldedBefore = reduceAll(priorEvents)
    expect(foldedBefore.collectors.sessionlog?.status).toBe('disabled')

    const collectors = await loadCollectors({ warn: () => {} }, priorEvents, { claudeProjectsRoot })
    const sessionlog = collectors.find((c) => c.name === 'sessionlog')
    if (!sessionlog) throw new Error('sessionlog collector missing')

    const ok: ExecResult = { stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n', stderr: '', code: 0, failed: false }
    const exec: Exec = async () => ok
    const context: CollectorContext = {
      repoPath: '/repo',
      now: 2000,
      exec,
      nextId,
      emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: 2000 }),
    }

    const result = await sessionlog.poll(sessionlog.initialSnapshot(), context)

    expect(result.events.some((event) => event.type === 'collector.recovered')).toBe(true)

    const foldedAfter = reduceAll([...priorEvents, ...result.events])
    expect(foldedAfter.collectors.sessionlog?.status).toBe('healthy')
  })

  it('retries a run of failed git worktree list calls instead of disabling forever, then recovers (#240 done-when)', async () => {
    const fail: ExecResult = { stdout: '', stderr: 'fatal: transient', code: 128, failed: true }
    const ok: ExecResult = { stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n', stderr: '', code: 0, failed: false }
    let gitCalls = 0
    const exec: Exec = async (command) => {
      if (command !== 'git') return ok
      gitCalls += 1
      return gitCalls <= DEFAULT_FAILURE_THRESHOLD ? fail : ok
    }

    const collectors = await loadCollectors({ warn: () => {} }, [], { claudeProjectsRoot })
    const sessionlog = collectors.find((c) => c.name === 'sessionlog')
    if (!sessionlog) throw new Error('sessionlog collector missing')

    const nextId = createIdFactory('evt')
    function context(now: number): CollectorContext {
      return {
        repoPath: '/repo',
        now,
        exec,
        nextId,
        emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: now }),
      }
    }

    let snapshot = sessionlog.initialSnapshot()
    let lastEvents: readonly { type: string }[] = []
    for (let attempt = 1; attempt <= DEFAULT_FAILURE_THRESHOLD; attempt += 1) {
      const tick = await sessionlog.poll(snapshot, context(attempt * 1000))
      snapshot = tick.nextSnapshot
      lastEvents = tick.events
    }
    // Threshold consecutive failures actually disable it, with the count named.
    expect(lastEvents.some((event) => event.type === 'collector.disabled')).toBe(true)

    // Still inside the backoff window: the wrapper skips the attempt entirely.
    const backingOff = await sessionlog.poll(snapshot, context(DEFAULT_FAILURE_THRESHOLD * 1000 + 1))
    expect(gitCalls).toBe(DEFAULT_FAILURE_THRESHOLD)
    snapshot = backingOff.nextSnapshot

    // Past the retry interval, and git is healthy again: it resumes reporting.
    const recovered = await sessionlog.poll(
      snapshot,
      context(DEFAULT_FAILURE_THRESHOLD * 1000 + DEFAULT_RETRY_INTERVAL_MS + 1),
    )
    expect(recovered.events.some((event) => event.type === 'collector.recovered')).toBe(true)
    expect(gitCalls).toBe(DEFAULT_FAILURE_THRESHOLD + 1)
  })
})

describe('loadCollectors — pi (#546)', () => {
  let piSessionsRoot: string

  beforeEach(async () => {
    piSessionsRoot = await mkdtemp(path.join(tmpdir(), 'collector-loader-pi-'))
  })

  afterEach(async () => {
    await rm(piSessionsRoot, { recursive: true, force: true })
  })

  it('registers pi wrapped in resilience, so it also reconciles a stale collector.disabled on resume', async () => {
    const nextId = createIdFactory('evt')
    const priorEvents = [
      createEvent(
        'collector.disabled',
        { collector: 'pi', reason: 'no pi session directory', consecutiveFailures: 3 },
        { id: nextId(), ts: 1000 },
      ),
    ]
    const foldedBefore = reduceAll(priorEvents)
    expect(foldedBefore.collectors.pi?.status).toBe('disabled')

    const collectors = await loadCollectors({ warn: () => {} }, priorEvents, {}, { piSessionsRoot })
    const pi = collectors.find((c) => c.name === 'pi')
    if (!pi) throw new Error('pi collector missing')

    const ok: ExecResult = { stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n', stderr: '', code: 0, failed: false }
    const exec: Exec = async () => ok
    const context: CollectorContext = {
      repoPath: '/repo',
      now: 2000,
      exec,
      nextId,
      emit: (type, payload) => createEvent(type, payload, { id: nextId(), ts: 2000 }),
    }

    const result = await pi.poll(pi.initialSnapshot(), context)

    expect(result.events.some((event) => event.type === 'collector.recovered')).toBe(true)

    const foldedAfter = reduceAll([...priorEvents, ...result.events])
    expect(foldedAfter.collectors.pi?.status).toBe('healthy')
  })
})
