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
 * ## This module is deliberately unwired
 *
 * ADR-0014 clause 7 and the concierge namespace law: the declared-importer set
 * is EMPTY and a test asserts it stays empty, so nothing may import this yet.
 * The registry is built before it is reachable, which is the whole point of
 * fencing a hand before it exists. The route that reaches it is #263's, gated
 * on #234 (prd-20 ruling 2).
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
 * Three states, never two.
 *
 * `unknown` is the state this whole lane turns on. A detector that reports a
 * present harness as absent is worse than one that admits it cannot see: the
 * picker would tell an operator "codex is not installed" on a machine where it
 * plainly is, and prd-19's entire claim is that the instrument's statements are
 * facts. Collapsing `unknown` into `absent` is the specific failure mode this
 * type exists to make unrepresentable.
 *
 * `absent` and `unknown` are *compiler-required* to carry prose — the same move
 * ADR-0010 makes for `CapabilityDetail`, and for the same reason: an optional
 * reason is a reason nobody writes.
 */
export type HarnessPresence =
  | { state: 'present'; evidence: string; executablePath?: string }
  /** The place was looked at, and the harness is not in it. */
  | { state: 'absent'; evidence: string }
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
  /** The lane (or conductor) name the telemetry is booked under. */
  readonly lane: string
  readonly role: AgentRole
  /** The port this Rhizomorph's OTLP receiver is listening on. */
  readonly port: number
  /** This Rhizomorph's instance id. The receiver refuses telemetry without it. */
  readonly instance: string
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
   * concierge writes nothing outside its own namespace, and ADR-0014 clause 4
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
   * An array, never a command string: ADR-0014 clause 4 forbids this hand a
   * shell, which is what removes the injection path a repo URL or branch name
   * would otherwise take.
   *
   * @throws {HarnessNotImplementedError} when {@link implementation} is `declared`.
   */
  launchArgv(context: HarnessLaunchContext): readonly string[]

  /** @throws {HarnessNotImplementedError} when {@link implementation} is `declared`. */
  continueArgv(context: HarnessLaunchContext): ContinuityPlan
}
