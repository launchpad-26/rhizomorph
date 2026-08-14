import type { AgentRole, CapabilityDetail } from '@rhizomorph/core'

/**
 * The `HarnessAdapter` seam — prd-20 ruling 4, "the harness registry is built
 * for N, claude first-class".
 *
 * Four members, and what varies per harness is only ever *how* each is
 * answered, never whether the harness is any good:
 *
 * - {@link HarnessAdapter.detect} — is this harness on PATH, and is one
 *   running? Three states, never two (see {@link HarnessPresence}).
 * - {@link HarnessAdapter.envRecipe} — what a launch must carry so this
 *   harness exports telemetry *to this server*. claude takes environment
 *   variables; codex takes its own `otel.*` config. The recipe carries both
 *   channels and a declaration of what it actually achieves.
 * - {@link HarnessAdapter.launchArgv} — the argv array to start it fresh.
 * - {@link HarnessAdapter.continueArgv} — the argv array to relaunch it with
 *   continuity, and what that continuity does and does not preserve.
 *
 * ## This module was built before it was wired
 *
 * ADR-0019 clause 7 and the concierge namespace law: the declared-importer set
 * names exactly `api/concierge.ts`, and #264's `POST /api/concierge/launch`
 * (`concierge/launch.ts`) is the first route to actually reach this registry,
 * gated on #234 (prd-20 ruling 2) — this seam was built before it was
 * reachable, which is the whole point of fencing a hand before it exists.
 *
 * ## Named, not ranked (ADR-0010)
 *
 * There is no `tier`, `score`, `rank` or `preferred` field anywhere in this
 * seam, and `harness-law.test.ts` asserts there never is one. "claude is
 * better than codex" is not a fact this code may encode. Each adapter declares
 * what it can and cannot do, each non-affirmative answer is *compiler-required*
 * to carry a reason, and nothing sorts them. This is ADR-0010's decision —
 * option D, the ranked tier list, was rejected and superseded — applied to
 * harnesses rather than to collectors.
 *
 * ## Never a guess dressed as support
 *
 * A harness whose launch recipe nobody has verified does not get a plausible
 * one. It is listed, with the reason it is not implemented, and its three
 * building members throw {@link HarnessNotImplementedError} rather than return
 * something that looks like an answer. Detection still works for it — knowing
 * pi is installed is true and useful even though instrumenting it is not built.
 */

/** The harnesses this registry knows the *name* of. Knowing a name is not supporting it. */
export type HarnessId = 'claude' | 'codex' | 'openclaw' | 'pi' | 'shell'

/**
 * Never two states, and never a state that flatters.
 *
 * `unknown` is the state this whole lane turns on. A detector that reports a
 * present harness as absent is worse than one that admits it cannot see: the
 * picker would tell an operator "codex is not installed" on a machine where it
 * plainly is, and prd-19's entire claim is that the instrument's statements are
 * facts. Collapsing `unknown` into `absent` is the specific failure mode this
 * type exists to make unrepresentable.
 *
 * `installed-not-launchable` is the fourth arm, and it is ADR-0010's shape
 * again — the one already used for pi at the {@link HarnessImplementation}
 * level, brought down to detection: "the harness is installed, and this hand
 * cannot start it" is two true statements, and neither `present` nor `absent`
 * can say both. It exists because of Windows: an npm-installed CLI on Windows
 * is a `.cmd` shim, Node cannot spawn a `.bat`/`.cmd` without a shell, and
 * ADR-0019 clause 4 forbids this hand a shell. Reporting such a shim as
 * `present` would promise a launch the launch path structurally cannot perform;
 * reporting it as `absent` would tell an operator their installed CLI is not
 * installed. Neither is true, so there is a fourth answer.
 *
 * Every non-`present` arm is *compiler-required* to carry prose — the same move
 * ADR-0010 makes for `CapabilityDetail`, and for the same reason: an optional
 * reason is a reason nobody writes.
 */
export type HarnessPresence =
  | { state: 'present'; evidence: string; executablePath?: string }
  /** The place was looked at, and the harness is not in it. */
  | { state: 'absent'; evidence: string }
  /**
   * Found, and unlaunchable by *this* hand. Never to be rendered as "not
   * installed" and never as a thing the concierge can start.
   */
  | {
      state: 'installed-not-launchable'
      evidence: string
      /** The file that was found. Reported so an operator can see it, NOT so a launch can use it. */
      foundAt: string
      /** Why this hand cannot start it. */
      reason: string
      remedy?: string
    }
  /** This build could not look. Never to be rendered as "not installed". */
  | { state: 'unknown'; reason: string; remedy?: string }

/**
 * What a detection run learned. The two questions are answered separately and
 * may disagree honestly — a harness can be on PATH while whether one is
 * *running* is unknown, which is exactly the macOS case today.
 */
export interface HarnessDetection {
  readonly harness: HarnessId
  /** Is there an executable file this hand could actually launch? */
  readonly onPath: HarnessPresence
  /** Is one running right now? `unknown` wherever the process table cannot be read. */
  readonly running: HarnessPresence
}

/** What a launch needs to know to point a harness at this server. */
export interface HarnessLaunchContext {
  /**
   * The lane (or conductor) name the telemetry is booked under.
   *
   * **Precondition, inherited by every caller:** this value reaches
   * `cli/telemetry-env.ts`'s renderer, whose `sh` arm is `export KEY=VALUE` —
   * unquoted, one variable per line. A lane carrying a newline would therefore
   * become an *extra* `export` line, i.e. an attacker-chosen environment
   * variable in the launched agent's process (`OTEL_EXPORTER_OTLP_ENDPOINT`
   * being the interesting one to overwrite), and a lane carrying `=` corrupts
   * `OTEL_RESOURCE_ATTRIBUTES`'s own `key=value` grammar.
   *
   * The renderer is the CLI's and is not this lane's to change, so the
   * obligation is stated here and *enforced at the seam*:
   * {@link HarnessAdapter.envRecipe} refuses such a lane rather than rendering
   * it (see `claude.ts`'s `assertLaneIsRenderable`). #263 inherits a refusal,
   * not a surprise.
   */
  readonly lane: string
  readonly role: AgentRole
  /** The port this Rhizomorph's OTLP receiver is listening on. */
  readonly port: number
  /** This Rhizomorph's instance id. The receiver refuses telemetry without it. */
  readonly instance: string
  /**
   * The executable file detection actually found —
   * {@link HarnessPresence}'s `executablePath` from a `present` reading, passed
   * back in.
   *
   * This exists so the *verified* path is what gets launched. `detectOnPath`
   * skips empty and relative `PATH` entries precisely so a file inside the
   * watched repo's working tree can never become the thing the concierge
   * launches; a bare `['claude']` argv throws that away, because whatever
   * spawns it re-resolves the name against the launching process's `PATH` at
   * spawn time with none of that filtering applied.
   *
   * Optional, because a caller may legitimately not have detected (a test, or
   * an operator-supplied path), in which case the bare command name is used and
   * resolution is the spawner's business. When it IS supplied it must be the
   * absolute path detection returned, not a name.
   */
  readonly executablePath?: string
}

/**
 * How a harness is told where to export.
 *
 * Two channels, because the two implemented harnesses genuinely differ and the
 * seam must not assume either is *the* mechanism: claude reads environment
 * variables, codex reads its own `otel.*` config. A harness that needs neither
 * returns both empty and says so in {@link telemetry}.
 */
export interface HarnessEnvRecipe {
  /** Environment variables the process must be launched with. */
  readonly env: Readonly<Record<string, string>>
  /**
   * Extra argv the harness needs in order to be configured — codex's
   * `-c otel.*` overrides. Deliberately argv rather than a config file: the
   * concierge writes nothing outside its own namespace, and ADR-0019 clause 4
   * means these are passed as an argv array, never through a shell.
   */
  readonly configArgv: readonly string[]
  /**
   * What this recipe actually achieves, in ADR-0010's vocabulary. `provided`
   * only where telemetry has been observed arriving; anything less carries its
   * reason. A recipe whose keys are correct but whose exports land nowhere is
   * NOT `provided`, and saying otherwise is the flattering guess ADR-0010 was
   * written to forbid.
   */
  readonly telemetry: CapabilityDetail
  /** Where the claims above were checked. Cited, so a reader can re-run it. */
  readonly evidence: string
}

/**
 * What relaunching with continuity means for this harness, and what it costs —
 * prd-20 ruling 3: the shop names what continuity means per harness and what is
 * lost, and never claims to attach to a running process.
 *
 * `proven` is *compiler-required* to state both what continues and what is
 * lost, so the honest half of the claim cannot be dropped. `unproven` still
 * carries argv — the flag may well be right — but a caller has to read the word
 * `unproven` to reach it, which is the point.
 */
export type ContinuityPlan =
  | {
      kind: 'proven'
      /** Arguments appended to {@link HarnessAdapter.launchArgv}'s command. */
      argv: readonly string[]
      whatContinues: string
      whatIsLost: string
      evidence: string
    }
  | {
      kind: 'unproven'
      argv: readonly string[]
      /** Why this is not proven, stated plainly. */
      reason: string
      /** The capture that would settle it. */
      toProve: string
    }
  | { kind: 'none'; reason: string }

/**
 * Whether this adapter is built, or merely named.
 *
 * `declared` is the ADR-0010 move: a harness nobody has verified is *listed*
 * with its reason rather than omitted (which would hide it) or guessed at
 * (which would lie about it).
 */
export type HarnessImplementation =
  | { status: 'implemented' }
  | {
      status: 'declared'
      /** Why this is not implemented. Never "coming soon". */
      reason: string
      /** What it would take — the capture or the proof, named. */
      whatItWouldTake: string
    }

/** Thrown when a `declared` harness is asked for a launch line it has no verified answer for. */
export class HarnessNotImplementedError extends Error {
  constructor(
    readonly harness: HarnessId,
    reason: string,
  ) {
    super(`${harness} is declared, not implemented: ${reason} (prd-20 ruling 4 / ADR-0010 — named, never guessed)`)
    this.name = 'HarnessNotImplementedError'
  }
}

/** Options a detector may be handed. All injectable, so a test needs no real machine. */
export interface DetectOptions {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  /** Where the process table lives. Overridable so tests can point at a fabricated procfs. */
  readonly procRoot?: string
}

/** The seam itself. Four members; everything above is what they return. */
export interface HarnessAdapter {
  readonly id: HarnessId
  /** How the picker spells it. Presentation only — carries no ordering. */
  readonly displayName: string
  readonly implementation: HarnessImplementation

  /** Is it here, and is one running? Answers for every adapter, implemented or not. */
  detect(options?: DetectOptions): Promise<HarnessDetection>

  /** @throws {HarnessNotImplementedError} when {@link implementation} is `declared`. */
  envRecipe(context: HarnessLaunchContext): HarnessEnvRecipe

  /**
   * The argv array to start this harness fresh, telemetry config included.
   * An array, never a command string: ADR-0019 clause 4 forbids this hand a
   * shell, which is what removes the injection path a repo URL or branch name
   * would otherwise take.
   *
   * argv[0] is {@link HarnessLaunchContext.executablePath} when the caller
   * supplies one, so the file detection verified is the file that runs.
   *
   * @throws {HarnessNotImplementedError} when {@link implementation} is `declared`.
   */
  launchArgv(context: HarnessLaunchContext): readonly string[]

  /** @throws {HarnessNotImplementedError} when {@link implementation} is `declared`. */
  continueArgv(context: HarnessLaunchContext): ContinuityPlan
}
