import { otlpEndpoint } from '../../cli/telemetry-env.js'
import { detectHarness } from './detect.js'
import type {
  ContinuityPlan,
  DetectOptions,
  HarnessAdapter,
  HarnessDetection,
  HarnessEnvRecipe,
  HarnessLaunchContext,
} from './types.js'

/**
 * The codex adapter — prd-20 ruling 4's "codex next, its native OTel config".
 *
 * codex is the only non-claude harness with a real capture in this repo's
 * record, which is why it is here and gemini/pi are not. What follows separates
 * two things that are easy to blur, and prd-19's whole claim depends on not
 * blurring them: **what is verified about codex's configuration**, and **what
 * is verified about telemetry actually arriving**. The first is settled. The
 * second is settled too — and the answer is that it does not.
 *
 * ## Verified here, against the installed binary
 *
 * The `otel.*` keys below were checked against **codex-cli 0.145.0** — the same
 * version `docs/research/2026-08-05-agnosticism-spike.md` cites — using codex's
 * own `--strict-config`, which refuses an unknown configuration field before it
 * does anything else. An invented key fails immediately:
 *
 * ```
 * $ codex exec --strict-config -c 'otel.zzz_bogus=1' …
 * Error loading config.toml: unknown configuration field `otel.zzz_bogus` in -c/--config override
 * ```
 *
 * while every key this adapter emits is accepted. That check is reproducible
 * and is written down in `codex.test.ts` as the source of the key list, so a
 * future codex that renames a key fails a human's re-run rather than silently
 * emitting config nobody reads.
 *
 * This matters because the note those codex facts originally came from
 * (`research/2026-08-03-trace-era-captures.md`) is **never committed** to this
 * repo — prd-26 annotates it that way seventeen times. Rather than cite a
 * document nobody can open, the keys were re-derived from the binary itself.
 *
 * ## Configured by argv, so this hand writes nothing
 *
 * codex reads `~/.codex/config.toml`, and the obvious implementation would
 * write that file. This adapter refuses to. ADR-0014 grants the concierge two
 * powers, and "edit the operator's codex configuration" is not among them —
 * a power not on the list costs another amendment.
 *
 * codex's `-c key=value` overrides make that refusal free: they take the same
 * dotted paths, parse the value as TOML, and were verified to reach even the
 * hyphenated nested table (`otel.exporter.otlp-http.endpoint`). So the whole
 * recipe rides in the argv array the launch power already passes, and the
 * concierge's write footprint for codex is zero.
 *
 * ## What is NOT true, stated plainly
 *
 * Correct configuration is not the same as arriving telemetry, and here it is
 * specifically not. The repo's own captured finding **[Ran — repo capture §2]**
 * is that codex posts all three signals to the **bare endpoint path**, with no
 * `/v1/<signal>` suffix. `packages/server/src/api/otel.ts` registers
 * `/v1/metrics`, `/v1/logs` and `/v1/traces` and nothing else. So a correctly
 * configured codex exports into a 404: the keys are right and the telemetry
 * still lands nowhere.
 *
 * That is why {@link codexEnvRecipe} declares `telemetry` **absent with a
 * reason** rather than `provided`. Declaring it `provided` because the config
 * parses would be exactly the "confident number sourced from nothing" ADR-0010
 * exists to forbid — and the operator, seeing a configured harness and no data,
 * would have no way to tell a real zero from an unreceived export. The bare-path
 * receiving route is prd-26's work, not this lane's.
 */

/** A TOML basic string. The value is parsed as TOML by codex, so it is escaped for TOML, not for a shell. */
function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** One `-c key=value` pair, as two argv entries. */
function override(key: string, value: string): string[] {
  return ['-c', `${key}=${value}`]
}

/**
 * codex's native OTel configuration, as argv overrides.
 *
 * The endpoint is `otlpEndpoint(port)` — the CLI's own helper, so codex is
 * pointed at exactly the base URL claude is, and the two cannot drift apart.
 */
export function codexEnvRecipe(context: HarnessLaunchContext): HarnessEnvRecipe {
  const configArgv = [
    ...override('otel.environment', tomlString('rhizomorph')),
    ...override('otel.exporter.otlp-http.endpoint', tomlString(otlpEndpoint(context.port))),
    // `json` over `binary`: this server's receiver speaks OTLP/HTTP JSON, the
    // same protocol the claude block selects.
    ...override('otel.exporter.otlp-http.protocol', tomlString('json')),
    // Off deliberately. The privacy posture the repo already defends against
    // for claude — identifying fields riding every signal by default — applies
    // here too, and an instrument has no business shipping prompts anywhere.
    ...override('otel.log_user_prompt', 'false'),
    // Identity, declared at the source (prd-2's ruling), in codex's own
    // vocabulary rather than claude's OTEL_RESOURCE_ATTRIBUTES.
    ...override('otel.span_attributes.lane', tomlString(context.lane)),
    ...override('otel.span_attributes.role', tomlString(context.role)),
    ...override('otel.span_attributes.instance', tomlString(context.instance)),
  ]

  return {
    // codex needs no environment block at all; its whole recipe is argv.
    env: {},
    configArgv,
    telemetry: {
      level: 'absent',
      reason:
        'the keys are verified against codex-cli 0.145.0, but codex posts OTLP to the BARE endpoint path with no ' +
        '/v1/<signal> suffix [Ran — repo capture, docs/research/2026-08-05-agnostic-adapters-spike.md], and ' +
        'api/otel.ts serves /v1/metrics, /v1/logs and /v1/traces only — so a correctly configured codex exports ' +
        'into a 404 and this server receives nothing',
      remedy:
        'a bare-path OTLP route with body-shape routing, plus a pricing table for codex cost (prd-26) — not this lane',
    },
    evidence:
      'every key above accepted by `codex exec --strict-config` on codex-cli 0.145.0, where an unknown field is ' +
      'refused outright; the non-arrival is the repo capture cited in the reason, not re-captured by this lane',
  }
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  displayName: 'Codex CLI',
  implementation: { status: 'implemented' },

  detect(options: DetectOptions = {}): Promise<HarnessDetection> {
    return detectHarness('codex', 'codex', options)
  },

  envRecipe: codexEnvRecipe,

  launchArgv(context: HarnessLaunchContext): readonly string[] {
    return ['codex', ...codexEnvRecipe(context).configArgv]
  },

  /**
   * **Unproven, and said so rather than guessed.**
   *
   * `codex resume --last` is real: it is in the installed 0.145.0's own help
   * text ("Continue the most recent session without showing the picker"), so
   * the argv below is not invented. What is *not* established is that it means
   * for codex what `claude --continue` means for claude. prd-20 leaves this
   * open in as many words — "codex's resume story is not proven" — and no
   * capture in this repo shows a resumed codex session under a fresh config.
   *
   * The `unproven` arm still carries the argv, because the flag probably is
   * right and hiding it would help nobody. What it will not do is let a caller
   * reach that argv without reading the word `unproven` first.
   */
  continueArgv(context: HarnessLaunchContext): ContinuityPlan {
    return {
      kind: 'unproven',
      argv: ['resume', '--last', ...codexEnvRecipe(context).configArgv],
      reason:
        'the flag exists in codex-cli 0.145.0 --help, but nothing in this repo captures a resumed codex session, ' +
        'so what it restores — and what it drops — is not known the way `claude --continue` is known',
      toProve:
        'capture one codex session, resume it with --last under this recipe, and record what carried over; the ' +
        'telemetry half cannot be proven at all until the bare-path route exists (see the recipe above)',
    }
  },
}
