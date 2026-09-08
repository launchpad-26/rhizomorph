import type { DisclosureContent } from '../disclosure/index.js'
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
/**
 * The recorded cost's provenance (#220). `elapsedMs: 0` throughout, for the
 * reason `LaneAxis`'s own `whenDisclosure` spells out: a recordings index holds
 * finished history, and ageing a settled fact against the reader's clock would
 * make it drift every second while meaning nothing more.
 */
export function laneCostDisclosure(lane: Pick<LaneIndexRow, 'costIsAuthoritative'>): DisclosureContent {
  if (lane.costIsAuthoritative === null) {
    return {
      label: '$',
      why: {
        reason: 'no cost telemetry was recorded for this lane, in any session',
        evidence: { fact: 'not one of its sessions carried a dollar figure', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'the recording is finished — a cost that was never captured cannot be recovered from it' },
    }
  }
  if (lane.costIsAuthoritative === false) {
    return {
      label: '$',
      why: {
        reason: 'estimated — at least one of this lane’s sessions had no authoritative cost feed',
        evidence: { fact: 'the figure mixes the CLI’s own numbers with a vendored price table', elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'this is the best figure the recording holds; the est. mark says so on the glance' },
    }
  }
  return {
    label: '$',
    why: {
      reason: 'authoritative dollar cost, in every session this lane ran in',
      evidence: { fact: 'the agent CLI reported every figure itself (OTel)', elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'the figure comes from the CLI itself — there is nothing better to reach for' },
  }
}

export interface LaneOutcome {
  word: string
  disclosure: DisclosureContent
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
  /** Every arm is a settled historical reading — see {@link laneCostDisclosure} on the age. */
  const card = (label: string, reason: string, fact: string, because: string): DisclosureContent => ({
    label,
    why: { reason, evidence: { fact, elapsedMs: 0 } },
    remedy: { kind: 'none', because },
  })

  if (lane.worktreeRemoved && lane.commitCount > 0) {
    return {
      word: 'landed',
      disclosure: card(
        'landed',
        'the shape of a lane that merged',
        `its worktree was removed after ${lane.commitCount} commit${lane.commitCount === 1 ? '' : 's'} landed`,
        'landed work is finished — the row is here to be read, not acted on',
      ),
      inferred: false,
    }
  }
  if (lane.worktreeRemoved) {
    return {
      word: 'folded',
      disclosure: card(
        'folded',
        'abandoned, or landed in a session this index could not read',
        'its worktree was removed and no commit was ever recorded for it',
        'the log cannot tell the two apart, and says so rather than picking one',
      ),
      inferred: false,
    }
  }
  if (lane.commitCount > 0) {
    return {
      word: `${lane.commitCount} commit${lane.commitCount === 1 ? '' : 's'}`,
      disclosure: card(
        'commits',
        'unfinished, as far as the log saw',
        'commits landed and the worktree was still there when the last recording ended',
        'the recording ended before the lane did — nothing here is wrong, only unfinished',
      ),
      inferred: true,
    }
  }
  if (lane.lastSeenAt === null) {
    return {
      word: '—',
      disclosure: card(
        'no outcome',
        'nothing was ever recorded for this lane beyond its name',
        'no event in any readable recording carried it',
        'an empty row is the honest reading of an empty record',
      ),
      inferred: true,
    }
  }
  return {
    word: 'no outcome',
    disclosure: card(
      'no outcome',
      'the log cannot say how this ended',
      'no commit and no worktree removal was recorded',
      'the recording holds no evidence either way, and improvising one would be worse than the gap',
    ),
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

export function laneSessionsDisclosure(
  lane: Pick<LaneIndexRow, 'sessionIds' | 'missingSessionIds'>,
): DisclosureContent {
  const spanned = lane.sessionIds.length === 0 ? 'no recording holds this lane' : lane.sessionIds.join(', ')
  const unread = lane.missingSessionIds.length
  return {
    label: 'sessions',
    why: {
      reason:
        unread === 0
          ? 'the recordings this lane’s life spans'
          : `${unread} recording${unread === 1 ? '' : 's'} naming this lane could not be read`,
      evidence: {
        fact:
          unread === 0
            ? spanned
            : `${spanned} — and ${unread} this index could not read: ${lane.missingSessionIds.join(', ')}`,
        elapsedMs: 0,
      },
    },
    remedy:
      unread === 0
        ? { kind: 'none', because: 'every recording naming this lane was read — the list is complete' }
        : {
            kind: 'action',
            action: 'the unread recordings are named above; check they are present and readable in the session directory',
          },
  }
}
