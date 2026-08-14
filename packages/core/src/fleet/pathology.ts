// ── the alarm ladder (ruling 8) ─────────────────────────────────────────────

export type LadderRank = 'calm' | 'notice' | 'needs-you' | 'broken'

export const LADDER_ORDER = ['calm', 'notice', 'needs-you', 'broken'] as const

export const LADDER_WORD: Record<LadderRank, string> = {
  calm: 'ALL CLEAR',
  notice: 'NOTICE',
  'needs-you': 'NEEDS YOU',
  broken: 'BROKEN',
}

export function rankIndex(rank: LadderRank): number {
  return LADDER_ORDER.indexOf(rank)
}

export function worseRank(a: LadderRank, b: LadderRank): LadderRank {
  return rankIndex(a) >= rankIndex(b) ? a : b
}

// ── pathologies (ruling 18) ─────────────────────────────────────────────────

export type PathologyKind = 'looping' | 'frozen' | 'waiting' | 'expensive' | 'off-fence'

export const PATHOLOGY_KINDS = [
  'looping',
  'frozen',
  'waiting',
  'expensive',
  'off-fence',
] as const satisfies readonly PathologyKind[]

/** Which rung each pathology climbs to. A lane takes the worst it carries. */
export const PATHOLOGY_RANK: Record<PathologyKind, LadderRank> = {
  // Dead air is the only lane state that is unambiguously broken.
  frozen: 'broken',
  // These three all want a human; hue says that, form says which (graft g4).
  looping: 'needs-you',
  waiting: 'needs-you',
  'off-fence': 'needs-you',
  // A burn outlier is worth knowing, not worth interrupting for.
  expensive: 'notice',
}

export const PATHOLOGY_WORD: Record<PathologyKind, string> = {
  looping: 'LOOPING',
  frozen: 'FROZEN',
  waiting: 'WAITING',
  expensive: 'EXPENSIVE',
  'off-fence': 'OFF-FENCE',
}

/** Prefixes any evidence a weaker signal produced. See {@link Pathology.inferred}. */
export const INFERRED_MARK = '~'

export interface Pathology {
  kind: PathologyKind
  rank: LadderRank
  /** When the condition started, as well as the log can say. Null when it can't. */
  since: number | null
  /**
   * One terse clause naming the recorded facts behind the call — never a bare
   * label (graft g4). This is what the attention chip renders.
   */
  evidence: string
  /**
   * True when a weaker signal was needed to reach this call: WAITING is
   * *certain* when workmux declared it and *inferred* when it was read off a
   * quiet lane with a live pane. Inferred evidence renders with
   * {@link INFERRED_MARK} so a reader can tell a fact from a deduction.
   */
  inferred: boolean
}

/** The evidence as it should be shown: inferences wear their mark. */
export function evidenceLine(pathology: Pathology): string {
  return pathology.inferred ? `${INFERRED_MARK} ${pathology.evidence}` : pathology.evidence
}
