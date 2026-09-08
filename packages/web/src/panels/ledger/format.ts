import type { DisclosureContent } from '../../disclosure/index.js'
import type { AgentThread, SpendTotals } from '@rhizomorph/core'
import { formatTokenBreakdown, formatTokens, formatUsd } from '../../lib/format.js'

/** `null` reads as "still going" or "never happened" depending on the caller — never `0m`. */
export function formatElapsed(ms: number | null): string {
  if (ms === null) return '—'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
}

export function formatRelativeTime(ts: number | null, now: number): string {
  if (ts === null) return '—'
  const deltaMs = Math.max(0, now - ts)
  if (deltaMs < 45_000) return 'just now'
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/**
 * Dollars whenever any telemetry has priced this row, output tokens alone
 * when none ever has — the null case in {@link SpendTotals.costIsAuthoritative}
 * is "we do not know", not "it was free", so it must never render as `$0.00`.
 * The fallback is output-led, never the unlabelled all-tier `.total` (prd2's
 * ruling), and labelled `out` so it cannot be mistaken for one. Shared by
 * branch rows and their thread sub-rows: both are a {@link SpendTotals}.
 */
export function costCellText(row: SpendTotals): string {
  if (row.costIsAuthoritative === null) return `${formatTokens(row.tokens.output)} out`
  return formatUsd(row.costUsd)
}

/**
 * The `$` column's disclosure (#220). `elapsedMs: 0` throughout: a
 * {@link SpendTotals} is a running total the ledger re-folds on every tick, so
 * the reading was confirmed just now — core's own register for a
 * continuously-true fact (`selectors/condition.ts`), and not a claim that
 * nothing has been spent since.
 */
export function costCellDisclosure(row: SpendTotals): DisclosureContent {
  if (row.costIsAuthoritative === null) {
    return {
      label: '$',
      why: {
        reason: 'output tokens shown — no cost telemetry has arrived for this row yet',
        evidence: { fact: formatTokenBreakdown(row.tokens), elapsedMs: 0 },
      },
      remedy: {
        kind: 'action',
        action: "turn on the agent CLI's own cost telemetry; until then the column shows tokens rather than an invented dollar figure",
      },
    }
  }
  if (row.costIsAuthoritative === false) {
    return {
      label: '$',
      why: {
        reason: 'includes an estimate — not fully authoritative',
        evidence: { fact: `total ${formatUsd(row.costUsd)}, priced partly from a vendored table`, elapsedMs: 0 },
      },
      remedy: { kind: 'none', because: 'an estimate is the best figure this row has; the est. mark says so on the glance' },
    }
  }
  return {
    label: '$',
    why: {
      reason: 'authoritative dollar cost',
      evidence: { fact: `the agent CLI reported ${formatUsd(row.costUsd)} itself (OTel)`, elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'the figure comes from the CLI itself — there is nothing better to reach for' },
  }
}

/** The TOKENS column's disclosure: the full four-tier breakdown behind its output-led figure. */
export function tokensCellDisclosure(row: SpendTotals): DisclosureContent {
  return {
    label: 'tokens',
    why: {
      reason: 'the four-tier breakdown behind this row\'s output-led figure',
      evidence: { fact: formatTokenBreakdown(row.tokens), elapsedMs: 0 },
    },
    remedy: { kind: 'none', because: 'a token breakdown is a reading, not a condition' },
  }
}

/** `null` is the source-didn't-say bucket — rendered as its own label, never folded into `main`. */
export function threadLabel(thread: AgentThread | null): string {
  return thread ?? 'unknown'
}

/**
 * The LANDED / LIVE mark's disclosure (#220).
 *
 * `elapsedMs: 0` for the same reason every other reading in this file uses it:
 * the ledger re-folds on every tick, so "the worktree is gone" is a fact
 * confirmed just now rather than one dated to when it went.
 */
export function landedDisclosure(landed: boolean): DisclosureContent {
  return {
    label: landed ? 'landed' : 'live',
    why: {
      reason: landed ? 'this feature is finished' : 'this feature is still being worked on',
      evidence: {
        fact: landed ? 'its worktree has been removed' : 'its worktree is still present',
        elapsedMs: 0,
      },
    },
    remedy: landed
      ? { kind: 'none', because: 'a landed branch is finished work — the row is here to be read' }
      : { kind: 'none', because: 'a live lane is the ordinary state; the fleet table is where its condition is judged' },
  }
}

/** The exemplar jump's disclosure — what the button will do, and why this request is the one it jumps to. */
export function exemplarJumpDisclosure(exemplar: { tokens: number }): DisclosureContent {
  return {
    label: 'trace',
    why: {
      reason: "opens this lane's run view at its heaviest model request",
      evidence: { fact: `the heaviest llm_request folded for this lane is ${formatTokens(exemplar.tokens)} tok`, elapsedMs: 0 },
    },
    remedy: { kind: 'action', action: 'activate it to jump straight to that span in the trace' },
  }
}
