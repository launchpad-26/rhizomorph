import { describe, expect, it } from 'vitest'
import { otlpEndpoint } from '../../cli/telemetry-env.js'
import { codexAdapter, codexEnvRecipe } from './codex.js'
import type { HarnessLaunchContext } from './types.js'

const CONTEXT: HarnessLaunchContext = {
  lane: 'lane-a',
  role: 'worker',
  port: 7317,
  instance: 'instance-abc123',
}

/** The `-c key=value` pairs, as a map, so a test can talk about keys rather than argv positions. */
function overridesOf(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '-c') continue
    const pair = argv[index + 1] ?? ''
    const separator = pair.indexOf('=')
    if (separator > 0) out[pair.slice(0, separator)] = pair.slice(separator + 1)
  }
  return out
}

/**
 * The key list below is not copied from documentation. Every key was accepted by
 * codex's own validator on **codex-cli 0.145.0** — the version
 * `docs/research/2026-08-05-agnosticism-spike.md` cites — while an invented key
 * was refused:
 *
 * ```
 * $ codex exec --strict-config -c 'otel.zzz_bogus=1' …
 * Error loading config.toml: unknown configuration field `otel.zzz_bogus` in -c/--config override
 * ```
 *
 * Re-run that to re-verify — **by hand**. What the test below can and cannot do
 * is worth being exact about, because the obvious reading of it is wrong: it
 * compares `codexEnvRecipe`'s output against this list, and both live in this
 * repo. An upstream codex that renamed a key would change neither side, so the
 * test would stay green while the config went unread. It is not an upstream
 * canary and nothing here can be: `codexAdapter.detect` accepts every version,
 * so no code in this repo notices a codex upgrade at all.
 *
 * What it DOES pin: our recipe cannot drift from this list without someone
 * editing both places in one commit. A key quietly added to, dropped from or
 * respelled in `codex.ts` fails here — so the list stays the written record of
 * what was actually verified against the binary, and changing it stays a
 * deliberate act with this comment in front of it.
 */
const VERIFIED_KEYS = [
  'otel.environment',
  'otel.exporter.otlp-http.endpoint',
  'otel.exporter.otlp-http.protocol',
  'otel.log_user_prompt',
  'otel.span_attributes.instance',
  'otel.span_attributes.lane',
  'otel.span_attributes.role',
]

describe('codex is configured by argv, so this hand writes nothing', () => {
  it('emits exactly the keys recorded as verified — our recipe cannot drift from the list unnoticed', () => {
    expect(Object.keys(overridesOf(codexEnvRecipe(CONTEXT).configArgv)).sort()).toEqual(VERIFIED_KEYS)
  })

  it('needs no environment block at all', () => {
    expect(codexEnvRecipe(CONTEXT).env).toEqual({})
  })

  it('passes each override as two argv entries, never one shell word', () => {
    const argv = codexEnvRecipe(CONTEXT).configArgv
    // `-c`, `key=value`, `-c`, `key=value`… — ADR-0014 clause 4 means these are
    // never assembled into a command line, so no quoting can escape them.
    expect(argv.filter((entry) => entry === '-c')).toHaveLength(VERIFIED_KEYS.length)
    expect(argv).toHaveLength(VERIFIED_KEYS.length * 2)
  })

  it('points at the same receiver claude does, through the CLI\'s own helper', () => {
    const overrides = overridesOf(codexEnvRecipe(CONTEXT).configArgv)

    expect(overrides['otel.exporter.otlp-http.endpoint']).toBe(`"${otlpEndpoint(CONTEXT.port)}"`)
  })

  it('declares identity in codex\'s own vocabulary', () => {
    const overrides = overridesOf(codexEnvRecipe(CONTEXT).configArgv)

    expect(overrides['otel.span_attributes.lane']).toBe('"lane-a"')
    expect(overrides['otel.span_attributes.role']).toBe('"worker"')
    expect(overrides['otel.span_attributes.instance']).toBe('"instance-abc123"')
  })

  it('leaves prompt logging off', () => {
    expect(overridesOf(codexEnvRecipe(CONTEXT).configArgv)['otel.log_user_prompt']).toBe('false')
  })

  it('escapes values as TOML, because codex parses the value as TOML', () => {
    const overrides = overridesOf(
      codexEnvRecipe({ ...CONTEXT, lane: 'lane "quoted" \\ and\nnewline' }).configArgv,
    )

    // A raw quote would end the TOML string early and change which key gets what.
    expect(overrides['otel.span_attributes.lane']).toBe('"lane \\"quoted\\" \\\\ and\\nnewline"')
  })
})

describe('codex telemetry is declared ABSENT, and the reason is the point', () => {
  it('does not claim provided just because the config parses', () => {
    const { telemetry } = codexEnvRecipe(CONTEXT)

    // Correct configuration is not arriving telemetry. Declaring `provided`
    // here would be ADR-0010's "confident number sourced from nothing", and an
    // operator could not tell a real zero from an unreceived export.
    expect(telemetry.level).toBe('absent')
  })

  it('names the bare-path mismatch that makes it absent, and the remedy', () => {
    const { telemetry } = codexEnvRecipe(CONTEXT)
    if (telemetry.level === 'provided') throw new Error('expected a reason-carrying level')

    expect(telemetry.reason).toMatch(/bare/i)
    expect(telemetry.reason).toContain('/v1/')
    expect(telemetry.remedy).toBeTruthy()
  })

  it('names the SECOND blocker too, so nobody infers that a bare-path route would be enough', () => {
    // api/otel.ts's blockInstance reads the instance id from resource.attributes
    // only, and this recipe declares identity in otel.span_attributes. So adding
    // the bare-path route would turn the 404 into "declared no instance" — a
    // refusal, not an arrival. A reason that named only the 404 would send the
    // next lane to do half a fix and find telemetry still missing.
    const { telemetry } = codexEnvRecipe(CONTEXT)
    if (telemetry.level === 'provided') throw new Error('expected a reason-carrying level')

    expect(telemetry.reason).toMatch(/blockInstance/)
    expect(telemetry.reason).toMatch(/resource\.attributes/)
    expect(telemetry.reason).toMatch(/span_attributes/)
    // The verdict is unchanged — it was right; only the remedy was incomplete.
    expect(telemetry.level).toBe('absent')
    expect(telemetry.remedy).toMatch(/blockInstance|resource-attribute/)
  })

  it('separates what was verified from what was only cited', () => {
    // The keys were checked against the binary; the non-arrival is the repo's
    // capture, not something this lane re-captured. The evidence string has to
    // keep those apart or it is the same second-hand claim it replaced.
    expect(codexEnvRecipe(CONTEXT).evidence).toMatch(/strict-config/)
    expect(codexEnvRecipe(CONTEXT).evidence).toMatch(/not re-captured|repo capture/)
  })
})

describe('codex continuity is UNPROVEN, and says so', () => {
  it('does not dress `resume --last` up as proven', () => {
    const plan = codexAdapter.continueArgv(CONTEXT)

    expect(plan.kind).toBe('unproven')
  })

  it('still carries the argv, behind the word unproven', () => {
    const plan = codexAdapter.continueArgv(CONTEXT)
    if (plan.kind !== 'unproven') throw new Error('expected an unproven plan')

    expect(plan.argv.slice(0, 2)).toEqual(['resume', '--last'])
    expect(plan.reason.length).toBeGreaterThan(0)
    expect(plan.toProve.length).toBeGreaterThan(0)
  })

  it('relaunches carrying the same telemetry config as a fresh launch', () => {
    const plan = codexAdapter.continueArgv(CONTEXT)
    if (plan.kind !== 'unproven') throw new Error('expected an unproven plan')

    // A relaunch that dropped the config would be an uninstrumented relaunch —
    // the exact failure prd-20 exists to remove.
    for (const key of VERIFIED_KEYS) {
      expect(plan.argv.some((entry) => entry.startsWith(`${key}=`))).toBe(true)
    }
  })

  it('launches as an argv array carrying its config', () => {
    const argv = codexAdapter.launchArgv(CONTEXT)

    expect(argv[0]).toBe('codex')
    expect(argv).toHaveLength(1 + VERIFIED_KEYS.length * 2)
  })

  it('launches the executable detection verified, when the caller has one', () => {
    // Same seam fix as claude's: a bare `codex` would be re-resolved by the
    // spawner against its own PATH, discarding the filtering `detectOnPath`
    // applied (no empty or relative entries, so nothing from the watched repo's
    // working tree).
    const executablePath = '/opt/homebrew/bin/codex'
    const argv = codexAdapter.launchArgv({ ...CONTEXT, executablePath })

    expect(argv[0]).toBe(executablePath)
    // And the telemetry config still rides along behind it.
    expect(argv).toHaveLength(1 + VERIFIED_KEYS.length * 2)
  })

  it('launches the executable DETECTION verified, not the bare name, when one was detected', () => {
    // Same reason as claude's: a bare `codex` is re-resolved against the
    // spawner's PATH at spawn time, with none of detectOnPath's filtering.
    const argv = codexAdapter.launchArgv({ ...CONTEXT, executablePath: '/opt/homebrew/bin/codex' })

    expect(argv[0]).toBe('/opt/homebrew/bin/codex')
    expect(argv).toHaveLength(1 + VERIFIED_KEYS.length * 2)
  })
})
