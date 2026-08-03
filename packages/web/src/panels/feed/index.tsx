import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { AgentStatus } from '@rhizomorph/core'
import { useStream } from '../../app/StreamContext.js'
import { NEWS_GRACE_MS } from '../../app/streamState.js'
import { useFleet, useSelection } from '../../fleet/index.js'
import {
  FEED_KINDS,
  FEED_KIND_LABEL,
  FEED_LIMIT,
  buildFeedEntries,
  buildLaneIndex,
  filterFeedEntries,
  type CollectorFeedEntry,
  type CommitFeedEntry,
  type FeedEntry,
  type FeedKind,
  type LandingFeedEntry,
  type LaneFeedEntry,
} from './feed.js'
import { formatClock, formatDiffStat } from './format.js'
import './feed.css'

export interface ActivityFeedProps {
  /**
   * Header + latest line only, no list, no filters — `PanelFrame`'s
   * controlled-collapse peek (prd9 legibility round: the feed defaults
   * collapsed, unlike every other panel, so it still has to say *something*
   * rather than vanish). Defaults open, so every stand-alone render (every
   * test in this file among them) is unaffected.
   */
  collapsed?: boolean
}

/**
 * THE ACTIVITY FEED (ruling 15) — one quiet, filterable feed: commits,
 * landings, lane starts and stops, collector events. The commit ticker's one
 * kind grows into these four, filterable by kind and by the keystone's one
 * lane selection.
 */
export default function ActivityFeed({ collapsed = false }: ActivityFeedProps = {}) {
  const { state, status } = useStream()
  const fleet = useFleet()
  const { selectedId, clear } = useSelection()
  const [activeKinds, setActiveKinds] = useState<ReadonlySet<FeedKind>>(() => new Set(FEED_KINDS))

  const laneIndex = useMemo(() => buildLaneIndex(fleet.lanes), [fleet.lanes])

  const allEntries = useMemo(
    () =>
      buildFeedEntries(state.events, state.session, laneIndex, {
        connectedAt: state.connectedAt,
        newsGraceMs: NEWS_GRACE_MS,
      }),
    [state.events, state.session, laneIndex, state.connectedAt],
  )

  /** Same signal StatusBar/ConnectionBadge read, plus proof at least one event has folded. */
  const connected = status === 'open' && state.events.length > 0

  if (collapsed) {
    // The true latest entry, unfiltered — a peek answers "what just
    // happened", not "what does the current filter show".
    const latest = allEntries[0] ?? null
    return (
      <section className="flex flex-col gap-1.5 rounded-lg border border-ice-850 bg-ice-950 p-4" data-panel="feed">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Activity</h2>
        {latest === null ? (
          <p className="text-sm text-ice-400">
            {connected ? 'No activity yet this session.' : 'Waiting for the stream…'}
          </p>
        ) : (
          <div className="figures text-xs" data-testid="feed-entry" data-kind={latest.kind}>
            <FeedRow entry={latest} />
          </div>
        )}
      </section>
    )
  }

  const entries = filterFeedEntries(allEntries, activeKinds, selectedId).slice(0, FEED_LIMIT)
  const filtered = selectedId !== null || activeKinds.size < FEED_KINDS.length

  function toggleKind(kind: FeedKind): void {
    setActiveKinds((prev) => {
      // At least one kind must stay on — an all-off feed reads as broken, not filtered.
      if (prev.has(kind) && prev.size === 1) return prev
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  return (
    <section
      className="flex h-full flex-col rounded-lg border border-ice-850 bg-ice-950 p-4"
      data-panel="feed"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-ice-400">Activity</h2>
        <div className="ml-auto flex items-center gap-1.5" role="group" aria-label="Filter by kind">
          {FEED_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={activeKinds.has(kind)}
              data-testid={`feed-kind-${kind}`}
              onClick={() => toggleKind(kind)}
              className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                activeKinds.has(kind)
                  ? 'border-ice-600 text-ice-200'
                  : 'border-ice-800 text-ice-400'
              }`}
            >
              {FEED_KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      </div>

      {selectedId !== null ? (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-ice-400">
          <span>
            lane <span className="figures text-ice-300">{selectedId}</span>
          </span>
          <button
            type="button"
            data-testid="feed-clear-lane"
            className="text-ice-400 hover:text-ice-300 hover:underline"
            onClick={clear}
          >
            clear
          </button>
        </div>
      ) : null}

      {entries.length === 0 && !connected ? (
        <p className="mt-2 text-sm text-ice-400">Waiting for the stream…</p>
      ) : entries.length === 0 ? (
        <p className="mt-2 text-sm text-ice-300" role="status">
          {filtered ? 'Nothing matches this filter.' : 'No activity yet this session.'}
        </p>
      ) : (
        <ol className="mt-2 flex-1 space-y-1.5 overflow-auto figures text-xs [scrollbar-gutter:stable]">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-testid="feed-entry"
              data-kind={entry.kind}
              className={`rounded px-1.5 py-1.5 leading-relaxed${entry.news ? ' feed-entry-pulse' : ''}`}
            >
              <FeedRow entry={entry} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function FeedRow({ entry }: { entry: FeedEntry }): ReactElement {
  switch (entry.kind) {
    case 'commit':
      return <CommitRow entry={entry} />
    case 'landing':
      return <LandingRow entry={entry} />
    case 'lane':
      return <LaneRow entry={entry} />
    case 'collector':
      return <CollectorRow entry={entry} />
  }
}

function Clock({ ts }: { ts: number }): ReactElement {
  return <span className="shrink-0 text-ice-400">{formatClock(ts)}</span>
}

function KindTag({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="shrink-0 rounded border border-ice-700 px-1 uppercase text-ice-400">
      {children}
    </span>
  )
}

function CommitRow({ entry }: { entry: CommitFeedEntry }): ReactElement {
  const { commit } = entry
  return (
    <div className="flex items-start gap-2">
      <Clock ts={entry.ts} />
      {commit.branches.map((branch) => (
        <span key={branch} className="shrink-0 rounded border border-ice-600 px-1 text-ice-200">
          {branch}
        </span>
      ))}
      <span className="min-w-0 flex-1 truncate text-ice-300">{commit.message}</span>
      <span className="shrink-0 text-ice-400">{formatDiffStat(commit)}</span>
    </div>
  )
}

function LandingRow({ entry }: { entry: LandingFeedEntry }): ReactElement {
  return (
    <div className="flex items-start gap-2">
      <Clock ts={entry.ts} />
      <KindTag>landed</KindTag>
      <span className="min-w-0 flex-1 truncate text-ice-300">{entry.label}</span>
    </div>
  )
}

const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working',
  waiting: 'waiting',
  done: 'done',
}

function LaneRow({ entry }: { entry: LaneFeedEntry }): ReactElement {
  return (
    <div className="flex items-start gap-2">
      <Clock ts={entry.ts} />
      <KindTag>{AGENT_STATUS_LABEL[entry.status]}</KindTag>
      <span className="min-w-0 flex-1 truncate text-ice-300">
        {entry.handle}
        {entry.branch !== null && entry.branch !== entry.handle ? ` · ${entry.branch}` : ''}
        {entry.detail !== null ? ` — ${entry.detail}` : ''}
      </span>
    </div>
  )
}

function CollectorRow({ entry }: { entry: CollectorFeedEntry }): ReactElement {
  return (
    <div className="flex items-start gap-2">
      <Clock ts={entry.ts} />
      <KindTag>{entry.state}</KindTag>
      <span className="min-w-0 flex-1 truncate text-ice-300">
        {entry.collector}
        {entry.message !== null ? ` — ${entry.message}` : ''}
      </span>
    </div>
  )
}
