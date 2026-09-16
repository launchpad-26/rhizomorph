import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { otlpEndpoint, renderTelemetryEnv } from '../../cli/telemetry-env.js'
import { CLAUDE_HOOK_EVENTS, claudeAdapter, claudeEnvRecipe } from './claude.js'
import { codexAdapter } from './codex.js'
import { HarnessNotImplementedError } from './types.js'
import type { EnlistmentPlan, HarnessEnlistContext, HarnessLaunchContext } from './types.js'

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

// ── enlistment (prd-57 ruling 4, ADR-0053) ───────────────────────────────────

/**
 * Ruling 4's law, in the form the ruling asks for: *"against a fixture with
 * unrelated content, that enlist changes exactly the declared keys and unenlist
 * restores the file byte-for-byte except those."*
 *
 * Every test below runs against a STRING. No home directory, no settings file,
 * no machine with claude installed — because `planEnlistment` is a pure
 * function of the file's current text, which is the property that makes this
 * law checkable by someone who has never enlisted anything.
 */
describe('enlistment plans the exact keys and nothing else', () => {
  const ENLIST_CONTEXT: HarnessEnlistContext = { ...CONTEXT, runnerPath: '/opt/rhizomorph/bin/rhizomorph' }
  const TARGET = claudeAdapter.enlistmentTarget('/home/operator')
  const enlist = (current: string | null) =>
    claudeAdapter.planEnlistment(current, TARGET, { kind: 'enlist', context: ENLIST_CONTEXT })
  const unenlist = (current: string | null) => claudeAdapter.planEnlistment(current, TARGET, { kind: 'unenlist' })

  /** A real settings file whose content has nothing to do with us. */
  const UNRELATED =
    JSON.stringify(
      {
        theme: 'dark',
        permissions: { allow: ['Bash(git status)'] },
        env: { EDITOR: 'vim' },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/my-audit' }] }] },
      },
      null,
      2,
    ) + '\n'

  function readyOrThrow(plan: EnlistmentPlan) {
    if (plan.kind !== 'ready') throw new Error(`expected a ready plan, got ${plan.kind}`)
    return plan
  }

  it('targets the USER-level file, never anything inside a repo', () => {
    // ADR-0019 clause 4 is "never inside the watched repo". A repo-local
    // `.claude/settings.local.json` would put this hand's writes into somebody's
    // working tree, where the instrument would then report them as dirty files.
    expect(TARGET.path).toBe(path.join('/home/operator', '.claude', 'settings.json'))
    expect(TARGET.display).toBe('~/.claude/settings.json')
  })

  it('changes exactly the declared keys — everything unrelated is untouched', () => {
    const plan = readyOrThrow(enlist(UNRELATED))
    const before = JSON.parse(UNRELATED)
    const after = JSON.parse(plan.next)

    expect(after.theme).toEqual(before.theme)
    expect(after.permissions).toEqual(before.permissions)
    // The operator's own EDITOR survives beside ours.
    expect(after.env.EDITOR).toBe('vim')
    // And every key this plan reports touching is one of the two it declares.
    for (const change of plan.changes) expect(['env', 'hooks']).toContain(change.keyPath[0])
  })

  it('merges into hooks, never clobbers them — the operator keeps their own audit hook', () => {
    const after = JSON.parse(readyOrThrow(enlist(UNRELATED)).next)
    const preToolUse = after.hooks.PreToolUse as unknown[]

    expect(preToolUse).toHaveLength(2)
    expect(JSON.stringify(preToolUse[0])).toContain('/usr/local/bin/my-audit')
    expect(JSON.stringify(preToolUse[1])).toContain('/opt/rhizomorph/bin/rhizomorph hook')
  })

  it('subscribes to the five events ruling 5 derives its vocabulary from, and no others', () => {
    // Not a spelling check. A hook this hand installs fires on the operator's
    // machine for every session they run, so subscribing to an event no word is
    // derived from would be collection for its own sake.
    const after = JSON.parse(readyOrThrow(enlist(null)).next)
    expect(Object.keys(after.hooks).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort())
  })

  it('invokes the ABSOLUTE runner path, never npx — ruling 6, and the reason is a timeout', () => {
    const rendered = readyOrThrow(enlist(null)).next
    expect(rendered).toContain('/opt/rhizomorph/bin/rhizomorph hook')
    expect(rendered).not.toContain('npx')
  })

  it('a missing settings file is an ordinary first run, not an error', () => {
    const after = JSON.parse(readyOrThrow(enlist(null)).next)
    expect(Object.keys(after.env).length).toBeGreaterThan(0)
    expect(Object.keys(after.hooks)).toHaveLength(CLAUDE_HOOK_EVENTS.length)
  })

  it('is idempotent — enlisting an enlisted file is already-settled, not a second entry', () => {
    const once = readyOrThrow(enlist(UNRELATED)).next
    expect(enlist(once).kind).toBe('already-settled')
    // And specifically not by appending a duplicate, which is what matching our
    // entry by position rather than by the command it invokes would have done.
    expect(JSON.parse(once).hooks.PreToolUse).toHaveLength(2)
  })

  it('unenlist restores the document — deep equality, which holds for ANY input', () => {
    const enlisted = readyOrThrow(enlist(UNRELATED)).next
    const restored = readyOrThrow(unenlist(enlisted)).next
    expect(JSON.parse(restored)).toEqual(JSON.parse(UNRELATED))
  })

  it('unenlist restores it BYTE-FOR-BYTE when the document was canonically formatted', () => {
    // The stronger half, with a stated limit: this round-trips through
    // `JSON.parse`, so indent width, key order and the trailing newline survive
    // while aligned values and blank lines cannot. `UNRELATED` is
    // `JSON.stringify(_, null, 2)` output, which is the canonical form.
    const enlisted = readyOrThrow(enlist(UNRELATED)).next
    expect(readyOrThrow(unenlist(enlisted)).next).toBe(UNRELATED)
  })

  it('unenlist leaves no empty container behind — a fingerprint is not a restoration', () => {
    // This file had no `env` and no `hooks` at all. After enlist and unenlist it
    // must not carry `"env": {}`, which is the difference between putting
    // something back and leaving a mark where it used to be.
    const bare = JSON.stringify({ theme: 'dark' }, null, 2) + '\n'
    const enlisted = readyOrThrow(enlist(bare)).next
    expect(readyOrThrow(unenlist(enlisted)).next).toBe(bare)
  })

  it('unenlist on a file we never touched is already-settled', () => {
    expect(unenlist(UNRELATED).kind).toBe('already-settled')
  })

  it('unenlist removes every env key the RECIPE declares, so a new variable cannot be stranded', () => {
    // Derived rather than listed. A hand-written removal list would strand any
    // variable later added to `cli/telemetry-env.ts` in the operator's file
    // forever — a fingerprint left by an act whose whole promise is reversal.
    const enlisted = readyOrThrow(enlist(UNRELATED)).next
    const restoredEnv = JSON.parse(readyOrThrow(unenlist(enlisted)).next).env
    for (const key of Object.keys(claudeEnvRecipe(CONTEXT).env)) expect(restoredEnv).not.toHaveProperty(key)
    expect(restoredEnv.EDITOR).toBe('vim')
  })
})

describe('what enlistment refuses, and what it offers instead', () => {
  const ENLIST_CONTEXT: HarnessEnlistContext = { ...CONTEXT, runnerPath: '/opt/rhizomorph/bin/rhizomorph' }
  const TARGET = claudeAdapter.enlistmentTarget('/home/operator')
  const enlist = (current: string | null) =>
    claudeAdapter.planEnlistment(current, TARGET, { kind: 'enlist', context: ENLIST_CONTEXT })

  it('refuses a pre-existing foreign OTLP endpoint BY NAME, and still offers the hooks', () => {
    // Ruling 4's merge-never-clobber clause, the case the ruling names by hand.
    // The operator already exports somewhere, and overwriting it would silently
    // redirect telemetry they configured deliberately.
    const foreign = JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel.corp.internal:4318' } }, null, 2)
    const plan = enlist(foreign)
    if (plan.kind !== 'ready') throw new Error(`expected ready, got ${plan.kind}`)

    expect(plan.refusals).toHaveLength(1)
    expect(plan.refusals[0]?.keyPath).toEqual(['env', 'OTEL_EXPORTER_OTLP_ENDPOINT'])
    expect(plan.refusals[0]?.existing).toBe('http://otel.corp.internal:4318')
    expect(plan.refusals[0]?.offer).toMatch(/hooks-only/)
    // Refused, and NOT overwritten in the document that would be written.
    expect(JSON.parse(plan.next).env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel.corp.internal:4318')
    // And the hooks still land, which is what makes the offer a real one.
    expect(Object.keys(JSON.parse(plan.next).hooks)).toHaveLength(CLAUDE_HOOK_EVENTS.length)
  })

  it('refuses malformed JSON rather than repairing it', () => {
    // A hand that "fixed" an operator's settings file would be rewriting
    // something it does not understand, and the backup it took would be of a
    // file nobody asked it to touch.
    const plan = enlist('{ "theme": "dark", oops }')
    expect(plan.kind).toBe('refused')
    if (plan.kind !== 'refused') return
    expect(plan.reason).toMatch(/not valid JSON/)
    expect(plan.remedy).toMatch(/by hand/)
  })

  it('refuses a JSON document that is not an object', () => {
    expect(enlist('["not", "a", "settings", "object"]').kind).toBe('refused')
  })

  it('carries a digest of the text it planned FROM, so the write can refuse a changed file', () => {
    const a = enlist(JSON.stringify({ theme: 'dark' }, null, 2) + '\n')
    const b = enlist(JSON.stringify({ theme: 'light' }, null, 2) + '\n')
    if (a.kind !== 'ready' || b.kind !== 'ready') throw new Error('expected ready plans')
    expect(a.sourceDigest).not.toBe(b.sourceDigest)
    expect(a.sourceDigest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('a harness with no capture refuses to be enlisted at all', () => {
  it('codex throws and says no capture — implemented for LAUNCHING is not enlistable', () => {
    // The two refusals arrive at the same words from opposite directions: codex
    // is implemented, and its telemetry channel is launch-time argv that
    // persists nowhere, so there is no captured document to merge into.
    expect(() => codexAdapter.enlistmentTarget('/home/operator')).toThrow(HarnessNotImplementedError)
    expect(() => codexAdapter.enlistmentTarget('/home/operator')).toThrow(/no capture/)
  })
})
