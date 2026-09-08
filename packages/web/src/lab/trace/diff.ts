import type { Step } from './steps.js'

/**
 * How one step of an arm stands against its parent (prd53 S3):
 * - `same` — both have the step, and it is the same step;
 * - `diverged` — both have a step here, and it differs;
 * - `added` — the arm has a step here and the parent has none;
 * - `absent` — the parent has a step here and the arm has none (a dead arm's
 *   tail reads as `absent` rows, and nothing dashes forward).
 */
export type Divergence = 'same' | 'diverged' | 'added' | 'absent'

export interface DiffRow {
  /** 0-based row number. Row 0 is the fork row. */
  index: number
  kind: Divergence
  arm: Step | null
  parent: Step | null
}

export interface TraceDiff {
  /** Steps the two transcripts share before the fork — the arm's inherited history. */
  forkAt: number
  /** Row 0 is the fork row (`same` by construction when any history is shared); rows follow step by step. */
  rows: DiffRow[]
  armSteps: number
  parentSteps: number
}

/**
 * Aligns by CONTENT, not by byte: the arm's file is a path-rewritten copy of
 * the parent's up to the checkpoint, so the shared history is the longest
 * common prefix of step keys, and the fork row is its last step — `same` by
 * construction. From there the two are read step by step, positionally: the
 * first difference is `diverged`, and everything one side has that the other
 * does not is `added` or `absent`. Positional, deliberately — this shows
 * WHERE an arm left the parent behind, not an edit script between them.
 */
export function diffSteps(parent: readonly Step[], arm: readonly Step[]): TraceDiff {
  let forkAt = 0
  while (forkAt < parent.length && forkAt < arm.length && parent[forkAt]?.key === arm[forkAt]?.key) forkAt += 1

  const rows: DiffRow[] = []
  if (forkAt > 0) {
    rows.push({ index: 0, kind: 'same', arm: arm[forkAt - 1] ?? null, parent: parent[forkAt - 1] ?? null })
  }
  const last = Math.max(parent.length, arm.length)
  for (let i = forkAt; i < last; i += 1) {
    const p = parent[i] ?? null
    const a = arm[i] ?? null
    const kind: Divergence = p !== null && a !== null ? (p.key === a.key ? 'same' : 'diverged') : a !== null ? 'added' : 'absent'
    rows.push({ index: rows.length, kind, arm: a, parent: p })
  }
  return { forkAt, rows, armSteps: arm.length, parentSteps: parent.length }
}
