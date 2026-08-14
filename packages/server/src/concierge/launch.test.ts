import { EventEmitter } from 'node:events'
import type { Exec } from '@rhizomorph/core'
import { describe, expect, it, vi } from 'vitest'
import type {
  ContinuityPlan,
  HarnessAdapter,
  HarnessDetection,
  HarnessEnvRecipe,
  HarnessLaunchContext,
} from './harness/types.js'
import {
  CONDUCTOR_WINDOW_NAME,
  HarnessNotAvailableError,
  LAUNCH_SETTLE_MS,
  LaunchContinuityUnavailableError,
  ConciergeLaunchValidationError,
  launchSpawnNodeOptions,
  parseConciergeLaunchRequestBody,
  planLaunch,
  runLaunch,
  type SpawnedLaunch,
} from './launch.js'

describe('parseConciergeLaunchRequestBody', () => {
  it('accepts a body carrying harness and mode', () => {
    expect(parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'launch' })).toEqual({ harness: 'claude', mode: 'launch' })
    expect(parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'continue' })).toEqual({
      harness: 'claude',
      mode: 'continue',
    })
  })

  it('refuses a non-object body', () => {
    expect(() => parseConciergeLaunchRequestBody(null)).toThrow(ConciergeLaunchValidationError)
    expect(() => parseConciergeLaunchRequestBody('claude')).toThrow(ConciergeLaunchValidationError)
  })

  it('refuses a missing or non-string harness', () => {
    expect(() => parseConciergeLaunchRequestBody({ mode: 'launch' })).toThrow(ConciergeLaunchValidationError)
    expect(() => parseConciergeLaunchRequestBody({ harness: 42, mode: 'launch' })).toThrow(ConciergeLaunchValidationError)
    expect(() => parseConciergeLaunchRequestBody({ harness: '', mode: 'launch' })).toThrow(ConciergeLaunchValidationError)
  })

  it('refuses a missing or invalid mode', () => {
    expect(() => parseConciergeLaunchRequestBody({ harness: 'claude' })).toThrow(ConciergeLaunchValidationError)
    expect(() => parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'nonsense' })).toThrow(
      ConciergeLaunchValidationError,
    )
  })

  it('accepts mode: resume carrying a safe sessionId', () => {
    expect(parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'resume', sessionId: 'abc-123' })).toEqual({
      harness: 'claude',
      mode: 'resume',
      sessionId: 'abc-123',
    })
  })

  it('refuses mode: resume with a missing sessionId', () => {
    expect(() => parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'resume' })).toThrow(
      ConciergeLaunchValidationError,
    )
    expect(() => parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'resume' })).toThrow(/sessionId/)
  })

  it('refuses mode: resume with an empty sessionId', () => {
    expect(() =>
      parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'resume', sessionId: '' }),
    ).toThrow(ConciergeLaunchValidationError)
  })

  it('refuses mode: resume with a non-string sessionId', () => {
    expect(() =>
      parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'resume', sessionId: 42 }),
    ).toThrow(ConciergeLaunchValidationError)
  })

  it.each(['/etc/passwd', '../escape', 'a/b', 'trailing\0null'])(
    'refuses a malformed sessionId %j before it ever reaches a path or an argv',
    (sessionId) => {
      expect(() =>
        parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'resume', sessionId }),
      ).toThrow(ConciergeLaunchValidationError)
    },
  )

  it.each(['launch', 'continue'] as const)(
    'refuses a sessionId supplied on mode: %s — resume is the only mode that takes one',
    (mode) => {
      expect(() =>
        parseConciergeLaunchRequestBody({ harness: 'claude', mode, sessionId: 'abc-123' }),
      ).toThrow(ConciergeLaunchValidationError)
      expect(() => parseConciergeLaunchRequestBody({ harness: 'claude', mode, sessionId: 'abc-123' })).toThrow(
        /sessionId/,
      )
    },
  )
})

/** A minimal, complete `HarnessAdapter` double — no real machine, no real registry. */
function fakeAdapter(overrides: Partial<HarnessAdapter> = {}): HarnessAdapter {
  return {
    id: 'claude',
    displayName: 'Fake Harness',
    implementation: { status: 'implemented' },
    detect: vi.fn(
      async (): Promise<HarnessDetection> => ({
        harness: 'claude',
        onPath: { state: 'present', evidence: 'found on PATH', executablePath: '/usr/local/bin/fake' },
        running: { state: 'unknown', reason: 'not checked' },
      }),
    ),
    envRecipe: vi.fn(
      (): HarnessEnvRecipe => ({
        env: { FAKE_VAR: '1' },
        configArgv: [],
        telemetry: { level: 'provided' },
        evidence: 'fixture',
      }),
    ),
    launchArgv: vi.fn((context: HarnessLaunchContext): readonly string[] => [context.executablePath ?? 'fake']),
    continueArgv: vi.fn(
      (): ContinuityPlan => ({
        kind: 'proven',
        argv: ['--continue'],
        whatContinues: 'the conversation',
        whatIsLost: 'nothing in this fixture',
        evidence: 'fixture',
      }),
    ),
    resumeArgv: vi.fn(
      (_context: HarnessLaunchContext, sessionId: string): ContinuityPlan => ({
        kind: 'proven',
        argv: ['--resume', sessionId],
        whatContinues: 'the named session',
        whatIsLost: 'nothing in this fixture',
        evidence: 'fixture',
      }),
    ),
    ...overrides,
  }
}

/**
 * A version probe that finds nothing, so no test in this file shells out to a
 * `/usr/local/bin/fake` that does not exist (ledger #7). `harnessVersion: null`
 * is what planning then carries — "we asked and could not tell" — and the tests
 * that care about a REAL version inject their own exec.
 */
const NO_VERSION = (async () => ({ stdout: '', stderr: 'not here', code: 127, failed: true })) as unknown as Exec

const CONTEXT = { watchedRepoPath: '/repo', port: 4321, instance: 'instance-1', exec: NO_VERSION }

describe('planLaunch', () => {
  it('refuses an unknown harness id', async () => {
    await expect(
      planLaunch('nonexistent', 'launch', { ...CONTEXT, harnessLookup: () => undefined }),
    ).rejects.toThrow(ConciergeLaunchValidationError)
  })

  it('defaults to the REAL registry (harnessById) when no harnessLookup is supplied — the fallback every other test bypasses', async () => {
    // No `harnessLookup` override: this is the only test in the suite that
    // exercises `context.harnessLookup ?? ((id) => harnessById(...))` for
    // real. An id no real adapter will ever carry keeps this deterministic
    // regardless of what's actually installed on the machine running it.
    await expect(planLaunch('definitely-not-a-real-harness', 'launch', CONTEXT)).rejects.toThrow(
      ConciergeLaunchValidationError,
    )
  })

  /**
   * The other half of ledger #6, and it lives here rather than in `detect.ts`:
   * detection can only refuse a `PATH` entry inside the watched repo if it is
   * TOLD which repo that is, and this is the one caller that goes on to spawn
   * what detection found. A fix that hardened `detectOnPath` and left this call
   * bare would have been correct code reached by nobody.
   */
  it('tells detection which repo is watched — the fence is useless to a detector that was not told', async () => {
    const adapter = fakeAdapter()

    await planLaunch('claude', 'launch', { ...CONTEXT, harnessLookup: () => adapter })

    expect(adapter.detect).toHaveBeenCalledWith({ watchedRepoPath: '/repo' })
  })

  /**
   * The other half of ledger #7, and the half a `claude.ts`-only fix would have
   * left dead: `resumeArgv` can only degrade off-pin if something actually
   * probed this machine, and planning is the phase already allowed to read it.
   */
  describe('the harness version reaches the continuity plan (ledger #7)', () => {
    const versionSaying = (stdout: string) =>
      vi.fn((async () => ({ stdout, stderr: '', code: 0, failed: false })) as unknown as Exec)

    it('probes the DETECTED executable with --version, not a bare name a spawner would re-resolve', async () => {
      const adapter = fakeAdapter()
      const exec = versionSaying('2.1.232 (Claude Code)\n')

      await planLaunch('claude', 'launch', { ...CONTEXT, harnessLookup: () => adapter, exec })

      expect(exec).toHaveBeenCalledWith('/usr/local/bin/fake', ['--version'], expect.anything())
    })

    it('hands the parsed version to the adapter, so a continuity plan can judge the machine', async () => {
      const adapter = fakeAdapter()
      const exec = versionSaying('2.1.232 (Claude Code)\n')

      await planLaunch('claude', 'resume', { ...CONTEXT, harnessLookup: () => adapter, exec }, 'sess-1')

      expect(adapter.resumeArgv).toHaveBeenCalledWith(
        expect.objectContaining({ harnessVersion: '2.1.232' }),
        'sess-1',
      )
    })

    it.each([
      ['a failed probe', vi.fn((async () => ({ stdout: '', stderr: 'boom', code: 1, failed: true })) as unknown as Exec)],
      ['output with no version in it', versionSaying('claude code, the good one\n')],
      ['a probe that throws', vi.fn((async () => { throw new Error('ENOENT') }) as unknown as Exec)],
    ])('answers null for %s — never a guess, and never a throw out of planning', async (_case, exec) => {
      const adapter = fakeAdapter()

      await planLaunch('claude', 'resume', { ...CONTEXT, harnessLookup: () => adapter, exec }, 'sess-1')

      expect(adapter.resumeArgv).toHaveBeenCalledWith(expect.objectContaining({ harnessVersion: null }), 'sess-1')
    })

    it('answers null when detection found no path to probe', async () => {
      const adapter = fakeAdapter({
        detect: vi.fn(
          async (): Promise<HarnessDetection> => ({
            harness: 'claude',
            onPath: { state: 'present', evidence: 'found, path unrecorded' },
            running: { state: 'unknown', reason: 'not checked' },
          }),
        ),
      })
      const exec = versionSaying('2.1.232\n')

      await planLaunch('claude', 'resume', { ...CONTEXT, harnessLookup: () => adapter, exec }, 'sess-1')

      expect(exec).not.toHaveBeenCalled()
      expect(adapter.resumeArgv).toHaveBeenCalledWith(expect.objectContaining({ harnessVersion: null }), 'sess-1')
    })
  })

  it('refuses a declared-not-implemented harness, naming its reason — never calls detect', async () => {
    const detect = vi.fn()
    const adapter = fakeAdapter({
      implementation: { status: 'declared', reason: 'no verified recipe', whatItWouldTake: 'a capture' },
      detect,
    })

    await expect(planLaunch('claude', 'launch', { ...CONTEXT, harnessLookup: () => adapter })).rejects.toThrow(
      /not implemented: no verified recipe/,
    )
    expect(detect).not.toHaveBeenCalled()
  })

  it('refuses a harness detect() reports absent, quoting its evidence', async () => {
    const adapter = fakeAdapter({
      detect: vi.fn(async () => ({
        harness: 'claude' as const,
        onPath: { state: 'absent' as const, evidence: 'no `fake` on PATH' },
        running: { state: 'unknown' as const, reason: 'not checked' },
      })),
    })

    const err = await planLaunch('claude', 'launch', { ...CONTEXT, harnessLookup: () => adapter }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(HarnessNotAvailableError)
    expect((err as Error).message).toContain('no `fake` on PATH')
  })

  it('refuses installed-not-launchable, naming the reason and the remedy', async () => {
    const adapter = fakeAdapter({
      detect: vi.fn(async () => ({
        harness: 'claude' as const,
        onPath: {
          state: 'installed-not-launchable' as const,
          evidence: 'found a .cmd shim',
          foundAt: 'C:\\fake.cmd',
          reason: 'a .cmd shim needs a shell to run, and this hand never reaches one',
          remedy: 'install the native binary instead',
        },
        running: { state: 'unknown' as const, reason: 'not checked' },
      })),
    })

    const err = await planLaunch('claude', 'launch', { ...CONTEXT, harnessLookup: () => adapter }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(HarnessNotAvailableError)
    expect((err as Error).message).toContain('a .cmd shim needs a shell to run')
    expect((err as Error).message).toContain('install the native binary instead')
  })

  it('refuses detect() unknown, naming the reason', async () => {
    const adapter = fakeAdapter({
      detect: vi.fn(async () => ({
        harness: 'claude' as const,
        onPath: { state: 'unknown' as const, reason: 'no /proc on this platform' },
        running: { state: 'unknown' as const, reason: 'no /proc on this platform' },
      })),
    })

    await expect(
      planLaunch('claude', 'launch', { ...CONTEXT, harnessLookup: () => adapter }),
    ).rejects.toThrow(/no \/proc on this platform/)
  })

  it('builds the HarnessLaunchContext with a hardcoded conductor lane/role, never caller-supplied', async () => {
    const adapter = fakeAdapter()
    await planLaunch('claude', 'launch', { ...CONTEXT, harnessLookup: () => adapter })

    expect(adapter.envRecipe).toHaveBeenCalledWith({
      lane: 'conductor',
      role: 'conductor',
      port: 4321,
      instance: 'instance-1',
      executablePath: '/usr/local/bin/fake',
      harnessVersion: null,
    })
  })

  it('a fresh launch returns launchArgv verbatim, plus the recipe env/cwd/telemetry, and no continuity', async () => {
    const adapter = fakeAdapter()
    const plan = await planLaunch('claude', 'launch', { ...CONTEXT, harnessLookup: () => adapter })

    expect(plan).toEqual({
      argv: ['/usr/local/bin/fake'],
      env: { FAKE_VAR: '1' },
      cwd: '/repo',
      telemetry: { level: 'provided' },
    })
  })

  it('does not call continueArgv for a fresh launch', async () => {
    const adapter = fakeAdapter()
    await planLaunch('claude', 'launch', { ...CONTEXT, harnessLookup: () => adapter })
    expect(adapter.continueArgv).not.toHaveBeenCalled()
  })

  it('refuses mode: continue when the adapter has no continuity story', async () => {
    const adapter = fakeAdapter({
      continueArgv: vi.fn((): ContinuityPlan => ({ kind: 'none', reason: 'this harness has no resume flag' })),
    })

    const err = await planLaunch('claude', 'continue', { ...CONTEXT, harnessLookup: () => adapter }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(LaunchContinuityUnavailableError)
    expect((err as Error).message).toContain('this harness has no resume flag')
  })

  it('mode: continue takes ONLY argv[0] from launchArgv, then appends continueArgv verbatim — never doubles the fresh-launch config', async () => {
    // The regression this pins: codex's own launchArgv already bakes its `-c`
    // config in, and its continueArgv independently carries its OWN copy of
    // that config after `resume --last`. Concatenating the FULL fresh array
    // with continueArgv's argv would run the config twice and put `resume` in
    // the wrong position. A multi-element `launchArgv` proves the seam reads
    // only element 0 forward, the same as codex's own adapter would need.
    const adapter = fakeAdapter({
      launchArgv: vi.fn(() => ['/usr/local/bin/fake', '-c', 'fresh.only=1']),
      continueArgv: vi.fn(
        (): ContinuityPlan => ({
          kind: 'proven',
          argv: ['resume', '--last', '-c', 'continuity.only=1'],
          whatContinues: 'x',
          whatIsLost: 'y',
          evidence: 'z',
        }),
      ),
    })

    const plan = await planLaunch('claude', 'continue', { ...CONTEXT, harnessLookup: () => adapter })

    expect(plan.argv).toEqual(['/usr/local/bin/fake', 'resume', '--last', '-c', 'continuity.only=1'])
    expect(plan.argv).not.toContain('fresh.only=1')
  })

  it('mode: continue carries the ContinuityPlan through on the returned plan', async () => {
    const adapter = fakeAdapter()
    const plan = await planLaunch('claude', 'continue', { ...CONTEXT, harnessLookup: () => adapter })

    expect(plan.continuity).toEqual({
      kind: 'proven',
      argv: ['--continue'],
      whatContinues: 'the conversation',
      whatIsLost: 'nothing in this fixture',
      evidence: 'fixture',
    })
  })

  it('still launches an unproven continuity plan — unproven is a label to surface, not a refusal', async () => {
    const adapter = fakeAdapter({
      continueArgv: vi.fn(
        (): ContinuityPlan => ({
          kind: 'unproven',
          argv: ['resume', '--last'],
          reason: 'nobody has captured this yet',
          toProve: 'capture one session',
        }),
      ),
    })

    const plan = await planLaunch('claude', 'continue', { ...CONTEXT, harnessLookup: () => adapter })
    expect(plan.argv).toEqual(['/usr/local/bin/fake', 'resume', '--last'])
    expect(plan.continuity).toMatchObject({ kind: 'unproven' })
  })

  it('refuses mode: resume with no sessionId, before detect() is ever called', async () => {
    const detect = vi.fn()
    const adapter = fakeAdapter({ detect })

    await expect(planLaunch('claude', 'resume', { ...CONTEXT, harnessLookup: () => adapter })).rejects.toThrow(
      ConciergeLaunchValidationError,
    )
    expect(detect).not.toHaveBeenCalled()
  })

  it('refuses mode: resume with an empty-string sessionId', async () => {
    const adapter = fakeAdapter()

    await expect(
      planLaunch('claude', 'resume', { ...CONTEXT, harnessLookup: () => adapter }, ''),
    ).rejects.toThrow(ConciergeLaunchValidationError)
  })

  it('mode: resume calls adapter.resumeArgv with the launch context and the sessionId, never continueArgv', async () => {
    const adapter = fakeAdapter()
    const plan = await planLaunch('claude', 'resume', { ...CONTEXT, harnessLookup: () => adapter }, 'session-xyz')

    expect(adapter.resumeArgv).toHaveBeenCalledWith(
      {
        lane: 'conductor',
        role: 'conductor',
        port: 4321,
        instance: 'instance-1',
        executablePath: '/usr/local/bin/fake',
        harnessVersion: null,
      },
      'session-xyz',
    )
    expect(adapter.continueArgv).not.toHaveBeenCalled()
    expect(plan.argv).toEqual(['/usr/local/bin/fake', '--resume', 'session-xyz'])
    expect(plan.continuity).toMatchObject({ kind: 'proven', argv: ['--resume', 'session-xyz'] })
  })

  it('mode: resume takes ONLY argv[0] from launchArgv, then appends resumeArgv verbatim — the same composition rule as continue', async () => {
    const adapter = fakeAdapter({
      launchArgv: vi.fn(() => ['/usr/local/bin/fake', '-c', 'fresh.only=1']),
      resumeArgv: vi.fn(
        (): ContinuityPlan => ({
          kind: 'proven',
          argv: ['--resume', 'session-xyz', '-c', 'resume.only=1'],
          whatContinues: 'x',
          whatIsLost: 'y',
          evidence: 'z',
        }),
      ),
    })

    const plan = await planLaunch('claude', 'resume', { ...CONTEXT, harnessLookup: () => adapter }, 'session-xyz')

    expect(plan.argv).toEqual(['/usr/local/bin/fake', '--resume', 'session-xyz', '-c', 'resume.only=1'])
    expect(plan.argv).not.toContain('fresh.only=1')
  })

  it('refuses mode: resume when the adapter has no resume-by-id story (kind: none)', async () => {
    const adapter = fakeAdapter({
      resumeArgv: vi.fn((): ContinuityPlan => ({ kind: 'none', reason: 'no captured resume-by-id form' })),
    })

    const err = await planLaunch(
      'claude',
      'resume',
      { ...CONTEXT, harnessLookup: () => adapter },
      'session-xyz',
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LaunchContinuityUnavailableError)
    expect((err as Error).message).toContain('no captured resume-by-id form')
  })
})

/**
 * A fake spawned child good enough for `runLaunch` — `once('spawn'|'error'|
 * 'exit', ...)`, `unref()`, a `pid`.
 *
 * `emitExit` is #532's whole subject: a real interactive `claude` spawned
 * detached with no TTY emits `spawn` and then, milliseconds later, `exit`.
 * Before this issue there was no way to say that in a test, which is precisely
 * why the defect shipped — every test here injected a child that spawned and
 * then, being an object, sat there being alive forever.
 */
type FakeLaunch = SpawnedLaunch & {
  emitSpawn: () => void
  emitError: (err: Error) => void
  emitExit: (code: number | null, signal?: NodeJS.Signals | null) => void
}

function fakeLaunch(pid = 4242): FakeLaunch {
  const emitter = new EventEmitter()
  const child: FakeLaunch = {
    pid,
    unref: vi.fn(),
    once: (event: 'spawn' | 'error' | 'exit', listener: never) => {
      emitter.once(event, listener)
      return child
    },
    emitSpawn: () => emitter.emit('spawn'),
    emitError: (err: Error) => emitter.emit('error', err),
    emitExit: (code, signal = null) => emitter.emit('exit', code, signal),
  }
  return child
}

/**
 * An `Exec` that fails the way a machine with no tmux does — the default for
 * every detached-path test below, and the reason each of them is really
 * exercising the fallback rather than whatever tmux the suite's own machine
 * happens to be running. Without this the tests would pass or fail depending
 * on whether the developer had tmux open.
 */
const noTmux: Exec = () =>
  Promise.resolve({ stdout: '', stderr: '', code: null, failed: true, errorMessage: 'spawn tmux ENOENT' })

/** A settle window that closes immediately — for the cases where the child's own event is what settles the answer. */
const immediately = () => Promise.resolve()

/**
 * Lets `runLaunch`'s own awaits — the tmux probes, which every test here
 * answers from an injected `Exec` — drain before the test emits the fake
 * child's events. A `setImmediate` runs after the whole microtask queue, so
 * one is enough however many probes ran, and emitting before this would fire
 * the events at a listener that does not exist yet.
 */
const untilSpawned = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A promise plus its resolver, so a test can hold the settle window open and close it on its own schedule. */
function deferred(): { promise: Promise<void>; close: () => void } {
  let close = (): void => {}
  const promise = new Promise<void>((resolve) => {
    close = resolve
  })
  return { promise, close }
}

describe('runLaunch — the detached path (no tmux reachable)', () => {
  const plan = { argv: ['fake', '--continue'], env: { FAKE_VAR: '1' }, cwd: '/repo', telemetry: { level: 'provided' as const } }

  it('resolves { kind: launched, via: detached, pid } and unrefs the child once the settle window closes', async () => {
    const child = fakeLaunch(4242)
    const spawnLaunch = vi.fn(() => child)

    const outcomePromise = runLaunch(plan, { spawnLaunch, exec: noTmux, wait: immediately })
    await untilSpawned()
    child.emitSpawn()
    const outcome = await outcomePromise

    expect(outcome).toEqual({ kind: 'launched', via: 'detached', pid: 4242 })
    expect(child.unref).toHaveBeenCalledTimes(1)
    expect(spawnLaunch).toHaveBeenCalledWith('fake', ['--continue'], { cwd: '/repo', env: { FAKE_VAR: '1' } })
  })

  /**
   * THE DEFECT (#532), as a test that could not have passed before it.
   *
   * The child spawns and then exits at once — a real `claude --resume` with no
   * TTY and no prompt, captured live during the wave-8 proof. The settle
   * window is held open across the exit, so the only way to answer `launched`
   * here is to have never looked.
   */
  it('a child that exits inside the settle window is DIED, never launched', async () => {
    const child = fakeLaunch(4242)
    const window = deferred()

    const outcomePromise = runLaunch(plan, { spawnLaunch: () => child, exec: noTmux, wait: () => window.promise })
    await untilSpawned()
    child.emitSpawn()
    child.emitExit(1)
    const outcome = await outcomePromise
    window.close()

    expect(outcome.kind).toBe('died')
    expect(outcome).toMatchObject({ kind: 'died', via: 'detached' })
    const message = (outcome as { message: string }).message
    expect(message).toContain('exited with code 1')
    // The three things the operator needs from a corpse: that it died, why it
    // most likely died, and what to run instead.
    expect(message).toMatch(/no terminal|TTY/)
    expect(message).toContain('fake --continue')
  })

  it('reports the signal when the child was killed rather than exiting', async () => {
    const child = fakeLaunch(4242)
    const window = deferred()

    const outcomePromise = runLaunch(plan, { spawnLaunch: () => child, exec: noTmux, wait: () => window.promise })
    await untilSpawned()
    child.emitSpawn()
    child.emitExit(null, 'SIGTERM')
    const outcome = await outcomePromise
    window.close()

    expect(outcome).toMatchObject({ kind: 'died' })
    expect((outcome as { message: string }).message).toContain('SIGTERM')
  })

  /**
   * The mutation this pins: turning the bounded window into "await the child's
   * exit" would make the test above pass and hang every healthy launch
   * forever. A child that outlives the window is `launched`, and the window is
   * what decides — not the exit.
   */
  it('a child that exits AFTER the settle window has closed is still launched — the window is bounded, not a wait-for-exit', async () => {
    const child = fakeLaunch(4242)

    const outcomePromise = runLaunch(plan, { spawnLaunch: () => child, exec: noTmux, wait: immediately })
    await untilSpawned()
    child.emitSpawn()
    const outcome = await outcomePromise
    child.emitExit(0)

    expect(outcome).toEqual({ kind: 'launched', via: 'detached', pid: 4242 })
  })

  it('waits LAUNCH_SETTLE_MS by default — the honesty window is the module’s own value, not the caller’s', async () => {
    const child = fakeLaunch()
    const wait = vi.fn(immediately)

    const outcomePromise = runLaunch(plan, { spawnLaunch: () => child, exec: noTmux, wait })
    await untilSpawned()
    child.emitSpawn()
    await outcomePromise

    expect(wait).toHaveBeenCalledWith(LAUNCH_SETTLE_MS)
    expect(LAUNCH_SETTLE_MS).toBeGreaterThan(0)
  })

  it('never starts the settle window at all when the spawn itself failed — { kind: error }, and never throws', async () => {
    const child = fakeLaunch()
    const wait = vi.fn(immediately)

    const outcomePromise = runLaunch(plan, { spawnLaunch: () => child, exec: noTmux, wait })
    await untilSpawned()
    child.emitError(new Error('ENOENT'))
    const outcome = await outcomePromise

    expect(outcome).toEqual({ kind: 'error', message: 'could not start fake: ENOENT' })
    expect(child.unref).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
  })
})

/**
 * The tmux half of #532: when a tmux server is reachable the conductor gets a
 * REAL TTY, which is the only condition under which an interactive harness
 * survives at all. Every case injects `Exec`, so none of this needs tmux — or
 * cares whether the machine running the suite has one.
 */
describe('runLaunch — the tmux path', () => {
  const plan = {
    argv: ['/usr/local/bin/claude', '--resume', 'sess-1'],
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4321', OTEL_RESOURCE_ATTRIBUTES: 'lane=conductor,role=conductor,instance=1000' },
    cwd: '/repo',
    telemetry: { level: 'provided' as const },
  }

  const ok = (stdout = '') => ({ stdout, stderr: '', code: 0, failed: false })
  const fails = () => ({ stdout: '', stderr: 'no server running', code: 1, failed: true })

  type TmuxVerb = 'has-session' | 'list-sessions' | 'new-window' | 'list-panes'

  /**
   * A tmux that answers every call: a live server, one session, a window it
   * reports back, and — since ledger #3 — a `list-panes` that says the pane is
   * still there (`#{pane_dead}` of `0`) when the settle window closes.
   */
  function tmuxAnswering(overrides: Partial<Record<TmuxVerb, ReturnType<typeof ok>>> = {}) {
    return vi.fn(((_command: string, args: readonly string[]) => {
      const verb = args[0] as TmuxVerb
      const override = overrides[verb]
      if (override !== undefined) return Promise.resolve(override)
      if (verb === 'has-session') return Promise.resolve(ok())
      if (verb === 'list-sessions') return Promise.resolve(ok('main\nother\n'))
      if (verb === 'list-panes') return Promise.resolve(ok('0\n'))
      return Promise.resolve(ok('9911 main:3\n'))
    }) as Exec)
  }

  it('launches into a real window, says WHERE, and never spawns anything detached', async () => {
    const exec = tmuxAnswering()
    const spawnLaunch = vi.fn(() => fakeLaunch())

    const outcome = await runLaunch(plan, { spawnLaunch, exec, wait: immediately })

    expect(outcome).toEqual({ kind: 'launched', via: 'tmux', pid: 9911, window: 'main:3' })
    // The whole point: no second conductor, ever.
    expect(spawnLaunch).not.toHaveBeenCalled()
  })

  it('threads the env envelope as tmux’s own -e flags — argv, never text inside the window command', async () => {
    const exec = tmuxAnswering()

    await runLaunch(plan, { exec, wait: immediately })

    const args = exec.mock.calls[2]?.[1] as string[]
    expect(args[0]).toBe('new-window')
    expect(args).toContain('-d')
    expect(args).toContain('-e')
    expect(args).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4321')
    expect(args).toContain('OTEL_RESOURCE_ATTRIBUTES=lane=conductor,role=conductor,instance=1000')
    // The session it targets is the one `list-sessions` named, not tmux's
    // implicit "current" one, and the window carries a findable name.
    expect(args[args.indexOf('-t') + 1]).toBe('main')
    expect(args[args.indexOf('-n') + 1]).toBe(CONDUCTOR_WINDOW_NAME)
    expect(args[args.indexOf('-c') + 1]).toBe('/repo')
    // Not one env value in the command string — the only thing a shell ever sees.
    const command = args[args.length - 1] as string
    expect(command).not.toContain('OTEL_')
    expect(command).toBe(`'/usr/local/bin/claude' '--resume' 'sess-1'`)
  })

  it('single-quotes every token of the window command, and closes the quote on a value carrying one', async () => {
    const exec = tmuxAnswering()
    const awkward = { ...plan, argv: ['/opt/my tools/claude', "--resume", "o'brien"] }

    await runLaunch(awkward, { exec, wait: immediately })

    const args = exec.mock.calls[2]?.[1] as string[]
    expect(args[args.length - 1]).toBe(`'/opt/my tools/claude' '--resume' 'o'\\''brien'`)
  })

  it('refuses to build a window command from a token carrying a control character, and falls back rather than quoting and hoping', async () => {
    const exec = tmuxAnswering()
    const child = fakeLaunch()
    const spawnLaunch = vi.fn(() => child)
    const smuggled = { ...plan, argv: ['/usr/local/bin/claude', '--resume', 'sess\n; rm -rf /'] }

    const outcomePromise = runLaunch(smuggled, { spawnLaunch, exec, wait: immediately })
    await untilSpawned()
    child.emitSpawn()

    expect(await outcomePromise).toMatchObject({ kind: 'launched', via: 'detached' })
    // `new-window` was never reached: has-session and list-sessions only.
    expect(exec.mock.calls.map((call) => (call[1] as string[])[0])).toEqual(['has-session', 'list-sessions'])
    expect(spawnLaunch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['no tmux server is reachable', { 'has-session': fails() }],
    ['tmux is there but has no session to hang a window on', { 'list-sessions': ok('  \n') }],
    ['list-sessions itself fails', { 'list-sessions': fails() }],
    ['new-window fails — an old tmux with no -e, most likely', { 'new-window': fails() }],
  ])('falls back to the detached path when %s', async (_case, overrides) => {
    const exec = tmuxAnswering(overrides as Parameters<typeof tmuxAnswering>[0])
    const child = fakeLaunch(777)
    const spawnLaunch = vi.fn(() => child)

    const outcomePromise = runLaunch(plan, { spawnLaunch, exec, wait: immediately })
    await untilSpawned()
    child.emitSpawn()

    expect(await outcomePromise).toEqual({ kind: 'launched', via: 'detached', pid: 777 })
    expect(spawnLaunch).toHaveBeenCalledTimes(1)
  })

  /**
   * The sibling case the fall-back rule has to stop at. Every `null` above
   * means "nothing was started"; once `new-window` has SUCCEEDED that is no
   * longer true, so an answer this cannot parse must not become a second
   * conductor in a detached process.
   */
  it('never spawns a second conductor when new-window succeeded but reported something unreadable', async () => {
    const exec = tmuxAnswering({ 'new-window': ok('what?\n') })
    const spawnLaunch = vi.fn(() => fakeLaunch())

    const outcome = await runLaunch(plan, { spawnLaunch, exec, wait: immediately })

    expect(outcome).toMatchObject({ kind: 'error' })
    expect((outcome as { message: string }).message).toContain(CONDUCTOR_WINDOW_NAME)
    expect(spawnLaunch).not.toHaveBeenCalled()
  })

  /**
   * **THE SAME SETTLE WINDOW, ON THE STRONGER CLAIM** (ledger #3). `new-window`
   * reports the moment the window is created; it never says anything survived.
   * The detached path stopped trusting `spawn`'s success in #532 and this path
   * went on trusting `new-window`'s — the identical shape, one layer up, over
   * the answer that promises the operator MORE (a window to attach to and type
   * in, not merely a pid).
   *
   * A pane has a TTY, so #532's own death cannot recur here; what these cover
   * is every other insta-death — a wrapper rejecting its arguments, a harness
   * exiting on a bad config — which closes the pane in milliseconds and used to
   * read as a live conductor.
   */
  it('rechecks the pane after the settle window, on the same clock the detached path uses', async () => {
    const exec = tmuxAnswering()
    const wait = vi.fn(immediately)

    const outcome = await runLaunch(plan, { exec, wait })

    expect(outcome).toEqual({ kind: 'launched', via: 'tmux', pid: 9911, window: 'main:3' })
    // The window is the module's own, not a caller's, and it really elapsed
    // before the recheck: `list-panes` is the LAST call, after the wait.
    expect(wait).toHaveBeenCalledWith(LAUNCH_SETTLE_MS)
    const verbs = exec.mock.calls.map((call) => (call[1] as string[])[0])
    expect(verbs).toEqual(['has-session', 'list-sessions', 'new-window', 'list-panes'])
    // …and it asks about the window it is about to name, not about some other one.
    const panes = exec.mock.calls[3]?.[1] as string[]
    expect(panes[panes.indexOf('-t') + 1]).toBe('main:3')
  })

  it('reports a vanished pane as died, via tmux, rather than a window to attach to', async () => {
    const exec = tmuxAnswering({ 'list-panes': fails() })
    const spawnLaunch = vi.fn(() => fakeLaunch())

    const outcome = await runLaunch(plan, { spawnLaunch, exec, wait: immediately })

    expect(outcome).toMatchObject({ kind: 'died', via: 'tmux', window: 'main:3' })
    const message = (outcome as { message: string }).message
    expect(message).toContain('main:3')
    // The stderr tmux actually gave, and the command the operator can run.
    expect(message).toContain('no server running')
    expect(message).toContain('/usr/local/bin/claude --resume sess-1')
    // Not #532's death, and it must not be described as one — a pane HAS a TTY.
    expect(message).toContain('not the no-TTY death')
    // A died is not a licence to start a second conductor.
    expect(spawnLaunch).not.toHaveBeenCalled()
  })

  /**
   * The sibling of the vanished window, and the one a "does the window exist"
   * check would call alive: `remain-on-exit on` keeps the dead pane on screen,
   * so `list-panes` succeeds and lists a window whose command has exited.
   * `#{pane_dead}` is tmux's own name for that state, which is why the format
   * string asks for it rather than for a pid.
   */
  it('reports a listed-but-dead pane as died — remain-on-exit keeps the corpse visible', async () => {
    const exec = tmuxAnswering({ 'list-panes': ok('1\n') })

    const outcome = await runLaunch(plan, { exec, wait: immediately })

    expect(outcome).toMatchObject({ kind: 'died', via: 'tmux' })
    expect((outcome as { message: string }).message).toContain('remain-on-exit')
  })

  it('a window listing no pane at all is died too, never a launch over an empty answer', async () => {
    const exec = tmuxAnswering({ 'list-panes': ok('  \n') })

    expect(await runLaunch(plan, { exec, wait: immediately })).toMatchObject({ kind: 'died', via: 'tmux' })
  })

  /** One live pane beside a dead one is a live window — the operator has somewhere to type. */
  it('a window with one live pane among dead ones is still a launch', async () => {
    const exec = tmuxAnswering({ 'list-panes': ok('1\n0\n') })

    expect(await runLaunch(plan, { exec, wait: immediately })).toEqual({
      kind: 'launched',
      via: 'tmux',
      pid: 9911,
      window: 'main:3',
    })
  })

  it('probes tmux in argv form only — no command string ever reaches this module’s own exec', async () => {
    const exec = tmuxAnswering()

    await runLaunch(plan, { exec, wait: immediately })

    for (const [command, args] of exec.mock.calls) {
      expect(command).toBe('tmux')
      expect(Array.isArray(args)).toBe(true)
    }
  })
})

describe('launchSpawnNodeOptions — the SCAR, pinned on the real spawn seam', () => {
  // Every other test injects `spawnLaunch`, so the options the REAL spawn is
  // handed were the one line no test reached: swapping the env merge order
  // left the whole file green. #264's Direction names exactly this failure
  // mode — "an env prefix that doesn't reach the exec'd process fails
  // invisibly" — so the merge itself is asserted here, on the exported
  // builder `realSpawnLaunch` actually uses.
  it('the recipe wins over the inherited environment, and the inherited environment still arrives', () => {
    process.env.RHIZO_TEST_INHERITED = 'from-parent'
    process.env.RHIZO_TEST_CLOBBERED = 'parent-value'
    try {
      const options = launchSpawnNodeOptions({
        cwd: '/repo',
        env: { RHIZO_TEST_CLOBBERED: 'recipe-value', OTEL_TEST_MARKER: 'set' },
      })
      expect(options.env.RHIZO_TEST_INHERITED).toBe('from-parent') // PATH and friends survive
      expect(options.env.RHIZO_TEST_CLOBBERED).toBe('recipe-value') // the recipe owns its keys
      expect(options.env.OTEL_TEST_MARKER).toBe('set')
      expect(options.cwd).toBe('/repo')
    } finally {
      delete process.env.RHIZO_TEST_INHERITED
      delete process.env.RHIZO_TEST_CLOBBERED
    }
  })

  it('the conductor outlives the request: detached, stdio ignored', () => {
    const options = launchSpawnNodeOptions({ cwd: '/repo', env: {} })
    expect(options.detached).toBe(true)
    expect(options.stdio).toBe('ignore')
  })
})
