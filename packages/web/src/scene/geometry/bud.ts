import type { Lane } from '../../fleet/index.js'
import { budLife } from './scale.js'
import { pointAt, sampleQuad, tangentAt } from './curves.js'
import type { BudGeometry, Point } from './types.js'

/** How far along the parent a bud branches off, and how far it reaches. */
const BUD_AT = 0.46
const BUD_LENGTH_PX = { min: 13, span: 15 } as const

// ── subagent buds ───────────────────────────────────────────────────────────

/**
 * THIS LANE'S BUD, or null (prd10 ruling 9, see {@link BudGeometry}).
 *
 * Liveness is **read**, never re-derived: `lane.subagents` is
 * `selectSubagentActivity`'s vital, and a trace span may only *enrich* it,
 * never decide it. This file adds only staleness (by the frame's clock),
 * turned into a length.
 *
 * The branchlet leaves the parent at {@link BUD_AT}, inside the filaments'
 * band (0.58 and out) so the two never overlap.
 */
export function layoutBud(
  lane: Lane,
  path: readonly Point[],
  perp: Point,
  now: number,
  phase: number,
): BudGeometry | null {
  const vital = lane.subagents
  if (vital === null) return null

  const sinceMs = Math.max(0, now - vital.lastActivityTs)
  // The window is core's, not ours (`DEFAULT_SUBAGENT_RECENCY_MS`): the vital and
  // the picture have to agree about what "live" means, and one of them owns it.
  const { vitality, absorb } = budLife(sinceMs)
  // Absorbed and gone. The vital will drop to null on the next fleet rebuild; the
  // picture does not wait for it, because it can already see the reading expire.
  if (vitality <= 0) return null

  const origin = pointAt(path, BUD_AT)
  const along = tangentAt(path, BUD_AT)
  const side = phase < 0.5 ? -1 : 1
  const reach = (BUD_LENGTH_PX.min + BUD_LENGTH_PX.span * phase) * vitality

  const tip: Point = {
    x: origin.x + along.x * reach * 0.42 + perp.x * side * reach * 0.86,
    y: origin.y + along.y * reach * 0.42 + perp.y * side * reach * 0.86,
  }
  const control: Point = {
    x: origin.x + along.x * reach * 0.58 + perp.x * side * reach * 0.24,
    y: origin.y + along.y * reach * 0.58 + perp.y * side * reach * 0.24,
  }

  return {
    at: BUD_AT,
    path: sampleQuad(origin, control, tip, 10),
    // Finer than the parent's tip: a bud is anatomy of its thread, not a thread.
    width: 0.8,
    tip,
    vitality,
    absorb,
    sinceMs,
    kind: vital.subagentType,
  }
}
