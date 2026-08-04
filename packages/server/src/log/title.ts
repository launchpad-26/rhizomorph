import {
  reduceAll,
  selectMainBranch,
  selectSessionSpend,
  selectSpendByBranch,
  type RhizomorphEvent,
} from '@rhizomorph/core'

/**
 * What a session's own events say happened — never a guess. `lanes` and
 * `landed` come straight off {@link selectSpendByBranch} (one row per branch
 * git ever mentioned, `main` excluded), the same "landed" definition the
 * ledger already uses: the worktree that last carried the branch has gone
 * (`isBranchLanded` — a real `worktree.removed`, not an inference). `issues`
 * reuses that selector's own `issueOf` convention (the leading digits of a
 * fenced branch name, e.g. `144` for `144-something`), deduped and sorted
 * ascending so a title reads oldest-issue-first.
 */
export interface SessionMeta {
  lanes: number
  landed: number
  issues: string[]
  outputTokens: number
  costUsd: number
  costIsAuthoritative: boolean | null
}

export function computeSessionMeta(events: readonly RhizomorphEvent[]): SessionMeta {
  const state = reduceAll(events)
  const main = selectMainBranch(state)
  const branches = selectSpendByBranch(state).filter((entry) => entry.branch !== main)
  const landed = branches.filter((entry) => entry.landed).length
  const issues = [...new Set(branches.map((entry) => entry.issue).filter((issue): issue is string => issue !== null))]
    .sort((a, b) => Number(a) - Number(b))
  const totals = selectSessionSpend(state)

  return {
    lanes: branches.length,
    landed,
    issues,
    outputTokens: totals.tokens.output,
    costUsd: totals.costUsd,
    costIsAuthoritative: totals.costIsAuthoritative,
  }
}

/** How many issue numbers a title names before folding the rest into `+N`. */
const ISSUE_DISPLAY_CAP = 3

/**
 * `2026-08-04 · 6 lanes · 5 landed · #144 #148 #152 +2` — date first (UTC,
 * matching the replay banner's own convention, so the same recording reads
 * identically on a stranger's machine), then the dominant work, entirely
 * derived from `meta`. Never invents an issue number a lane didn't carry, and
 * never hides that more exist — `+N` names the overflow rather than
 * silently dropping it. `startedAt` is the session's own start timestamp
 * (its filename/id), not scanned from `events`, so this reads correctly even
 * when the caller only sampled the log.
 */
export function autoTitle(startedAt: number, meta: SessionMeta): string {
  const date = formatDateUtc(startedAt)
  if (meta.lanes === 0) return `${date} · no activity recorded`

  const parts = [
    `${meta.lanes} lane${meta.lanes === 1 ? '' : 's'}`,
    `${meta.landed} landed`,
  ]

  if (meta.issues.length > 0) {
    const shown = meta.issues.slice(0, ISSUE_DISPLAY_CAP).map((issue) => `#${issue}`)
    const overflow = meta.issues.length - ISSUE_DISPLAY_CAP
    parts.push(overflow > 0 ? `${shown.join(' ')} +${overflow}` : shown.join(' '))
  }

  return `${date} · ${parts.join(' · ')}`
}

function formatDateUtc(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}
