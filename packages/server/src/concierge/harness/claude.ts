import { renderTelemetryEnv } from '../../cli/telemetry-env.js'
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
 * The claude adapter — prd-20 ruling 4's "claude first-class", implemented end
 * to end because it is the one harness whose every claim here is proven.
 *
 * ## The env recipe is read from the CLI, never restated
 *
 * `cli/telemetry-env.ts` already owns the exact block that makes a `claude`
 * process export to this server's receiver, and it is owned by the CLI: this
 * lane reuses it and does not touch it. Reuse here means *reading its output*
 * rather than copying its key list into a second place — `.workmux.yaml`, the
 * docs and `rhizomorph env` all depend on that block being byte-for-byte what
 * it always was, and a fork of the key list would be a second truth free to
 * drift from the first the next time an interval or a variable changes.
 *
 * So {@link claudeEnvRecipe} renders the `sh` form and parses it back into the
 * map a launch needs. `claude.test.ts` asserts the parse round-trips every
 * variable the renderer emits, so a new variable added to the CLI's block
 * arrives here automatically and a drift fails a test rather than shipping.
 */

/**
 * `export KEY=VALUE` lines back into a map.
 *
 * Split on the FIRST `=` only: `OTEL_RESOURCE_ATTRIBUTES` carries
 * `lane=…,role=…,instance=…`, so a naive split would truncate the one variable
 * that names the lane. The `sh` rendering is unquoted and one variable per
 * line, which is what makes this safe — and what the round-trip test pins.
 */
/**
 * The characters a lane may not contain, and why the check lives *here*.
 *
 * `renderTelemetryEnv`'s `sh` arm is `export ${key}=${value}` — unquoted, one
 * variable per line — and {@link parseShellEnv} reads it back line by line. So:
 *
 * - a **newline** in a lane becomes a whole extra `export` line, i.e. an
 *   environment variable of the caller's choosing in the launched agent's
 *   process. `OTEL_EXPORTER_OTLP_ENDPOINT` is the interesting one to overwrite:
 *   telemetry the operator believes is arriving here would be posted somewhere
 *   else entirely, and the picker would show a silent zero.
 * - an **`=`** corrupts `OTEL_RESOURCE_ATTRIBUTES`, whose own grammar is
 *   `lane=…,role=…,instance=…`, so the receiver books the telemetry against a
 *   lane nobody named. A `,` does the same by adding a bogus attribute pair.
 *
 * The renderer is `cli/telemetry-env.ts`'s and belongs to the CLI — this lane
 * reuses it and does not change it, so quoting is not the fix available here.
 * The seam is where the precondition belongs instead, and it is a **refusal**
 * rather than an escape or a silent sanitisation: escaping would fork the CLI's
 * block, and sanitising would launch an agent booked under a lane name the
 * operator did not choose. #263 inherits a thrown error, not a surprise.
 */
const LANE_FORBIDDEN = /[\n\r=,]/

/**
 * Refuse a lane the `sh` block cannot carry, before anything renders it.
 *
 * @throws {RangeError} for a lane containing a newline, `=` or `,`.
 */
function assertLaneIsRenderable(lane: string): void {
  if (!LANE_FORBIDDEN.test(lane)) return
  throw new RangeError(
    'refused: a lane name may not contain a newline, `=` or `,`. The env block is `export KEY=VALUE`, unquoted and ' +
      'one variable per line, so such a lane would inject an extra environment variable into the launched agent or ' +
      'corrupt OTEL_RESOURCE_ATTRIBUTES\u2019 own key=value grammar (see HarnessLaunchContext.lane). ' +
      `Received ${JSON.stringify(lane)}`,
  )
}

function parseShellEnv(block: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const assignment = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed
    const separator = assignment.indexOf('=')
    if (separator <= 0) continue
    env[assignment.slice(0, separator)] = assignment.slice(separator + 1)
  }
  return env
}

/** The environment a `claude` launch must carry, sourced from the CLI's own renderer. */
export function claudeEnvRecipe(context: HarnessLaunchContext): HarnessEnvRecipe {
  assertLaneIsRenderable(context.lane)

  // The dialect is deliberately NOT passed. `renderTelemetryEnv` defaults to
  // `sh`, which is the form this parses — and `cli/telemetry-env.ts` records
  // that `sh` "is the default and must stay byte-for-byte what it always was",
  // because `.workmux.yaml` and every doc built on it assume that exact output.
  //
  // Naming the dialect explicitly would spell `shell:` in this file, and the
  // concierge namespace law's clause 4 now reads ANY `shell:` that is not
  // literally `false` as a shell-enabled spawn. That rewrite is right — seven
  // ordinary spellings walked through the old patterns — and this property is a
  // text-format selector rather than a spawn option, but a law over source text
  // cannot tell them apart and is not this lane's to amend. Relying on the
  // documented default is the honest resolution rather than a way around it:
  // there is now no `shell:` in this module at all. `claude.test.ts` pins the
  // rendered form, so a changed default fails a test rather than silently
  // producing a block this cannot parse.
  const block = renderTelemetryEnv({
    lane: context.lane,
    role: context.role,
    port: context.port,
    instance: context.instance,
  })

  return {
    env: parseShellEnv(block),
    // claude is configured entirely through the environment; it needs no argv.
    configArgv: [],
    telemetry: { level: 'provided' },
    evidence:
      'the block is `cli/telemetry-env.ts` rendered and parsed back, not a copy of it — the same block ' +
      '`rhizomorph env` and `.workmux.yaml` already use, whose OTLP/HTTP JSON export to this server was ' +
      'captured in the prd-9 trace-era work (claude 2.1.220, verdict GO)',
  }
}

/**
 * argv[0] for a claude launch: the executable detection verified, or the bare
 * name when the caller detected nothing.
 *
 * The bare name is not a silent fallback — it is the honest answer when no path
 * was supplied, and it leaves resolution to the spawner, which is exactly what
 * a caller that skipped detection has asked for.
 */
function claudeCommand(context: HarnessLaunchContext): string {
  return context.executablePath ?? 'claude'
}

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  implementation: { status: 'implemented' },

  detect(options: DetectOptions = {}): Promise<HarnessDetection> {
    return detectHarness('claude', 'claude', options)
  },

  envRecipe: claudeEnvRecipe,

  launchArgv(context: HarnessLaunchContext): readonly string[] {
    // The telemetry rides in the environment, so a fresh launch is just the
    // command — but WHICH file that is matters. `detectOnPath` skipped empty and
    // relative PATH entries so a file inside the watched repo's working tree
    // could never become the thing this hand launches; returning a bare
    // `['claude']` would throw that away, because the spawner would re-resolve
    // the name against its own PATH at spawn time with none of that filtering.
    // So the verified path wins when the caller has one.
    //
    // An array, never a command string — ADR-0019 clause 4.
    return [claudeCommand(context)]
  },

  /**
   * `claude --continue` — the one proven continuity story in this registry, and
   * the evidence prd-20 ruling 3 and ADR-0019's option D both rest on.
   *
   * What is lost is stated because the ruling requires it, and because it is
   * the honest half of the offer: instrumentation attaches at launch and never
   * retroactively (`docs/telemetry.md`), so the *conversation* continues but
   * the previous process's work is not back-filled. Nothing it did before this
   * relaunch will ever appear in this instrument. A front door that quietly
   * implied otherwise would be the lie ADR-0019 refused to tell.
   */
  continueArgv(): ContinuityPlan {
    return {
      kind: 'proven',
      argv: ['--continue'],
      whatContinues: 'the previous conversation — its history and context are resumed in the new process',
      whatIsLost:
        'everything the old process already did. Instrumentation attaches at launch, so telemetry begins at this ' +
        'relaunch and the prior turns are never back-filled; the old process must be ended by the operator, and ' +
        'anything it was mid-way through is not carried over',
      evidence:
        'prd-20 evidence and ADR-0019 option D both name `claude --continue` as the reachable form of ' +
        'relaunch-with-continuity; docs/telemetry.md records the attach-at-launch physics it is a response to',
    }
  },
}
