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
 * Re-run that to re-verify. This test pins the list so a codex that renames a
 * key fails here rather than emitting config nobody reads.
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
  it('emits only keys verified against codex-cli 0.145.0', () => {
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
})
