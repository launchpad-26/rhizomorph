import { useEffect, useMemo, useState } from 'react'
import {
  compareStrings,
  reduceAll,
  selectSpendByWorktree,
  selectWorktreeLiveness,
  selectWorktreeViews,
  type LivenessStatus,
  type WorktreeSpend,
} from '@observatory/core'
import { useStream } from '../../app/StreamContext.js'
import { formatTokens, formatUsd } from './format.js'

export interface WorktreesPanelProps {
  /** Test-only override so render tests don't depend on the wall clock. */
  now?: number
}

/** Active first, flatlined and closed stations sink to the bottom. */
const STATUS_RANK: Record<LivenessStatus, number> = {
  active: 0,
  idle: 1,
  unknown: 2,
  flatline: 3,
  closed: 4,
}

const STATUS_DOT_CLASS: Record<LivenessStatus, string> = {
  active: 'bg-neon-cyan glow-cyan',
  idle: 'bg-neon-amber',
  flatline: 'bg-neon-magenta opacity-30',
  closed: 'bg-slate-600 opacity-40',
  unknown: 'bg-slate-600 opacity-40',
}

/** Re-ticks the clock so a pane dims toward flatline even with no new events. */
function useNow(override?: number): number {
  const [now, setNow] = useState(() => override ?? Date.now())

  useEffect(() => {
    if (override !== undefined) return
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [override])

  return override ?? now
}

function formatRelativeTime(ts: number | null, now: number): string {
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
 * Dollars only once they are authoritative (OTel's own `cost_usd`); an estimate
 * or no cost telemetry at all falls back to the raw token count, which is
 * always a measured fact rather than a number this table had to trust.
 */
function costCellText(entry: WorktreeSpend | undefined): string {
  if (entry === undefined) return '—'
  if (entry.costIsAuthoritative === true) return formatUsd(entry.costUsd)
  return formatTokens(entry.tokens.total)
}

function costCellTitle(entry: WorktreeSpend | undefined): string {
  if (entry === undefined) return 'no telemetry for this worktree'
  if (entry.costIsAuthoritative === true) return 'authoritative dollar cost (OTel)'
  if (entry.costIsAuthoritative === false) {
    return `tokens shown — cost is an estimate, not authoritative (≈${formatUsd(entry.costUsd)})`
  }
  return 'tokens shown — no cost telemetry yet'
}

/** One row per worktree path, the model with the most tokens spent under it. */
function selectDominantModelByWorktree(
  usage: ReadonlyArray<{ worktreePath: string | null; model: string; totalTokens: number }>,
): Record<string, string> {
  const totals = new Map<string, Map<string, number>>()
  for (const record of usage) {
    if (record.worktreePath === null) continue
    const perModel = totals.get(record.worktreePath) ?? new Map<string, number>()
    perModel.set(record.model, (perModel.get(record.model) ?? 0) + record.totalTokens)
    totals.set(record.worktreePath, perModel)
  }

  const result: Record<string, string> = {}
  for (const [path, perModel] of totals) {
    const ranked = [...perModel.entries()].sort(
      (a, b) => b[1] - a[1] || compareStrings(a[0], b[0]),
    )
    const dominant = ranked[0]
    if (dominant !== undefined) result[path] = dominant[0]
  }
  return result
}

export default function WorktreesPanel({ now: nowOverride }: WorktreesPanelProps = {}) {
  const { state, status } = useStream()
  const now = useNow(nowOverride)
  const session = useMemo(() => reduceAll(state.events), [state.events])
  const liveness = useMemo(() => selectWorktreeLiveness(session, { now }), [session, now])
  const spendByWorktree = useMemo(() => selectSpendByWorktree(session), [session])
  const dominantModelByWorktree = useMemo(
    () => selectDominantModelByWorktree(session.telemetry.usage),
    [session],
  )

  const rows = useMemo(() => {
    const views = selectWorktreeViews(session)
    return [...views].sort((a, b) => {
      const rankDiff =
        STATUS_RANK[liveness[a.path]?.status ?? 'unknown'] -
        STATUS_RANK[liveness[b.path]?.status ?? 'unknown']
      if (rankDiff !== 0) return rankDiff
      return Number(b.isMain) - Number(a.isMain) || compareStrings(a.name, b.name)
    })
  }, [session, liveness])

  /** Same signal ConnectionBadge/StatusBar read, plus proof at least one event has folded. */
  const connected = status === 'open' && state.events.length > 0

  return (
    <section className="flex h-full flex-col rounded-lg border border-void-line bg-void-raised p-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-neon-cyan">Worktrees</h2>
      {rows.length === 0 && !connected ? (
        <p className="mt-2 text-sm text-slate-500">Waiting for the stream…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-300" role="status">
          No worktrees discovered yet.
        </p>
      ) : (
        <div className="mt-2 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                <th className="pb-1 pr-2 font-medium">Branch</th>
                <th className="pb-1 pr-2 font-medium">Agent</th>
                <th className="pb-1 pr-2 font-medium">Live</th>
                <th className="pb-1 pr-2 font-medium">Last activity</th>
                <th className="pb-1 pr-2 font-medium">Ahead</th>
                <th className="pb-1 pr-2 font-medium">Files</th>
                <th className="pb-1 pr-2 font-medium">Cost</th>
                <th className="pb-1 font-medium">Model</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = liveness[row.path]?.status ?? 'unknown'
                const spend = spendByWorktree[row.path]
                const dominantModel = dominantModelByWorktree[row.path] ?? null
                return (
                  <tr key={row.path} className="border-t border-void-line/60">
                    <td className="py-1.5 pr-2 font-mono text-slate-200">
                      {row.branch ?? '(detached)'}
                      {row.isMain ? (
                        <span className="ml-1 text-[10px] text-slate-500">main</span>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-2 text-slate-400">{row.agent?.status ?? '—'}</td>
                    <td className="py-1.5 pr-2">
                      <span
                        role="status"
                        aria-label={`liveness: ${status}`}
                        title={status}
                        className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT_CLASS[status]}`}
                      />
                    </td>
                    <td className="py-1.5 pr-2 text-slate-400">
                      {formatRelativeTime(row.lastActivityTs, now)}
                    </td>
                    <td className="py-1.5 pr-2 text-slate-200">{row.aheadOfMain}</td>
                    <td className="py-1.5 pr-2 text-slate-200">{row.filesTouched.length}</td>
                    <td
                      className="py-1.5 pr-2 font-mono text-slate-200"
                      title={costCellTitle(spend)}
                    >
                      {costCellText(spend)}
                    </td>
                    <td className="py-1.5 text-slate-400">
                      {dominantModel === null ? (
                        '—'
                      ) : (
                        <span className="rounded border border-void-line px-1 text-[10px] uppercase tracking-wide text-neon-cyan">
                          {dominantModel}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
