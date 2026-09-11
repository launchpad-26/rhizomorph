/**
 * PLAIN INPUTS FOR THE COMPARISON SURFACE (prd14 ruling 3, inheriting prd12
 * ruling 4). Wave 1 was writing `lab/types.ts` concurrently, so this module
 * took its own shape — a list of arms, each with its own model, brief and
 * runs — rather than importing anything from that sibling work. The adapter
 * that wires it to the real experiment types, per measure, is
 * `fromExperiment.ts` (prd53 S2).
 */

/**
 * One run, read for one measure. A run is COMPLETE when a gate has judged it —
 * pass or fail (prd53 ruling 2, amendment 2026-09-08: the same denominator
 * Metrics and the CLI count, core's `isCompletedVerdict`). Its `value` under
 * this measure may still be null — judged, but nothing booked yet — and then
 * `note` says so; a `fail` carries the gate's own words as `detail`. A run
 * nobody has measured, or whose gate never ran (`not-run`), is PENDING with a
 * note saying WHY (ruling 3): the surface prints it, so a pending dot is never
 * a dot the reader has to guess about. There is no "failed" run status: a
 * failed gate is a completed run, and an arm that never dispatched is a
 * {@link FailedArm}, not a run at all.
 */
export type Run =
  | {
      id: string
      status: 'complete'
      verdict: 'pass' | 'fail'
      value: number | null
      note?: string
      detail?: string
      /**
       * The three raw facts underlying EVERY measure, independent of which one
       * `value` above was resolved for (prd14 ruling 6). Optional: absent on a
       * `Run` built before ruling 6 (hand-authored fixtures, tests) — present
       * on every run `fromExperiment.ts` produces, complete or not, so a save
       * can persist all three and a reopened v2 artifact can re-derive any
       * measure through the SAME `runForMeasure` the live surface uses, rather
       * than a second path that merely agrees with it.
       */
      cost?: number | null
      duration?: number | null
      commits?: number | null
    }
  | { id: string; status: 'pending'; note?: string }

/** One arm: its own model, its own brief (ruling 2 — configured independently), and every run it has. */
export interface Arm {
  id: string
  model: string
  brief: string
  runs: Run[]
}

/** The gate's own account of how a run was judged (prd14 ruling 6) — this subtree's own vocabulary, structurally the same shape as `LabOutcomeProvenance` (`lab/types.ts`) but declared independently, the way this file already keeps its distance from that sibling module (see the file doc above). */
export interface ComparisonProvenance {
  verifyCommand: string
  source: 'measure-route' | 'compare-cli'
  measuredAt: number
}

export interface ComparisonInput {
  arms: Arm[]
  /**
   * The measure `Run.value`/`Run.note` above were read for, and the gate
   * provenance behind the judgement — carried so a save can persist both
   * without a second computation path (prd14 ruling 6). Optional: absent on a
   * hand-built `ComparisonInput` (tests, fixtures) that predates ruling 6, and
   * `provenance` is `null` rather than invented when nothing has been judged
   * yet.
   */
  measure?: 'cost' | 'duration' | 'commits' | 'verified'
  provenance?: ComparisonProvenance | null
}

/** A range, never a single collapsed number (ruling 3, law 2). */
export interface Spread {
  min: number
  max: number
}

/** The dimensions a plain `Arm` can differ on. Computed from the arms themselves — see `attribution.ts`. */
export type Dimension = 'model' | 'brief'

/**
 * What the comparison surface may honestly claim, computed from the arms'
 * own configuration (ruling 2) — never from a declared intent.
 */
export type ComparisonClaim =
  | { kind: 'single-arm' }
  | { kind: 'uniform' }
  | { kind: 'comparable'; dimension: Dimension }
  | { kind: 'confounded'; dimensions: Dimension[]; reason: string }

/** One arm's runs, always shown, plus its spread — or, below the floor of completed runs, an explicit reason there is none. */
export interface ArmSummary {
  armId: string
  model: string
  brief: string
  runs: Run[]
  /** Runs a gate has judged — pass or fail. THE floor's denominator: the same count Metrics and the CLI use, measure-independent. */
  completedCount: number
  passCount: number
  failCount: number
  pendingCount: number
  /** The completed runs' values under this measure — the spread's n. Smaller than `completedCount` when a value is not booked. */
  values: number[]
  /** Null below the floor (ruling 3, law 3; the floor is core's since prd53 ruling 2), and null at the floor when no completed run has a value under this measure. */
  spread: Spread | null
  /** Set iff the arm is below the floor — the explicit voice the law requires instead of a dash. */
  insufficientReason: string | null
  /** Set iff the floor is met but `values` is empty under this measure — judged, nothing booked, no `$0` invented. */
  unbookedNote: string | null
  /** Set iff the floor is met but the arm still has pending runs — what's missing, stated, not averaged over. */
  incompleteNote: string | null
}

export interface Comparison {
  arms: ArmSummary[]
  claim: ComparisonClaim
}

/** An arm the launch asked for that never dispatched (prd53 ruling 7) — present in the list, excluded from every spread, its failure stated. */
export interface FailedArm {
  arm: number
  error: string
}
