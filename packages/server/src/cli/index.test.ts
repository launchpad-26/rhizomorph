import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Collector, CollectorContext, Exec, RhizomorphEvent, PollResult } from '@rhizomorph/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { worktreePathToProjectSlug } from '../collectors/sessionlog/index.js'
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
  predicate: (event: RhizomorphEvent) => boolean,
  timeoutMs = 5000,
): Promise<RhizomorphEvent> {
  const existing = recorder.eventsSoFar().find(predicate)
  if (existing) return existing

  return await new Promise<RhizomorphEvent>((resolve, reject) => {
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
function statusHandles(events: readonly RhizomorphEvent[]): string[] {
  return events
    .filter((event): event is Extract<RhizomorphEvent, { type: 'agent.status' }> => event.type === 'agent.status')
    .map((event) => event.payload.handle)
}

function countOfType(events: readonly RhizomorphEvent[], type: RhizomorphEvent['type']): number {
  return events.filter((event) => event.type === type).length
}

describe('runCli', () => {
  let dataRoot: string
  let handle: CliHandle | undefined

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-cli-test-'))
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

    // runCli's own boot already awaited the first tick before returning `handle`
    // (see index.ts); these two force two more, guaranteeing the loop keeps
    // advancing after boot rather than proving anything about the first tick.
    await handle.pollLoop.tick()
    await handle.pollLoop.tick()

    const eventsResponse = await fetch(`${handle.url}/api/sessions/${handle.recorder.sessionId}/events`)
    const { events } = (await eventsResponse.json()) as { events: Array<{ type: string }> }
    expect(events[0]?.type).toBe('session.started')
    expect(events.slice(1).every((e) => e.type === 'agent.status')).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(2)
  })

  it('boot line names the watched repo with real worktree/branch counts from the first poll, and the session log path', async () => {
    const repoPath = path.join(tmpdir(), 'boot-line-repo')

    // Stands in for the git collector: discovers two worktrees and two
    // branches on its very first poll, so the boot line has real, non-zero
    // counts to report instead of the zeroes a fresh SessionState would give.
    const discoveryCollector: Collector<{ discovered: boolean }> = {
      name: 'fake-git',
      initialSnapshot: () => ({ discovered: false }),
      poll: (prev, context: CollectorContext): PollResult<{ discovered: boolean }> => {
        if (prev.discovered) return { nextSnapshot: prev, events: [] }
        return {
          nextSnapshot: { discovered: true },
          events: [
            context.emit('worktree.discovered', {
              path: repoPath,
              branch: 'main',
              head: 'sha-main',
              isMain: true,
            }),
            context.emit('worktree.discovered', {
              path: path.join(tmpdir(), 'boot-line-repo-lane-a'),
              branch: 'lane-a',
              head: 'sha-lane-a',
              isMain: false,
            }),
            context.emit('branch.updated', { branch: 'main', head: 'sha-main' }),
            context.emit('branch.updated', { branch: 'lane-a', head: 'sha-lane-a' }),
          ],
        }
      },
    }

    const log = { log: vi.fn(), warn: vi.fn() }
    handle = await runCli([repoPath, '--port', '0'], {
      dataRoot,
      collectors: [discoveryCollector],
      log,
    })

    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain(
      `watching ${repoPath} — 2 worktrees, 2 branches · recording to ${handle.recorder.filePath}`,
    )
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
    const claudeProjectsRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-claude-projects-'))
    const extraDir = path.join(tmpdir(), 'rhizomorph-conductor-workdir')
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

/**
 * Since #60 the env block declares the instance it belongs to, read from the
 * server on `--port` — so these boot one on an ephemeral port instead of
 * assuming the default is free (or, worse, borrowing whichever Rhizomorph
 * happens to be running on this machine). See `telemetry-env.test.ts` for the
 * renderer's own tests.
 */
describe('runCli env subcommand', () => {
  let dataRoot: string
  let server: CliHandle | undefined

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-env-cli-test-'))
  })

  afterEach(async () => {
    await server?.stop()
    server = undefined
    await rm(dataRoot, { recursive: true, force: true })
  })

  async function bootServer(): Promise<{ port: number; instance: string }> {
    server = await runCli([path.join(tmpdir(), 'env-repo'), '--port', '0'], {
      dataRoot,
      collectors: [],
      log: silentLog,
    })
    return { port: Number(new URL(server.url).port), instance: server.recorder.sessionId }
  }

  it('prints the telemetry env block for a lane and exits 0', async () => {
    const { port, instance } = await bootServer()
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['env', 'test-lane', '--port', String(port)], { log, exit }).catch(
      (err: unknown) => err,
    )

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain('export CLAUDE_CODE_ENABLE_TELEMETRY=1')
    expect(output).toContain(`export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${port}`)
    expect(output).toContain(
      `export OTEL_RESOURCE_ATTRIBUTES=lane=test-lane,role=worker,instance=${instance}`,
    )
  })

  it('honours --role and --port', async () => {
    const { port, instance } = await bootServer()
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(
      ['env', 'conductor', '--role', 'conductor', '--port', String(port)],
      { log, exit },
    ).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain(`export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${port}`)
    expect(output).toContain(
      `export OTEL_RESOURCE_ATTRIBUTES=lane=conductor,role=conductor,instance=${instance}`,
    )
  })

  it('honours --shell, rendering the PowerShell form end to end', async () => {
    const { port, instance } = await bootServer()
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(
      ['env', 'test-lane', '--port', String(port), '--shell', 'powershell'],
      { log, exit },
    ).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain('$env:CLAUDE_CODE_ENABLE_TELEMETRY = "1"')
    expect(output).toContain(`$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:${port}"`)
    expect(output).toContain(
      `$env:OTEL_RESOURCE_ATTRIBUTES = "lane=test-lane,role=worker,instance=${instance}"`,
    )
  })

  it('prints a clean message + usage to stderr and exits 1 when no Rhizomorph answers on the port', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    // Port 1 needs root to bind, so nothing of ours is ever listening there.
    const thrown = await runCli(['env', 'my-lane', '--port', '1'], { exit }).catch(
      (err: unknown) => err,
    )

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain("cannot read this Rhizomorph's instance id on port 1")
    expect(output).toContain('npm start -- --port 1')
    expect(output).not.toMatch(/^\s*at /m)
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
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('rhizomorph env <lane>'))
    expect(writeSpy).not.toHaveBeenCalled()
  })
})

describe('runCli argument errors', () => {
  it('prints a clean message + usage to stderr and exits 1 on an unknown flag — no stack trace', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    const thrown = await runCli(['--bogus'], { exit }).catch((err: unknown) => err)

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('unknown option: "--bogus"')
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

/**
 * Reads the version straight off the root package.json instead of hardcoding
 * a string, so this test fails the moment the CLI's `--version` output and
 * the published package's own version can drift apart — the pairing the
 * release brief calls out as the thing a test must pin.
 */
describe('runCli --version', () => {
  it("prints the root package.json's version and exits 0", async () => {
    const rootPackageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'package.json',
    )
    const rootPkg = JSON.parse(await readFile(rootPackageJsonPath, 'utf8')) as { version: string }

    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['--version'], { log, exit }).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    expect(log.log).toHaveBeenCalledWith(rootPkg.version)
  })

  it('honours an overridden rootPackageJsonPath, same as doctor does for engines.node', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-version-cli-test-'))
    const pkgPath = path.join(dir, 'package.json')
    await writeFile(pkgPath, JSON.stringify({ version: '9.9.9' }))

    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    try {
      const thrown = await runCli(['--version'], { log, exit, rootPackageJsonPath: pkgPath }).catch(
        (err: unknown) => err,
      )

      expect(thrown).toBeInstanceOf(FakeExit)
      expect((thrown as FakeExit).code).toBe(0)
      expect(log.log).toHaveBeenCalledWith('9.9.9')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runCli doctor subcommand', () => {
  it('runs a read-only preflight (no server boot) and exits 0 when healthy', async () => {
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()
    const repoPath = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-cli-'))
    const webDistDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-cli-web-'))
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
    const notGitDir = await mkdtemp(path.join(tmpdir(), 'rhizomorph-doctor-cli-notgit-'))

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
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('rhizomorph doctor [path]'))
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

describe('runCli export-record and replay subcommands', () => {
  let dataRoot: string
  let repoPath: string
  let replayServer: CliHandle | undefined

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-record-cli-test-'))
    repoPath = path.join(tmpdir(), 'record-cli-repo')
  })

  afterEach(async () => {
    await replayServer?.stop()
    replayServer = undefined
    await rm(dataRoot, { recursive: true, force: true })
  })

  /** Boots a live session, lets the fake collector emit one tick's worth of events, then shuts down — leaving a real session-*.jsonl on disk for export-record to read. */
  async function recordASession(): Promise<void> {
    const server = await runCli([repoPath, '--port', '0'], {
      dataRoot,
      collectors: [fakeCollector],
      log: silentLog,
    })
    await server.pollLoop.tick()
    await server.stop()
  }

  it('export-record --help prints usage and exits 0', async () => {
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['export-record', '--help'], { log, exit }).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('rhizomorph export-record [path]'))
  })

  it('replay --help prints usage and exits 0', async () => {
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['replay', '--help'], { log, exit }).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('rhizomorph replay <record-file>'))
  })

  it('exits 1 naming the repo when there is nothing recorded to export', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()
    const thrown = await runCli(['export-record', repoPath], { dataRoot, log: silentLog, exit }).catch(
      (err: unknown) => err,
    )
    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('no recorded sessions')
  })

  it('exports a recorded session, then replay verifies its chain and serves the same fold read-only', async () => {
    await recordASession()
    const outFile = path.join(dataRoot, 'out.rhizorecord.json')

    const exportLog = { log: vi.fn(), warn: vi.fn() }
    const exportThrown = await runCli(
      ['export-record', repoPath, '--out', outFile, '--handle', 'alice'],
      { dataRoot, log: exportLog, exit: fakeExit() },
    ).catch((err: unknown) => err)
    expect(exportThrown).toBeInstanceOf(FakeExit)
    expect((exportThrown as FakeExit).code).toBe(0)
    const exportOutput = exportLog.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(exportOutput).toContain(outFile)
    expect(exportOutput).toContain('alice')

    const written = JSON.parse(await readFile(outFile, 'utf8')) as {
      manifest: { eventCount: number; actor: { handle: string; declared: boolean } }
    }
    expect(written.manifest.actor).toEqual({ handle: 'alice', declared: true, instance: expect.any(String) })

    replayServer = await runCli(['replay', outFile, '--port', '0'], { log: silentLog, exit: fakeExit() })
    expect(replayServer.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const sessionsResponse = await fetch(`${replayServer.url}/api/sessions`)
    const { sessions } = (await sessionsResponse.json()) as { sessions: Array<{ id: string }> }
    expect(sessions).toHaveLength(1)

    const eventsResponse = await fetch(`${replayServer.url}/api/sessions/${sessions[0]!.id}/events`)
    const { events } = (await eventsResponse.json()) as { events: Array<{ type: string }> }
    expect(events).toHaveLength(written.manifest.eventCount)
    expect(events[0]?.type).toBe('session.started')
    expect(events.some((e) => e.type === 'agent.status')).toBe(true)
  })

  it('refuses to replay a tampered record, loudly, instead of serving it', async () => {
    await recordASession()
    const outFile = path.join(dataRoot, 'out.rhizorecord.json')
    await runCli(['export-record', repoPath, '--out', outFile], {
      dataRoot,
      log: silentLog,
      exit: fakeExit(),
    }).catch(() => {})

    const raw = JSON.parse(await readFile(outFile, 'utf8')) as { body: Array<{ line: string }> }
    const tamperIndex = raw.body.findIndex((link) => link.line.includes('"working"'))
    expect(tamperIndex).toBeGreaterThanOrEqual(0)
    raw.body[tamperIndex]!.line = raw.body[tamperIndex]!.line.replace('"working"', '"tampered"')
    await writeFile(outFile, JSON.stringify(raw), 'utf8')

    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()
    const thrown = await runCli(['replay', outFile, '--port', '0'], { log: silentLog, exit }).catch(
      (err: unknown) => err,
    )
    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('verification failed')
    expect(output).toContain('chain-broken')
  })
})

describe('runCli resuming the run', () => {
  /** A fixed boot clock: session ids, event stamps and the resume window all read from it. */
  const BOOT_MS = 1_700_000_000_000
  const repoPath = path.join(tmpdir(), 'rhizomorph-resume-repo')
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
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-resume-test-'))
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
    dataRoot = await mkdtemp(path.join(tmpdir(), 'rhizomorph-cli-port-test-'))
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
    const repoPath = path.join(tmpdir(), 'rhizomorph-port-busy-repo')

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

describe('runCli lab checkpoint subcommand', () => {
  let root: string
  let repoDir: string
  let dataRoot: string
  let claudeProjectsRoot: string

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-cli-test-'))
    repoDir = path.join(root, 'repo')
    dataRoot = path.join(root, 'data')
    claudeProjectsRoot = path.join(root, 'claude-projects')

    await mkdir(repoDir, { recursive: true })
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-m', 'initial commit'])
    // Dirty on entry — the real thing this command exists to snapshot.
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v2\n')
    await writeFile(path.join(repoDir, 'untracked.txt'), 'new\n')

    const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
    await mkdir(projectDir, { recursive: true })
    await writeFile(path.join(projectDir, 'session-fixture.jsonl'), '{"line":1}\n')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('captures a checkpoint end-to-end on a real worktree, leaves it untouched, and logs a summary', async () => {
    const statusBefore = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' })
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['lab', 'checkpoint', '148-lab-checkpoint', '--path', repoDir], {
      log,
      exit,
      dataRoot,
      claudeProjectsRoot,
    }).catch((err: unknown) => err)

    expect(thrown).toBeInstanceOf(FakeExit)
    expect((thrown as FakeExit).code).toBe(0)

    const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' })
    expect(statusAfter).toBe(statusBefore)

    const output = log.log.mock.calls.map((call) => String(call[0])).join('\n')
    expect(output).toContain('captured for lane "148-lab-checkpoint"')
    expect(output).toContain('refs/rhizomorph/checkpoints/')

    const sessionDir = sessionDirFor(repoDir, dataRoot)
    const sessions = await listSessions(sessionDir)
    expect(sessions).toHaveLength(1)
    const session = sessions[0]
    if (!session) throw new Error('expected one recorded session')

    const events = await readSessionEvents(path.join(sessionDir, session.fileName))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'fork.checkpoint',
      source: 'lab',
      payload: { lane: '148-lab-checkpoint', capturedBy: 'operator' },
    })
  })

  it('accepts --captured-by and threads it through to the emitted event', async () => {
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(
      ['lab', 'checkpoint', '148-lab-checkpoint', '--path', repoDir, '--captured-by', 'gate'],
      { log, exit, dataRoot, claudeProjectsRoot },
    ).catch((err: unknown) => err)
    expect((thrown as FakeExit).code).toBe(0)

    const sessionDir = sessionDirFor(repoDir, dataRoot)
    const sessions = await listSessions(sessionDir)
    const session = sessions[0]
    if (!session) throw new Error('expected one recorded session')
    const events = await readSessionEvents(path.join(sessionDir, session.fileName))
    expect(events[0]).toMatchObject({ payload: { capturedBy: 'gate' } })
  })

  it('prints lab checkpoint --help to stdout and exits 0, without touching stderr', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['lab', 'checkpoint', '--help'], { log, exit }).catch((err: unknown) => err)

    writeSpy.mockRestore()
    expect((thrown as FakeExit).code).toBe(0)
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('rhizomorph lab checkpoint <lane>'))
    expect(writeSpy).not.toHaveBeenCalled()
  })

  it('prints the bare "rhizomorph lab" usage table and exits 0', async () => {
    const log = { log: vi.fn(), warn: vi.fn() }
    const exit = fakeExit()

    const thrown = await runCli(['lab'], { log, exit }).catch((err: unknown) => err)

    expect((thrown as FakeExit).code).toBe(0)
    expect(log.log).toHaveBeenCalledWith(expect.stringContaining('rhizomorph lab <subcommand>'))
  })

  it('exits 1 on an unknown lab subcommand, naming it', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    const thrown = await runCli(['lab', 'nope'], { exit }).catch((err: unknown) => err)

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('unknown lab subcommand: "nope"')
  })

  it('exits 1 and prints usage when the lane is missing', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    const thrown = await runCli(['lab', 'checkpoint'], { exit }).catch((err: unknown) => err)

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toContain('missing required argument: <lane>')
  })

  it('exits 1 with a clean message (no stack trace) when the lane has no session file', async () => {
    await rm(path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir)), {
      recursive: true,
      force: true,
    })
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exit = fakeExit()

    const thrown = await runCli(['lab', 'checkpoint', '148-lab-checkpoint', '--path', repoDir], {
      exit,
      dataRoot,
      claudeProjectsRoot,
    }).catch((err: unknown) => err)

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()
    expect((thrown as FakeExit).code).toBe(1)
    expect(output).toMatch(/session/)
    expect(output).not.toMatch(/^\s*at /m)
    expect(output).not.toContain('.ts:')
  })
})

describe('runCli lab fork + compare subcommands (prd12 phase 2)', () => {
  let root: string
  let repoDir: string
  let dataRoot: string
  let claudeProjectsRoot: string

  function git(args: string[], cwd = repoDir): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  /** Runs a `rhizomorph lab …` invocation and returns its exit code plus stdout. */
  async function lab(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const log = { log: vi.fn(), warn: vi.fn() }
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const thrown = await runCli(argv, {
      log,
      exit: fakeExit(),
      dataRoot,
      claudeProjectsRoot,
    }).catch((err: unknown) => err)
    const err = writeSpy.mock.calls.map((call) => String(call[0])).join('')
    writeSpy.mockRestore()
    if (!(thrown instanceof FakeExit)) throw thrown
    return { code: thrown.code, out: log.log.mock.calls.map((call) => String(call[0])).join('\n'), err }
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rhizomorph-lab-fork-cli-test-'))
    repoDir = path.join(root, 'repo')
    dataRoot = path.join(root, 'data')
    claudeProjectsRoot = path.join(root, 'claude-projects')

    await mkdir(repoDir, { recursive: true })
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v1\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial commit'])
    await writeFile(path.join(repoDir, 'tracked.txt'), 'v2 in flight\n')

    const projectDir = path.join(claudeProjectsRoot, worktreePathToProjectSlug(repoDir))
    await mkdir(projectDir, { recursive: true })
    await writeFile(path.join(projectDir, 'aaaaaaaa-0000-4000-8000-000000000000.jsonl'), '{"cwd":"x"}\n')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** The forkId the CLI printed, so a later `compare` can name it. */
  function forkIdFrom(out: string): string {
    const match = /^fork (\S+) —/m.exec(out)
    if (!match?.[1]) throw new Error(`no fork id in output:\n${out}`)
    return match[1]
  }

  it('forks a lane end-to-end and reports each arm, without launching anything', async () => {
    expect((await lab(['lab', 'checkpoint', 'demo-lane', '--path', repoDir])).code).toBe(0)

    const before = git(['status', '--porcelain'])
    const fork = await lab(['lab', 'fork', 'demo-lane', '--path', repoDir, '--arms', '3', '--model', 'opus'])

    expect(fork.code).toBe(0)
    expect(fork.out).toMatch(/3 arm\(s\) of lane "demo-lane"/)
    expect(fork.out).toContain('arm 1')
    expect(fork.out).toContain('arm 3')
    expect(fork.out).toContain('paths rewritten to this tree')
    expect(fork.out).toContain('not run — run it yourself: workmux add')
    expect(fork.out).toContain('rhizomorph lab compare')
    // The watched repo is untouched.
    expect(git(['status', '--porcelain'])).toBe(before)
  })

  it('compares the fork it just made: a table, a distribution, and no winner', async () => {
    await lab(['lab', 'checkpoint', 'demo-lane', '--path', repoDir])
    const forkId = forkIdFrom((await lab(['lab', 'fork', 'demo-lane', '--path', repoDir, '--arms', '3'])).out)

    const compare = await lab(['lab', 'compare', forkId, '--path', repoDir, '--no-verify'])

    expect(compare.code).toBe(0)
    expect(compare.out).toContain('arm  lane')
    expect(compare.out).toContain('distribution over 3 arms')
    expect(compare.out).toContain('no winner is named')
  })

  it('refuses to rank a two-arm fork, printing the runs instead', async () => {
    await lab(['lab', 'checkpoint', 'demo-lane', '--path', repoDir])
    const forkId = forkIdFrom((await lab(['lab', 'fork', 'demo-lane', '--path', repoDir, '--arms', '2'])).out)

    const compare = await lab(['lab', 'compare', forkId, '--path', repoDir, '--no-verify'])

    expect(compare.code).toBe(0)
    expect(compare.out).toContain('runs only')
    expect(compare.out).toContain('Ranking needs n >= 3')
    expect(compare.out).not.toContain('distribution over')
  })

  it('exits 1 with a clean message when the lane has no checkpoint to fork from', async () => {
    const fork = await lab(['lab', 'fork', 'never-checkpointed', '--path', repoDir])

    expect(fork.code).toBe(1)
    expect(fork.err).toContain('no fork.checkpoint recorded for lane "never-checkpointed"')
    expect(fork.err).not.toMatch(/^\s*at /m)
  })

  it('exits 1 with usage when the lane or fork id is missing', async () => {
    const fork = await lab(['lab', 'fork'])
    expect(fork.code).toBe(1)
    expect(fork.err).toContain('missing required argument: <lane>')
    expect(fork.err).toContain('rhizomorph lab fork <lane>')

    const compare = await lab(['lab', 'compare'])
    expect(compare.code).toBe(1)
    expect(compare.err).toContain('missing required argument: <fork-id>')
  })

  it('exits 1 with a clean message on an unknown fork id', async () => {
    const compare = await lab(['lab', 'compare', 'no-such-fork', '--path', repoDir, '--no-verify'])
    expect(compare.code).toBe(1)
    expect(compare.err).toContain('no fork "no-such-fork" recorded')
    expect(compare.err).not.toMatch(/^\s*at /m)
  })

  it('prints each subcommand\'s own help and exits 0', async () => {
    const fork = await lab(['lab', 'fork', '--help'])
    expect(fork.code).toBe(0)
    expect(fork.out).toContain('rhizomorph lab fork <lane>')

    const compare = await lab(['lab', 'compare', '--help'])
    expect(compare.code).toBe(0)
    expect(compare.out).toContain('rhizomorph lab compare <fork-id>')
  })
})
