/**
 * PLAIN INPUTS FOR THE COMPARISON SURFACE (prd14 ruling 3, inheriting prd12
 * ruling 4). Wave 1 is writing `lab/types.ts` concurrently, so this module
 * takes its own shape — a list of arms, each with its own model, brief and
 * runs — rather than importing anything from that sibling work. Wiring this
 * to the real launch/checkpoint types is a later, trivial adapter.
 */

/** One run's outcome. A run that hasn't finished, or didn't succeed, is still shown — never dropped. */
export type Run =
  | { id: string; status: 'complete'; value: number }
  | { id: string; status: 'pending' }
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

/** One arm's runs, always shown, plus its spread — or, below n=3 completed runs, an explicit reason there is none. */
export interface ArmSummary {
  armId: string
  model: string
  brief: string
  runs: Run[]
  completedValues: number[]
  pendingCount: number
  failedCount: number
  /** Null under any code path where fewer than 3 runs have completed (ruling 3, law 3). */
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
