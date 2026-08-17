import { disclosureLines } from '../../disclosure/index.js'
import {
  isTerminalDone,
  selectLaneCondition,
  selectWorstPathology,
  TERMINAL_DONE_FACT,
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
 *
 * The STATE cell's *words* — {@link stateTitle}, {@link terminalDoneTitle} —
 * come from `@rhizomorph/core`'s condition selector (prd-30 ruling 2, #560)
 * rather than being composed here: this file used to hold its own copy of
 * "worst pathology wins, then terminal-done, then the bare activity word" and
 * that is exactly the shape of the failure prd-30 exists against, just
 * between two files in this package instead of two components. What stays
 * here is presentation only — which glyph and which hue, not which words.
 */

/** The worst pathology a lane carries, or null when it has none (a calm row). */
export function worstPathology(lane: Lane): Pathology | null {
  return selectWorstPathology(lane)
}

/** The STATE column's mark: the worst pathology's kind, or the calm activity. */
export function stateSigilKind(lane: Lane): SigilKind {
  return worstPathology(lane)?.kind ?? lane.activity
}

/**
 * The class the STATE column wears for an operator-parked lane (prd4 ruling
 * 5). Same floor ink as idle (`ice-400` — prd9's legibility floor forbids a
 * dimmer one), so "more stood-down than a lane that merely went quiet" is now
 * carried by style, not luminance: italic reads as an aside the way it does in
 * prose, the way idle's own plain ink does not.
 */
export const PARKED_TEXT_CLASS = 'text-ice-400 italic'

/**
 * TERMINAL-DONE's own title (issue #226) — distinct from a lane that declared
 * `done` or whose worktree was removed: this one is inferred from git
 * geography (clean, ahead of main, silent past FROZEN's own threshold) after
 * a pane died mid-run. Read where DONE would otherwise be a bare, unexplained
 * word — the whole point is telling the operator *which* kind of finish this
 * was. The sentence itself is `@rhizomorph/core`'s own ({@link TERMINAL_DONE_FACT}),
 * so this mark and {@link stateTitle} can never phrase the same finish two ways.
 */
export function terminalDoneTitle(): string {
  return TERMINAL_DONE_FACT
}

/**
 * The STATE cell's title: the condition selector's own why and remedy, never
 * a bare label (graft g4) and never re-derived from `lane.activity` /
 * `lane.pathologies` / `lane.parked` here. `now` defaults to the wall clock
 * only for a caller with no fold position to hand in (prd-30's own "no clock
 * read" law binds the selector itself, not every legacy caller of this
 * wrapper); the fleet table passes the fold's own `fleet.now` below.
 */
export function stateTitle(lane: Lane, now: number = Date.now()): string {
  const lines = disclosureLines(selectLaneCondition(lane, now))
  const remedy = lines.command === null ? lines.remedy : `${lines.remedy}: ${lines.command}`
  return `${lines.why} · ${remedy}`
}

/**
 * The STATE cell's DONE suffix mark (issue #226) — sits beside the existing
 * `~` (inferred) and `+N` (more faults) marks for the same reason `stateTitle`
 * above appends its clause: a lane can be mid-alarm (OFF-FENCE, say) and
 * terminal-done at the same time, and the sigil must keep showing the alarm
 * (`stateSigilKind` is untouched by this — the pathology always wins). This
 * mark is how the finish still gets said instead of silently vanishing behind
 * the louder word.
 */
export function showsTerminalDoneMark(lane: Lane): boolean {
  return !lane.parked && worstPathology(lane) !== null && isTerminalDone(lane)
}

/**
 * The STATE cell's GIT STATUS mark (#606) — deliberately independent of
 * `selectLaneCondition`: it renders beside any condition, parked or not,
 * because `dirtyStatusFailedSince` is a recorded fact about the worktree, not
 * an inferred alarm (`Lane.parked`'s own docstring: parking suppresses
 * inferences, not facts). Never folded into `stateSigilKind`'s pathology, and
 * must not be — see the ADR-0022 note on `Lane.dirtyStatusFailedSince`.
 */
export function showsGitStatusIncidentMark(lane: Lane): boolean {
  return lane.dirtyStatusFailedSince !== null
}

/**
 * No message is retained for this incident (`reduce.ts`'s
 * `worktreeDirtyStatusFailed` keeps only the timestamp) — the title says so
 * rather than inventing detail, the same gap-honesty rule the cost/fence
 * cells above follow (law 12).
 */
export function gitStatusIncidentTitle(lane: Lane): string {
  const forMs = lane.dirtyStatusFailedForMs
  const forClause = forMs === null ? '' : ` for ${formatSpan(forMs)}`
  return `${lane.label}: git status --porcelain has failed repeatedly${forClause} — the underlying error is not retained in-app; check the server's own log`
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

/**
 * #141 — the fleet table's AGE column reads AGE / ACTIVE: how old the lane is
 * beside how much of that age OTel actually measured as active
 * (`claude_code.active_time.total`). Gap-honest (law 12): a lane with no OTel
 * reading shows AGE alone, never an invented `/ 0s`.
 */
export function ageActiveCellText(lane: Lane): string {
  const age = ageCellText(lane)
  if (lane.activeSeconds === null) return age
  return `${age} / ${formatSpan(lane.activeSeconds * 1000)}`
}

export function ageActiveCellTitle(lane: Lane): string {
  const age = ageCellTitle(lane)
  if (lane.activeSeconds === null) return `${age} · no OTel active-time reading for this lane`
  return `${age} · active ${formatSpan(lane.activeSeconds * 1000)} (claude_code.active_time.total, OTel)`
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
