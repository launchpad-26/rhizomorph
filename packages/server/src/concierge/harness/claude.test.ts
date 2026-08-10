import { describe, expect, it } from 'vitest'
import { otlpEndpoint, renderTelemetryEnv } from '../../cli/telemetry-env.js'
import { claudeAdapter, claudeEnvRecipe } from './claude.js'
import type { HarnessLaunchContext } from './types.js'

const CONTEXT: HarnessLaunchContext = {
  lane: 'lane-a',
  role: 'conductor',
  port: 7317,
  instance: 'instance-abc123',
}

describe('the claude env recipe is the CLI\'s block, not a copy of it', () => {
  /**
   * The anti-drift law. `cli/telemetry-env.ts` owns this block and is owned by
   * the CLI; this lane reuses it and must not fork it. Asserting the parse
   * round-trips *every* variable the renderer emits means a variable added to
   * the CLI's block arrives here automatically — and a fork of the key list
   * would fail here instead of drifting quietly.
   */
  it('round-trips every variable the CLI renders, with no key invented or dropped', () => {
    const rendered = renderTelemetryEnv({ ...CONTEXT, shell: 'sh' })
    const renderedKeys = rendered
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => line.replace(/^export /, '').split('=')[0])
      .sort()

    const recipeKeys = Object.keys(claudeEnvRecipe(CONTEXT).env).sort()

    expect(recipeKeys).toEqual(renderedKeys)
    expect(recipeKeys.length).toBeGreaterThan(5)
  })

  it('keeps a value that itself contains `=` intact — the one that names the lane', () => {
    // OTEL_RESOURCE_ATTRIBUTES is `lane=…,role=…,instance=…`. A split on every
    // `=` rather than the first would truncate it to `lane`, and the receiver
    // would book this telemetry against no lane at all.
    const { env } = claudeEnvRecipe(CONTEXT)

    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('lane=lane-a,role=conductor,instance=instance-abc123')
  })

  it('points at the same receiver the CLI does', () => {
    expect(claudeEnvRecipe(CONTEXT).env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(otlpEndpoint(CONTEXT.port))
  })

  it('carries the instance id, without which the receiver refuses the export', () => {
    expect(claudeEnvRecipe(CONTEXT).env.OTEL_RESOURCE_ATTRIBUTES).toContain(CONTEXT.instance)
  })

  it('declares telemetry provided — the one harness where that is earned', () => {
    expect(claudeEnvRecipe(CONTEXT).telemetry).toEqual({ level: 'provided' })
  })

  it('needs no argv config: claude is configured entirely through the environment', () => {
    expect(claudeEnvRecipe(CONTEXT).configArgv).toEqual([])
  })
})

describe('the claude adapter\'s four members', () => {
  it('is implemented, and says so', () => {
    expect(claudeAdapter.implementation).toEqual({ status: 'implemented' })
  })

  it('launches as an argv array, never a command string', () => {
    const argv = claudeAdapter.launchArgv(CONTEXT)

    expect(argv).toEqual(['claude'])
    // ADR-0014 clause 4: an argv array is what removes the injection path.
    expect(Array.isArray(argv)).toBe(true)
  })

  it('continues with --continue, and is the only PROVEN continuity in this registry', () => {
    const plan = claudeAdapter.continueArgv(CONTEXT)

    expect(plan.kind).toBe('proven')
    expect(plan).toMatchObject({ argv: ['--continue'] })
  })

  it('names what continuity costs, because prd-20 ruling 3 requires the honest half', () => {
    const plan = claudeAdapter.continueArgv(CONTEXT)
    if (plan.kind !== 'proven') throw new Error('expected a proven plan')

    expect(plan.whatContinues.length).toBeGreaterThan(0)
    // The physics: instrumentation attaches at launch and is never back-filled.
    expect(plan.whatIsLost).toMatch(/attaches at launch|back-filled/)
  })
})
