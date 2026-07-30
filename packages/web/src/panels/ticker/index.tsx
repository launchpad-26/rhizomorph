import { useMemo } from 'react'
import {
  commitDiffStat,
  isEventOfType,
  reduceAll,
  selectRecentCommits,
  type AgentStatus,
  type CommitRecord,
} from '@observatory/core'
import { useStream } from '../../app/StreamContext.js'
import './ticker.css'

/** How many entries the unified feed keeps on screen, newest first. */
const FEED_LIMIT = 30

interface CommitFeedEntry {
  kind: 'commit'
  id: string
  ts: number
  commit: CommitRecord
}

interface AgentFeedEntry {
  kind: 'agent'
  id: string
  ts: number
  handle: string
  status: AgentStatus
  branch: string | null
  detail: string | null
}

type FeedEntry = CommitFeedEntry | AgentFeedEntry

const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working',
  waiting: 'waiting',
  done: 'done',
}

const AGENT_STATUS_CLASS: Record<AgentStatus, string> = {
  working: 'border-neon-cyan/50 text-neon-cyan',
  waiting: 'border-neon-amber/50 text-neon-amber',
  done: 'border-slate-500/50 text-slate-400',
}

function formatClock(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19)
}

function formatDiffStat(commit: CommitRecord): string {
  const stat = commitDiffStat(commit)
  return `${stat.files} file${stat.files === 1 ? '' : 's'} · +${stat.insertions} -${stat.deletions}`
}

export default function TickerPanel() {
  const { state } = useStream()

  const commits = useMemo(() => {
    const session = reduceAll(state.events)
    return selectRecentCommits(session, FEED_LIMIT)
  }, [state.events])

  const agentEntries = useMemo<AgentFeedEntry[]>(
    () =>
      state.events.filter((event) => isEventOfType(event, 'agent.status')).map((event) => ({
        kind: 'agent',
        id: event.id,
        ts: event.ts,
        handle: event.payload.handle,
        status: event.payload.status,
        branch: event.payload.branch ?? null,
        detail: event.payload.detail ?? null,
      })),
    [state.events],
  )

  const feed = useMemo<FeedEntry[]>(() => {
    const commitEntries: CommitFeedEntry[] = commits.map((commit) => ({
      kind: 'commit',
      id: `commit-${commit.sha}`,
      ts: commit.landedAt,
      commit,
    }))
    return [...commitEntries, ...agentEntries].sort((a, b) => b.ts - a.ts).slice(0, FEED_LIMIT)
  }, [commits, agentEntries])

  return (
    <section className="flex h-full flex-col rounded-lg border border-void-line bg-void-raised p-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-neon-amber">
        Commit ticker
      </h2>
      {feed.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Waiting for data…</p>
      ) : (
        <ol className="mt-2 flex-1 space-y-1.5 overflow-auto font-mono text-xs">
          {feed.map((entry) => (
            <li
              key={entry.id}
              data-testid="ticker-entry"
              className="ticker-entry-pulse rounded px-1.5 py-1"
            >
              {entry.kind === 'commit' ? (
                <CommitEntry entry={entry} />
              ) : (
                <AgentEntry entry={entry} />
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function CommitEntry({ entry }: { entry: CommitFeedEntry }) {
  const { commit } = entry
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 text-slate-600">{formatClock(entry.ts)}</span>
      {commit.branches.map((branch) => (
        <span
          key={branch}
          className="shrink-0 rounded border border-neon-cyan/50 px-1 text-neon-cyan"
        >
          {branch}
        </span>
      ))}
      <span className="min-w-0 flex-1 truncate text-slate-200">{commit.message}</span>
      <span className="shrink-0 text-slate-500">{formatDiffStat(commit)}</span>
    </div>
  )
}

function AgentEntry({ entry }: { entry: AgentFeedEntry }) {
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 text-slate-600">{formatClock(entry.ts)}</span>
      <span
        className={`shrink-0 rounded border px-1 uppercase ${AGENT_STATUS_CLASS[entry.status]}`}
      >
        {AGENT_STATUS_LABEL[entry.status]}
      </span>
      <span className="min-w-0 flex-1 truncate text-slate-300">
        {entry.handle}
        {entry.branch !== null && entry.branch !== entry.handle ? ` · ${entry.branch}` : ''}
        {entry.detail !== null ? ` — ${entry.detail}` : ''}
      </span>
    </div>
  )
}
