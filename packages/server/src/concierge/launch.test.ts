import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type {
  ContinuityPlan,
  HarnessAdapter,
  HarnessDetection,
  HarnessEnvRecipe,
  HarnessLaunchContext,
} from './harness/types.js'
import {
  HarnessNotAvailableError,
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
    expect(() => parseConciergeLaunchRequestBody({ harness: 'claude', mode: 'resume' })).toThrow(ConciergeLaunchValidationError)
  })
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
    ...overrides,
  }
}

const CONTEXT = { watchedRepoPath: '/repo', port: 4321, instance: 'instance-1' }

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
})

/** A fake spawned child good enough for `runLaunch` — `once('spawn'|'error', ...)`, `unref()`, a `pid`. */
type FakeLaunch = SpawnedLaunch & { emitSpawn: () => void; emitError: (err: Error) => void }

function fakeLaunch(pid = 4242): FakeLaunch {
  const emitter = new EventEmitter()
  const child: FakeLaunch = {
    pid,
    unref: vi.fn(),
    once: (event: 'spawn' | 'error', listener: never) => {
      emitter.once(event, listener)
      return child
    },
    emitSpawn: () => emitter.emit('spawn'),
    emitError: (err: Error) => emitter.emit('error', err),
  }
  return child
}

describe('runLaunch', () => {
  const plan = { argv: ['fake', '--continue'], env: { FAKE_VAR: '1' }, cwd: '/repo', telemetry: { level: 'provided' as const } }

  it('resolves { kind: launched, pid } and unrefs the child once spawn fires', async () => {
    const child = fakeLaunch(4242)
    const spawnLaunch = vi.fn(() => child)

    const outcomePromise = runLaunch(plan, { spawnLaunch })
    child.emitSpawn()
    const outcome = await outcomePromise

    expect(outcome).toEqual({ kind: 'launched', pid: 4242 })
    expect(child.unref).toHaveBeenCalledTimes(1)
    expect(spawnLaunch).toHaveBeenCalledWith('fake', ['--continue'], { cwd: '/repo', env: { FAKE_VAR: '1' } })
  })

  it('resolves { kind: error } when the spawn itself fails — never throws', async () => {
    const child = fakeLaunch()
    const spawnLaunch = vi.fn(() => child)

    const outcomePromise = runLaunch(plan, { spawnLaunch })
    child.emitError(new Error('ENOENT'))
    const outcome = await outcomePromise

    expect(outcome).toEqual({ kind: 'error', message: 'could not start fake: ENOENT' })
    expect(child.unref).not.toHaveBeenCalled()
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
