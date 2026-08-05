import { compareStrings, type CollisionEntry, type SessionState } from '@rhizomorph/core'
import { rankIndex, type LadderRank } from './pathology.js'
import type { AttentionItem, CalmEvidence, Ladder, Lane } from './types.js'

// ── the ladder ──────────────────────────────────────────────────────────────

/**
 * Assembles the ladder such that CALM is only reachable when the item list is
 * genuinely empty — collisions and broken collectors become items *here*, so
 * there is no later step at which a view could forget them (graft g5).
 */
export function buildLadder(
  lanes: readonly Lane[],
  collisions: readonly CollisionEntry[],
  state: SessionState,
  now: number,
  evidence: CalmEvidence,
): Ladder {
  const items: AttentionItem[] = []

  for (const lane of lanes) {
    // A parked lane never reaches the ladder (prd4 ruling 5) — the operator's
    // declaration is the acknowledgement, so nothing of this lane's escalates
    // to the attention strip or the tab title, however many pathologies it
    // still carries. It is still visible everywhere else: the fleet table's
    // own STATE cell, fence column and output/age cells read the lane
    // directly and are untouched by this skip.
    if (lane.parked) continue
    for (const pathology of lane.pathologies) {
      items.push({
        id: `${pathology.kind}:${lane.id}`,
        laneId: lane.id,
        label: lane.label,
        kind: pathology.kind,
        rank: pathology.rank as Exclude<LadderRank, 'calm'>,
        forMs: pathology.since === null ? null : Math.max(0, now - pathology.since),
        evidence: pathology.evidence,
        inferred: pathology.inferred,
      })
    }
  }

  // Ruling 14: a real collision is ONE ladder item that expands, not one per
  // contended file. Twenty-one contended files would otherwise report as
  // twenty-one things needing you — wrong arithmetic and wrong triage alike.
  const worst = collisions[0]
  if (worst !== undefined) {
    items.push({
      id: 'collision',
      // A collision belongs to a pair of branches, not to one lane, so it must
      // not be able to put the scene's spotlight on an arbitrary half of it.
      laneId: null,
      label:
        collisions.length === 1
          ? worst.branches.join(' ⇄ ')
          : `${collisions.length} files contended`,
      kind: 'collision',
      rank: 'needs-you',
      forMs: null,
      evidence: `worst: ${worst.path} — ${worst.branches.join(', ')}`,
      inferred: false,
    })
  }

  // Ruling 15: a broken collector escalates to the strip rather than sitting
  // quietly in the provenance bar where nobody is looking.
  for (const collector of Object.values(state.collectors)) {
    if (collector.status !== 'error') continue
    items.push({
      id: `collector:${collector.name}`,
      laneId: null,
      label: `${collector.name} collector`,
      kind: 'collector',
      rank: 'notice',
      forMs: collector.lastErrorTs === null ? null : Math.max(0, now - collector.lastErrorTs),
      evidence: collector.lastErrorMessage ?? `${collector.errorCount} errors`,
      inferred: false,
    })
  }

  if (items.length === 0) return { rank: 'calm', items: [], evidence }

  items.sort(
    (a, b) =>
      rankIndex(b.rank) - rankIndex(a.rank) ||
      (b.forMs ?? 0) - (a.forMs ?? 0) ||
      compareStrings(a.id, b.id),
  )

  const rank = items.reduce<Exclude<LadderRank, 'calm'>>(
    (worstSoFar, item) => (rankIndex(item.rank) > rankIndex(worstSoFar) ? item.rank : worstSoFar),
    'notice',
  )

  return { rank, items: items as [AttentionItem, ...AttentionItem[]] }
}

/**
 * #159 — the burn strip's one error figure (golden signals, dashboard-IA
 * spike §1's "errors and latency are absent from the top dock" finding; the
 * operator's own ruling keeps latency out and takes errors). Three existing,
 * already-computed facts, summed rather than re-detected: a lane counts as
 * `blocked` only when unparked (a parked lane workmux still marks WAITING is
 * the operator's own stand-down, not a fresh alarm — `parked` already covers
 * it), so the same lane never inflates both buckets at once.
 */
export function errorCountsOf(
  lanes: readonly Lane[],
): { total: number; blocked: number; parked: number; offFence: number } {
  const blocked = lanes.filter(
    (lane) => !lane.parked && lane.pathologies.some((p) => p.kind === 'waiting'),
  ).length
  const parked = lanes.filter((lane) => lane.parked).length
  const offFence = lanes.filter((lane) => lane.pathologies.some((p) => p.kind === 'off-fence')).length
  return { total: blocked + parked + offFence, blocked, parked, offFence }
}

/** Ruling 14: ALL CLEAR has to say what was checked to have earned it. */
export function calmEvidenceOf(
  lanes: readonly Lane[],
  touches: Record<string, { path: string }[]>,
  collisions: readonly CollisionEntry[],
): CalmEvidence {
  const files = new Set<string>()
  for (const list of Object.values(touches)) for (const touch of list) files.add(touch.path)

  const branchesChecked = Object.keys(touches).length
  const filesChecked = files.size

  return {
    lanes: lanes.length,
    working: lanes.filter((lane) => lane.activity === 'working').length,
    branchesChecked,
    filesChecked,
    // Pinned to the literal `0`, and unreachable while collisions exist:
    // `buildLadder` never returns the calm case once one is in the list.
    collisions: 0,
    line: `collisions: 0 — checked ${branchesChecked} branch${
      branchesChecked === 1 ? '' : 'es'
    } / ${filesChecked} file${filesChecked === 1 ? '' : 's'}`,
  }
}
