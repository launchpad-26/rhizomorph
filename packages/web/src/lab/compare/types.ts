/**
 * PLAIN INPUTS FOR THE COMPARISON SURFACE (prd14 ruling 3, inheriting prd12
 * ruling 4). Wave 1 was writing `lab/types.ts` concurrently, so this module
 * took its own shape — a list of arms, each with its own model, brief and
 * runs — rather than importing anything from that sibling work. The adapter
 * that wires it to the real experiment types, per measure, is
 * `fromExperiment.ts` (prd53 S2).
 */

/**
 * One run's outcome under one measure. A run that hasn't finished, or didn't
 * succeed, is still shown — never dropped. A pending run may carry a `note`
 * saying WHY it is pending (unmeasured; or measured but with nothing booked
 * under this measure) — the surface prints it, so a pending dot is never a
 * dot the reader has to guess about (prd53 ruling 3).
 */
export type Run =
  | { id: string; status: 'complete'; value: number }
  | { id: string; status: 'pending'; note?: string }
  | { id: string; status: 'failed'; error?: string }

/** One arm: its own model, its own brief (ruling 2 — configured independently), and every run it has. */
export interface Arm {
  id: string
  model: string
  brief: string
  runs: Run[]
}

export interface ComparisonInput {
  arms: Arm[]
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
  completedValues: number[]
  pendingCount: number
  failedCount: number
  /** Null under any code path where fewer than the floor's completed runs exist (ruling 3, law 3; the floor is core's since prd53 ruling 2). */
  spread: Spread | null
  /** Set iff `spread` is null — the explicit voice the law requires instead of a dash. */
  insufficientReason: string | null
  /** Set iff `spread` is non-null but the arm still has pending or failed runs — what's missing, stated, not averaged over. */
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
