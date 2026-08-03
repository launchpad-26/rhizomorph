import {
  evidenceLine,
  rankIndex,
  type Fleet,
  type Filament,
  type Gap,
  type Lane,
  type Pathology,
  type SigilKind,
} from '../../fleet/index.js'
import { formatSpan } from '../../fleet/index.js'
import { formatTokenBreakdown, formatTokens, formatUsd } from '../../lib/format.js'

/**
 * Cell logic for the fleet table (issue #78). Kept out of `index.tsx` so the
 * component stays about layout and this file stays about what a cell is
 * allowed to say — in particular the gap-honest rule that a missing feed reads
 * as an absence with a reason, never as a zero (law 12).
 */

/** The worst pathology a lane carries, or null when it has none (a calm row). */
export function worstPathology(lane: Lane): Pathology | null {
  if (lane.pathologies.length === 0) return null
  return [...lane.pathologies].sort(
    (a, b) => rankIndex(b.rank) - rankIndex(a.rank) || a.kind.localeCompare(b.kind),
  )[0] as Pathology
}

/** The STATE column's mark: the worst pathology's kind, or the calm activity. */
export function stateSigilKind(lane: Lane): SigilKind {
  return worstPathology(lane)?.kind ?? lane.activity
}

const ACTIVITY_TITLE: Record<Lane['activity'], string> = {
  working: 'active within the last window',
  waiting: 'stopped',
  done: 'finished — worktree landed or agent declared done',
  idle: 'quiet, past the idle threshold',
  unknown: 'no work signal yet',
}

/**
 * The class the STATE column wears for an operator-parked lane (prd4 ruling
 * 5). Same floor ink as idle (`ice-400` — prd9's legibility floor forbids a
 * dimmer one), so "more stood-down than a lane that merely went quiet" is now
 * carried by style, not luminance: italic reads as an aside the way it does in
 * prose, the way idle's own plain ink does not.
 */
export const PARKED_TEXT_CLASS = 'text-ice-400 italic'

/** The STATE cell's title for a parked lane: an acknowledgement, not a mute. */
export function parkedTitle(): string {
  return 'parked — declared in .swarm/lanes.json; alarm inferences suppressed, other evidence unaffected'
}

/** The STATE cell's title: the detector's own evidence, never a bare label (graft g4). */
export function stateTitle(lane: Lane): string {
  if (lane.parked) return parkedTitle()
  const worst = worstPathology(lane)
  if (worst === null) return ACTIVITY_TITLE[lane.activity]
  const extra = lane.pathologies.length - 1
  const line = evidenceLine(worst)
  return extra === 0 ? line : `${line} · +${extra} more: ${lane.pathologies.map(evidenceLine).join(' · ')}`
}

export function outputCellTitle(lane: Lane): string {
  return formatTokenBreakdown(lane.tokens)
}

export function outputCellText(lane: Lane): string {
  return formatTokens(lane.outputTokens)
}

/** `$` — `—` plus the feed gap when no cost telemetry has arrived at all (law 12). */
export function costCellText(lane: Lane): string {
  if (lane.costEventCount === 0) return '—'
  return formatUsd(lane.costUsd)
}

export function costCellTitle(lane: Lane, gaps: readonly Gap[]): string {
  if (lane.costEventCount === 0) {
    return gaps.find((gap) => gap.id === 'no-cost-feed')?.line ?? 'no cost telemetry for this lane'
  }
  if (lane.costIsAuthoritative === false) {
    return `estimated — not authoritative (${formatTokenBreakdown(lane.tokens)})`
  }
  return 'authoritative dollar cost (OTel)'
}

export function ageCellText(lane: Lane): string {
  return lane.ageMs === null ? '—' : formatSpan(lane.ageMs)
}

export function ageCellTitle(lane: Lane): string {
  return lane.ageMs === null ? 'no event recorded for this lane yet' : `last event ${formatSpan(lane.ageMs)} ago`
}

const THREAD_SHORT: Record<string, string> = {
  main: 'main',
  subagent: 'sub',
  auxiliary: 'aux',
}

/** Honest label for a thread source: the declared kind, or `unk` (prd2 law). */
export function threadShort(thread: Filament['thread']): string {
  return thread === null ? 'unk' : (THREAD_SHORT[thread] ?? 'unk')
}

/** Filaments other than the lane's own trunk — the second-generation growth (ruling 20). */
export function branchingFilaments(lane: Lane): Filament[] {
  return lane.filaments.filter((filament) => filament.thread !== 'main')
}

export function threadsCellTitle(lane: Lane): string {
  if (lane.filaments.length === 0) return 'no source reported a thread for this lane'
  return lane.filaments
    .map((f) => `${threadShort(f.thread)} ${formatTokens(f.outputTokens)} out · ${f.requestCount} req`)
    .join(' · ')
}

export type FenceCell =
  | { kind: 'no-manifest'; text: string; title: string }
  | { kind: 'unfenced'; text: string; title: string }
  | { kind: 'clean'; text: string; title: string }
  | { kind: 'breach'; text: string; title: string }

/**
 * Gap-honest fence cell (ruling 19, law 12): `none` plus the gap voice when
 * there is no manifest at all; otherwise the lane's own fence compliance, read
 * straight off the trespasses the derived fleet already computed — nothing is
 * re-inferred here.
 */
export function fenceCell(lane: Lane, fleet: Pick<Fleet, 'hasLaneManifest' | 'gaps'>): FenceCell {
  if (!fleet.hasLaneManifest) {
    return {
      kind: 'no-manifest',
      text: 'none',
      title:
        fleet.gaps.find((gap) => gap.id === 'no-lane-manifest')?.line ??
        'no lane manifest — off-fence detection unavailable',
    }
  }

  if (!lane.fenced) {
    return {
      kind: 'unfenced',
      text: '—',
      title:
        fleet.gaps.find((gap) => gap.id === 'unfenced-lanes')?.line ??
        'no fence declared for this lane — it cannot be judged off-fence',
    }
  }

  if (lane.trespasses.length === 0) {
    return { kind: 'clean', text: 'ok', title: 'inside its declared fence' }
  }

  const count = lane.trespasses.length
  return {
    kind: 'breach',
    text: `${count} out`,
    title: lane.trespasses.map((t) => `${t.path}${t.victim === null ? '' : ` → ${t.victim}`}`).join(' · '),
  }
}
