import type { AttentionJoin } from '../state.js'

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

export type PathologyKind = 'looping' | 'frozen' | 'waiting' | 'expensive' | 'off-fence' | 'crashed'

export const PATHOLOGY_KINDS = [
  'looping',
  'frozen',
  'waiting',
  'expensive',
  'off-fence',
  'crashed',
] as const satisfies readonly PathologyKind[]

/**
 * The kinds `fleet/diagnose.ts` can DERIVE from a lane's own shape — ages,
 * cycles, spend, fence.
 *
 * A strict subset of {@link PATHOLOGY_KINDS}, and the gap between the two is
 * the point rather than an oversight. `crashed` (prd-57 ruling 5) is a
 * pathology in every sense this vocabulary means — it has a rung, a word, a
 * reason, a remedy, a sigil and a hue — but it is not DIAGNOSABLE: it turns on
 * a recorded edge (an actor seen, then gone, with no session end between) that
 * lives in the fold rather than in a `Lane`, and `server/crashed.ts` raises it
 * from the tick.
 *
 * Kept here rather than in `diagnose.ts` so a reader meets the distinction
 * where the vocabulary is defined, and so the fixture law that asserts full
 * coverage has something true to compare against. A law holding
 * `PATHOLOGY_KINDS` would be asserting that a demo fold can stage a process
 * death, which no fixture can do.
 */
export const DIAGNOSED_KINDS = [
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
  /**
   * prd-57 ruling 5 — and it takes `broken` for the same reason `frozen` does,
   * one certainty stronger. FROZEN is dead air, which is broken because nothing
   * else explains it; CRASHED is a recorded death with no session end, which is
   * broken because the recording says so.
   *
   * It mints NO new hue: `broken` is an existing named rank and the scene reads
   * `status.broken` off the palette it already has, so charter law 9 holds by
   * construction rather than by review.
   */
  crashed: 'broken',
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
  crashed: 'CRASHED',
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

/**
 * HOW a declaration reached this lane — prd-57 ruling 3, said on the evidence
 * line because the alternative is a reader who cannot tell.
 *
 * Both answers are DECLARED — neither is a guess, and the line never implies
 * one is weaker. What differs is who supplied the name:
 *
 * - **by lane** — the writer named this lane itself, which every beacon before
 *   the hook runner does: `rhizomorph env --hooks` renders the lane into the
 *   command it emits.
 * - **by pid** — the writer could not name a lane, and did not invent one. A
 *   hook fires inside the agent's own process and has never heard the lane's
 *   name; the process witness placed its pid, and that is what carried it here.
 *
 * An INFERRED attention never reaches this line at all — it comes from the
 * transcript organ, and `Pathology.inferred` already marks it with
 * `INFERRED_MARK` wherever it renders. The distinction the disclosure card
 * needed was never declared-versus-inferred, which was already visible; it was
 * declared-by-what.
 */
export function joinVoice(joinedBy: AttentionJoin): string {
  return joinedBy === 'pid' ? ' (joined by pid — the hook named no lane)' : ' (joined by lane)'
}
