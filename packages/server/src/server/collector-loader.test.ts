import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AnyCollector, CollectorContext, Exec, ExecResult } from '@rhizomorph/core'
import { createEvent, createIdFactory, reduceAll } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_FAILURE_THRESHOLD, DEFAULT_RETRY_INTERVAL_MS } from '../collectors/resilience.js'
import { loadCollectors } from './collector-loader.js'
import { createPollLoop } from './poll-loop.js'
import type { SessionRecorder } from './recorder.js'

describe('loadCollectors', () => {
  it('registers all five collectors', async () => {
    const collectors = await loadCollectors({ warn: () => {} })

    expect(collectors.map((c) => c.name).sort()).toEqual(['git', 'judge', 'sessionlog', 'tmux', 'workmux'])
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
