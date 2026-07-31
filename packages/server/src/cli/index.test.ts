import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Collector, CollectorContext, Exec, ObservatoryEvent, PollResult } from '@observatory/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionDirFor } from '../log/paths.js'
import { listSessions, readSessionEvents, RESUME_WINDOW_MS } from '../log/session-log.js'
import type { SessionRecorder } from '../server/recorder.js'
import { runCli, type CliHandle } from './index.js'

/** Thrown by the fake `exit` so a would-be `process.exit` unwinds the async call instead of killing the test runner. */
class FakeExit extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`)
  }
}

function fakeExit(): (code: number) => never {
  return ((code: number) => {
    throw new FakeExit(code)
  }) as (code: number) => never
}

/**
 * The poll loop's first tick fires fire-and-forget from `pollLoop.start()`
 * (see `server/poll-loop.ts`), so there is no promise a caller can await for
 * "the boot tick has finished" — a fixed number of manual `tick()` calls
 * races it instead of waiting for it. This awaits the actual boundary: the
 * event landing in the recorder, already-recorded or still to come, bounded
 * by a generous timeout as a safety net rather than the wait mechanism.
 */
async function waitForEvent(
  recorder: SessionRecorder,
  predicate: (event: ObservatoryEvent) => boolean,
  timeoutMs = 5000,
): Promise<ObservatoryEvent> {
  const existing = recorder.eventsSoFar().find(predicate)
  if (existing) return existing

  return await new Promise<ObservatoryEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('timed out waiting for matching event'))
    }, timeoutMs)
    const unsubscribe = recorder.subscribe((event) => {
      if (predicate(event)) {
        clearTimeout(timer)
        unsubscribe()
        resolve(event)
      }
    })
  })
}

/** A fake collector so the boot test needs no real git/tmux/workmux. */
const fakeCollector: Collector<{ ticks: number }> = {
  name: 'fake',
  initialSnapshot: () => ({ ticks: 0 }),
  poll: (prev, context: CollectorContext): PollResult<{ ticks: number }> => ({
    nextSnapshot: { ticks: prev.ticks + 1 },
    events: [context.emit('agent.status', { handle: 'fake', status: 'working' })],
  }),
}

const silentLog = { log: () => {}, warn: () => {} }

interface OffsetCollector {
  collector: Collector<{ offset: number }>
  /**
   * Resolves when poll number `n` begins. Because the loop serialises ticks
   * (one at a time, snapshot persisted before the tick returns), poll `n`
   * starting is proof that tick `n - 1` finished *including its snapshot save*
   * — the boundary these tests actually need, awaited rather than slept past.
   */
  whenPolled(n: number): Promise<void>
}

/**
 * A collector that stands in for sessionlog: it holds a fixed list of source
 * lines and emits each one exactly once, tracking how far it has read in its
 * snapshot. Idempotent by construction, so the number of ticks a test happens
 * to get never changes the events — only whether the offset survived the
 * restart does.
 */
function createOffsetCollector(handles: readonly string[]): OffsetCollector {
  let polls = 0
  const waiters: Array<{ n: number; resolve: () => void }> = []

  return {
    collector: {
      name: 'offset',
      initialSnapshot: () => ({ offset: 0 }),
      poll: (prev, context: CollectorContext): PollResult<{ offset: number }> => {
        polls += 1
        for (const waiter of waiters.splice(0)) {
          if (waiter.n <= polls) waiter.resolve()
          else waiters.push(waiter)
        }
        const offset = prev?.offset ?? 0
        return {
          // A fresh object every poll, so the loop always has a snapshot to persist.
          nextSnapshot: { offset: handles.length },
          events: handles
            .slice(offset)
            .map((handle) => context.emit('agent.status', { handle, status: 'working' })),
        }
      },
    },
    whenPolled(n) {
      if (polls >= n) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.push({ n, resolve }))
    },
  }
}

/** The handles of every `agent.status` event, in order — one per source line consumed. */
function statusHandles(events: readonly ObservatoryEvent[]): string[] {
  return events
    .filter((event): event is Extract<ObservatoryEvent, { type: 'agent.status' }> => event.type === 'agent.status')
    .map((event) => event.payload.handle)
}

function countOfType(events: readonly ObservatoryEvent[], type: ObservatoryEvent['type']): number {
  return events.filter((event) => event.type === type).length
}

describe('runCli', () => {
  let dataRoot: string
  let handle: CliHandle | undefined

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'observatory-cli-test-'))
  })

  afterEach(async () => {
    await handle?.stop()
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('boots collectors + server, emits session.started, and serves them over the API', async () => {
    const repoPath = path.join(tmpdir(), 'my-repo')

    handle = await runCli([repoPath, '--port', '0'], {
      dataRoot,
      collectors: [fakeCollector],
      log: { log: () => {}, warn: () => {} },
    })

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const metaResponse = await fetch(`${handle.url}/api/meta`)
    expect(await metaResponse.json()).toMatchObject({ repoPath, repoName: 'my-repo' })

    // start() already fires one tick immediately; wait for it, then force one more.
    await handle.pollLoop.tick()
    await handle.pollLoop.tick()

    const eventsResponse = await fetch(`${handle.url}/api/sessions/${handle.recorder.sessionId}/events`)
    const { events } = (await eventsResponse.json()) as { events: Array<{ type: string }> }
    expect(events[0]?.type).toBe('session.started')
    expect(events.slice(1).every((e) => e.type === 'agent.status')).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  it('survives a collector that throws by recording collector.error and moving on', async () => {
    const throwingCollector: Collector<undefined> = {
      name: 'broken',
      initialSnapshot: () => undefined,
      poll: () => {
        throw new Error('boom')
      },
    }

    handle = await runCli([path.join(tmpdir(), 'other-repo'), '--port', '0'], {
      dataRoot,
      collectors: [throwingCollector],
      log: { log: () => {}, warn: () => {} },
    })

    // start() already fires one tick fire-and-forget; wait for its collector.error
    // to land (rather than racing it with a manual tick() call, which is a no-op
    // while a tick is still in flight) before forcing a second, guaranteed tick.
    await waitForEvent(handle.recorder, (e) => e.type === 'collector.error')
    await handle.pollLoop.tick()

    const events = handle.recorder.eventsSoFar()
    expect(events[0]?.type).toBe('session.started')
    expect(events.slice(1).every((e) => e.type === 'collector.error')).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  it('wires --extra-sessions into the default sessionlog collector, attributed role: conductor', async () => {
    const claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'observatory-claude-projects-'))
    const extraDir = path.join(tmpdir(), 'observatory-conductor-workdir')
    const projectDir = path.join(claudeProjectsRoot, extraDir.replace(/[/_]/g, '-'))
    await mkdir(projectDir, { recursive: true })

    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        content: [],
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      requestId: 'req-extra-1',
      sessionId: 'sess-extra-1',
      cwd: extraDir,
      gitBranch: null,
    })
    await writeFile(path.join(projectDir, 'sess-extra-1.jsonl'), `${line}\n`)

    // No real git repo behind repoPath: git worktree list is stubbed to "no worktrees",
    // so the only session data tailed comes from --extra-sessions.
    const fakeGitExec: Exec = async (command, cmdArgs) => {
      if (command === 'git' && cmdArgs[0] === 'worktree') {
        return { stdout: '', stderr: '', code: 0, failed: false }
      }
      return { stdout: '', stderr: 'not stubbed', code: 1, failed: true, errorMessage: 'not stubbed' }
    }

    try {
      handle = await runCli(
        // The fixture line above is already on disk before boot; a real boot
        // now seeks a never-before-seen file to EOF (#57) and would emit
        // nothing for it. This test is about conductor attribution, not
        // first-sight semantics, so it opts into --backfill to read that
        // pre-existing line instead.
        [
          path.join(tmpdir(), 'conductor-repo'),
          '--port',
          '0',
          '--extra-sessions',
          extraDir,
          '--backfill',
        ],
        {
          dataRoot,
          claudeProjectsRoot,
          exec: fakeGitExec,
          log: { log: () => {}, warn: () => {} },
        },
      )

      const usage = await waitForEvent(handle.recorder, (e) => e.type === 'llm.usage')
      expect(usage.payload).toMatchObject({ role: 'conductor', model: 'claude-opus-5' })
    } finally {
      await rm(claudeProjectsRoot, { recursive: true, force: true })
    }
  })
})

describe('runCli env subcommand', () => {
  it('prints the telemetry env block for a lane and exits 0', async () => {
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['env', 'test-lane'], { log, exit }).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain('export CLAUDE_CODE_ENABLE_TELEMETRY=1')
    expect(output).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4321')
    expect(output).toContain('export OTEL_RESOURCE_ATTRIBUTES=lane=test-lane,role=worker')
  })

  it('honours --role and --port', async () => {
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['env', 'conductor', '--role', 'conductor', '--port', '5000'], {
      log,
      exit,
    }).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain('export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:5000')
    expect(output).toContain('export OTEL_RESOURCE_ATTRIBUTES=lane=conductor,role=conductor')
  })

  it('prints a clean message + usage to stderr and exits 1 when the lane is missing — no stack trace', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    const thrown = await runCli(['env'], { exit }).catch((err: unknown) => err)

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('missing required argument')
    expect(output).toContain('Options:')
    expect(output).not.toMatch(/^\s*at /m)
    expect(output).not.toContain('.ts:')
  })

  it('prints a clean message + usage to stderr and exits 1 on an invalid --role', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    const thrown = await runCli(['env', 'my-lane', '--role', 'manager'], { exit }).catch(
      (err: unknown) => err,
    )

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('invalid --role value: "manager"')
    expect(output).not.toMatch(/^\s*at /m)
  })

  it('prints env --help to stdout and exits 0, without touching stderr', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['env', '--help'], { log, exit }).catch((err: unknown) => err)

    writeSpy.mockRestore()
    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('observatory env <lane>'))
    expect(writeSpy).not.toHaveBeenCalled()
  })
})

describe('runCli argument errors', () => {
  it('prints a clean message + usage to stderr and exits 1 on an unknown flag — no stack trace', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    const thrown = await runCli(['--version'], { exit }).catch((err: unknown) => err)

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('unknown option: "--version"')
    expect(output).toContain('Options:')
    expect(output).toContain('--port')
    expect(output).not.toMatch(/^\s*at /m)
    expect(output).not.toContain('.ts:')
  })

  it('prints a clean message + usage to stderr and exits 1 on an invalid --port value — no stack trace', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    const thrown = await runCli(['--port', 'abc'], { exit }).catch((err: unknown) => err)

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('invalid --port value: "abc"')
    expect(output).toContain('Options:')
    expect(output).not.toMatch(/^\s*at /m)
    expect(output).not.toContain('.ts:')
  })

  it('prints help to stdout and exits 0 for --help, without touching stderr', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['--help'], { log, exit }).catch((err: unknown) => err)

    writeSpy.mockRestore()
    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('Options:'))
    expect(writeSpy).not.toHaveBeenCalled()
  })
})

describe('runCli doctor subcommand', () => {
  it('runs a read-only preflight (no server boot) and exits 0 when healthy', async () => {
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()
    const repoPath = await mkdtemp(path.join(tmpdir(), 'observatory-doctor-cli-'))
    const webDistDir = await mkdtemp(path.join(tmpdir(), 'observatory-doctor-cli-web-'))
    await writeFile(path.join(webDistDir, 'index.html'), '<html></html>')

    const fakeGitExec: Exec = async (command, cmdArgs) => {
      if (command === 'git' && cmdArgs[0] === 'rev-parse') {
        return { stdout: 'true\n', stderr: '', code: 0, failed: false }
      }
      return { stdout: '', stderr: '', code: null, failed: true, errorMessage: `spawn ${command} ENOENT` }
    }

    try {
      const thrown = await runCli(['doctor', repoPath, '--port', '0'], {
        log,
        exit,
        exec: fakeGitExec,
        webDistDir,
      }).catch((err: unknown) => err)

      expect(thrown).toBeInstanceOf(FakeExit)
      expect((thrown as FakeExit).code).toBe(0)
      const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
      expect(output).toContain('[ok  ]')
      expect(output).toContain('All required checks passed.')
    } finally {
      await rm(repoPath, { recursive: true, force: true })
      await rm(webDistDir, { recursive: true, force: true })
    }
  })

  it('exits 1 and names the remedy when the target is not a git repository', async () => {
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()
    const notGitDir = await mkdtemp(path.join(tmpdir(), 'observatory-doctor-cli-notgit-'))

    const failGitExec: Exec = async (command, cmdArgs) => {
      if (command === 'git' && cmdArgs[0] === 'rev-parse') {
        return { stdout: '', stderr: 'fatal: not a git repository', code: 128, failed: true }
      }
      return { stdout: '', stderr: '', code: null, failed: true, errorMessage: `spawn ${command} ENOENT` }
    }

    try {
      const thrown = await runCli(['doctor', notGitDir, '--port', '0'], {
        log,
        exit,
        exec: failGitExec,
      }).catch((err: unknown) => err)

      expect(thrown).toBeInstanceOf(FakeExit)
      expect((thrown as FakeExit).code).toBe(1)
      const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
      expect(output).toContain('not a git repository')
    } finally {
      await rm(notGitDir, { recursive: true, force: true })
    }
  })

  it('prints doctor --help to stdout and exits 0, without touching stderr', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['doctor', '--help'], { log, exit }).catch((err: unknown) => err)

    writeSpy.mockRestore()
    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('observatory doctor [path]'))
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('prints a clean message + usage to stderr and exits 1 on an invalid --port value', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    const thrown = await runCli(['doctor', '--port', 'abc'], { exit }).catch((err: unknown) => err)

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('invalid --port value: "abc"')
    expect(output).not.toMatch(/^\s*at /m)
    expect(output).not.toContain('.ts:')
  })
})

describe('runCli resuming the run', () => {
  /** A fixed boot clock: session ids, event stamps and the resume window all read from it. */
  const BOOT_MS = 1_700_000_000_000
  const repoPath = path.join(tmpdir(), 'observatory-resume-repo')
  let dataRoot: string
  let handle: CliHandle | undefined

  const boot = async (
    argv: readonly string[],
    nowMs: number,
    collector: Collector<{ offset: number }>,
  ): Promise<CliHandle> =>
    await runCli([repoPath, '--port', '0', ...argv], {
      dataRoot,
      now: () => nowMs,
      collectors: [collector],
      intervalMs: 250,
      log: silentLog,
    })

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'observatory-resume-test-'))
  })

  afterEach(async () => {
    await handle?.stop()
    handle = undefined
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('continues the recent session on the next boot: same file, no duplicate events, offsets carry on', async () => {
    const first = createOffsetCollector(['lane-a', 'lane-b'])
    handle = await boot([], BOOT_MS, first.collector)
    const sessionId = handle.recorder.sessionId
    const filePath = handle.recorder.filePath
    await first.whenPolled(2)
    await handle.stop()

    const afterFirst = await readSessionEvents(filePath)
    expect(countOfType(afterFirst, 'session.started')).toBe(1)
    expect(statusHandles(afterFirst)).toEqual(['lane-a', 'lane-b'])

    // A minute later, restarted, with one new line in the source.
    const second = createOffsetCollector(['lane-a', 'lane-b', 'lane-c'])
    handle = await boot([], BOOT_MS + 60_000, second.collector)

    expect(handle.recorder.sessionId).toBe(sessionId)
    expect(handle.recorder.filePath).toBe(filePath)
    await second.whenPolled(2)

    const afterSecond = await readSessionEvents(filePath)
    // No second session.started, no re-record of lane-a/lane-b: the offset was rehydrated.
    expect(countOfType(afterSecond, 'session.started')).toBe(1)
    expect(statusHandles(afterSecond)).toEqual(['lane-a', 'lane-b', 'lane-c'])
    // One session file for two boots — the 24-files-per-24-boots defect, gone.
    expect(await listSessions(sessionDirFor(repoPath, dataRoot))).toHaveLength(1)
    // And a new SSE subscriber replays the whole run, not just this process's share of it.
    expect(handle.recorder.eventsSoFar()).toEqual(afterSecond)
  })

  it('--fresh starts a new session, ignoring the abandoned session\'s offsets', async () => {
    const first = createOffsetCollector(['lane-a', 'lane-b'])
    handle = await boot([], BOOT_MS, first.collector)
    const sessionId = handle.recorder.sessionId
    await first.whenPolled(2)
    await handle.stop()

    const second = createOffsetCollector(['lane-a', 'lane-b'])
    handle = await boot(['--fresh'], BOOT_MS + 60_000, second.collector)

    expect(handle.recorder.sessionId).not.toBe(sessionId)
    expect(handle.recorder.sessionId).toBe(String(BOOT_MS + 60_000))
    await second.whenPolled(2)

    const sessions = await listSessions(sessionDirFor(repoPath, dataRoot))
    expect(sessions.map((session) => session.id)).toEqual([sessionId, String(BOOT_MS + 60_000)])

    const freshEvents = await readSessionEvents(handle.recorder.filePath)
    // Its own session.started, and both lines read again: a fresh session gets no snapshots.
    expect(countOfType(freshEvents, 'session.started')).toBe(1)
    expect(statusHandles(freshEvents)).toEqual(['lane-a', 'lane-b'])
  })

  it('resumes a session whose last event is exactly at the window boundary', async () => {
    handle = await boot([], BOOT_MS, createOffsetCollector(['lane-a']).collector)
    const sessionId = handle.recorder.sessionId
    await handle.stop()

    handle = await boot([], BOOT_MS + RESUME_WINDOW_MS, createOffsetCollector(['lane-a']).collector)

    expect(handle.recorder.sessionId).toBe(sessionId)
    expect(await listSessions(sessionDirFor(repoPath, dataRoot))).toHaveLength(1)
  })

  it('starts a new session one millisecond past the window — two boots a day apart are two runs', async () => {
    handle = await boot([], BOOT_MS, createOffsetCollector(['lane-a']).collector)
    const sessionId = handle.recorder.sessionId
    await handle.stop()

    handle = await boot([], BOOT_MS + RESUME_WINDOW_MS + 1, createOffsetCollector(['lane-a']).collector)

    expect(handle.recorder.sessionId).not.toBe(sessionId)
    const events = await readSessionEvents(handle.recorder.filePath)
    expect(countOfType(events, 'session.started')).toBe(1)
    expect(await listSessions(sessionDirFor(repoPath, dataRoot))).toHaveLength(2)
  })

  it('resumes across a crash that left a half-written final line, dropping only that line', async () => {
    const first = createOffsetCollector(['lane-a', 'lane-b'])
    handle = await boot([], BOOT_MS, first.collector)
    const filePath = handle.recorder.filePath
    const sessionId = handle.recorder.sessionId
    await first.whenPolled(2)
    await handle.stop()

    // Simulate the kill: a truncated line glued onto the end of the log.
    const { appendFile } = await import('node:fs/promises')
    await appendFile(filePath, '{"id":"evt-cut","ts":1,"type":"agent.sta', 'utf8')
    const beforeResume = await readSessionEvents(filePath)

    const second = createOffsetCollector(['lane-a', 'lane-b', 'lane-c'])
    handle = await boot([], BOOT_MS + 60_000, second.collector)
    expect(handle.recorder.sessionId).toBe(sessionId)
    await second.whenPolled(2)

    const afterResume = await readSessionEvents(filePath)
    expect(afterResume.slice(0, beforeResume.length)).toEqual(beforeResume)
    expect(statusHandles(afterResume)).toEqual(['lane-a', 'lane-b', 'lane-c'])
    const raw = await readFile(filePath, 'utf8')
    expect(raw).not.toContain('evt-cut')
    expect(raw.endsWith('\n')).toBe(true)
  })
})

describe('runCli port in use', () => {
  let dataRoot: string

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'observatory-cli-port-test-'))
  })

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true })
  })

  it('prints a clean message naming --port and exits 1 instead of an EADDRINUSE stack trace', async () => {
    const server = createServer()
    const busyPort = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })

    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()
    const repoPath = path.join(tmpdir(), 'observatory-port-busy-repo')

    try {
      const thrown = await runCli([repoPath, '--port', String(busyPort)], {
        dataRoot,
        collectors: [fakeCollector],
        log: { log: () => {}, warn: () => {} },
        exit,
      }).catch((err: unknown) => err)

      const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')

      expect(thrown).toBeInstanceOf(FakeExit)
      expect((thrown as FakeExit).code).toBe(1)
      expect(output).toContain(String(busyPort))
      expect(output).toContain('--port')
      expect(output).not.toMatch(/^\s*at /m)
      expect(output).not.toContain('.ts:')
    } finally {
      writeSpy.mockRestore()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
