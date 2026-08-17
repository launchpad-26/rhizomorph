import { formatTokens, formatUsd } from '../lib/format.js'
import type { LaneIndexRow } from './laneIndex.js'

/**
 * THE LANE AXIS'S CELLS (prd-31 ruling 8 / S4, #558).
 *
 * Kept out of the component for the reason `recordings/format.ts` already is:
 * this file is about what a cell is *allowed to say*, and the component is
 * about layout. In particular the gap-honest rules (law 12) live here, where
 * they can be read in one place and tested without a DOM.
 *
 * The cost formatters deliberately mirror `format.ts`'s session-axis ones
 * exactly — same three states, same words. **Both axes render the same
 * underlying dollars**, so if they phrased provenance differently a person
 * would read one lane's spend two ways depending on which axis they were on,
 * which is the drift ruling 8 collapses these two surfaces to prevent.
 */

/** Dollars whenever any cost telemetry exists; tokens when none ever arrived. Never a fabricated `$0.00`. */
export function laneCostText(lane: Pick<LaneIndexRow, 'costUsd' | 'costIsAuthoritative' | 'outputTokens'>): string {
  if (lane.costIsAuthoritative === null) return `${formatTokens(lane.outputTokens)} tok out`
  return formatUsd(lane.costUsd)
}

/** True when the cost cell is speaking a gap rather than a dollar figure. */
export function isLaneCostGap(lane: Pick<LaneIndexRow, 'costIsAuthoritative'>): boolean {
  return lane.costIsAuthoritative === null
}

/** `est.` beside the figure — the same convention the fleet table, the ledger and the session axis use. */
export function laneCostSuffix(lane: Pick<LaneIndexRow, 'costIsAuthoritative'>): string | null {
  return lane.costIsAuthoritative === false ? 'est.' : null
}

/** S4's *cost with provenance*: what the figure is, and how it was arrived at. */
export function laneCostTitle(lane: Pick<LaneIndexRow, 'costIsAuthoritative'>): string {
  if (lane.costIsAuthoritative === null) return 'no cost telemetry recorded for this lane, in any session'
  if (lane.costIsAuthoritative === false) {
    return 'estimated — at least one of this lane’s sessions had no authoritative cost feed'
  }
  return 'authoritative dollar cost (OTel), in every session this lane ran in'
}

export interface LaneOutcome {
  word: string
  title: string
  /** True for an outcome the log cannot actually claim — rendered dim rather than as a finding. */
  inferred: boolean
}

/**
 * THE OUTCOME (S4's *by lane* column), and its whole difficulty is that the
 * index knows less than a reader assumes.
 *
 * Three facts exist and no fourth: whether a recording watched the worktree go
 * away, how many commits landed, and whether anything was ever seen at all.
 * "Landed" is therefore stated only when both of the first two hold — a
 * worktree that vanished with no commit behind it is a lane that was abandoned
 * or folded, and calling that "landed" would be the instrument inventing a
 * success. Everything softer is marked {@link LaneOutcome.inferred} and reads
 * dim, because the honest answer to "what happened to this lane" is frequently
 * *the log cannot say*.
 */
export function laneOutcome(lane: Pick<LaneIndexRow, 'worktreeRemoved' | 'commitCount' | 'lastSeenAt'>): LaneOutcome {
  if (lane.worktreeRemoved && lane.commitCount > 0) {
    return {
      word: 'landed',
      title: `its worktree was removed after ${lane.commitCount} commit${lane.commitCount === 1 ? '' : 's'} landed — the shape of a lane that merged`,
      inferred: false,
    }
  }
  if (lane.worktreeRemoved) {
    return {
      word: 'folded',
      title:
        'its worktree was removed and no commit was ever recorded for it — abandoned, or landed in a session this index could not read',
      inferred: false,
    }
  }
  if (lane.commitCount > 0) {
    return {
      word: `${lane.commitCount} commit${lane.commitCount === 1 ? '' : 's'}`,
      title: 'commits landed and the worktree was still there when the last recording ended — unfinished, as far as the log saw',
      inferred: true,
    }
  }
  if (lane.lastSeenAt === null) {
    return { word: '—', title: 'nothing was ever recorded for this lane beyond its name', inferred: true }
  }
  return {
    word: 'no outcome',
    title: 'no commit and no worktree removal was recorded — the log cannot say how this ended',
    inferred: true,
  }
}

/** How many recordings this lane spans, plus the ones that could not be read at all. */
export function laneSessionsText(lane: Pick<LaneIndexRow, 'sessionIds' | 'missingSessionIds'>): string {
  const spanned = lane.sessionIds.length
  const missing = lane.missingSessionIds.length
  const base = `${spanned} session${spanned === 1 ? '' : 's'}`
  return missing === 0 ? base : `${base} · ${missing} unreadable`
}

export function laneSessionsTitle(lane: Pick<LaneIndexRow, 'sessionIds' | 'missingSessionIds'>): string {
  const spanned = lane.sessionIds.length === 0 ? 'no recording holds this lane' : lane.sessionIds.join(', ')
  if (lane.missingSessionIds.length === 0) return spanned
  return `${spanned} — and ${lane.missingSessionIds.length} this index could not read: ${lane.missingSessionIds.join(', ')}`
}
