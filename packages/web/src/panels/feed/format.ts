import { commitDiffStat, type CommitRecord } from '@rhizomorph/core'

/**
 * The feed's own formatting: a wall-clock time (mono, tabular — law 11) and a
 * commit's diffstat. `lib/format.ts` is the shared token/dollar formatter
 * (`#70`); it has no time-of-day formatter today, and it sits outside this
 * issue's fence, so the clock format lives here — the same per-panel-format
 * idiom `panels/ledger/format.ts` already uses for its own elapsed/relative
 * time helpers.
 */

/** `HH:MM:SS`, UTC — one shape for every entry, replay or live. */
export function formatClock(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19)
}

export function formatDiffStat(commit: CommitRecord): string {
  const stat = commitDiffStat(commit)
  return `${stat.files} file${stat.files === 1 ? '' : 's'} · +${stat.insertions} -${stat.deletions}`
}
