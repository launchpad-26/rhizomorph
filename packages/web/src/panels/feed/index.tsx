import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { AgentStatus, AgentStatusWitness } from '@rhizomorph/core'
import { useStream } from '../../app/StreamContext.js'
import { NEWS_GRACE_MS } from '../../app/streamState.js'
import { INFERRED_MARK, useFleet, useSelection } from '../../fleet/index.js'
import { HiddenNotice } from '../search/HiddenNotice.js'
import { filterByQuery, useSessionQuery } from '../search/session.js'
import {
  FEED_KINDS,
  FEED_KIND_LABEL,
  FEED_LIMIT,
  buildFeedEntries,
  buildLaneIndex,
  feedEntryText,
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

/**
 * THE ACTIVITY FEED (ruling 15) — one quiet, filterable feed: commits,
 * landings, lane starts and stops, collector events. The commit ticker's one
 * kind grows into these four, filterable by kind and by the keystone's one
 * lane selection.
 *
 * **The collapsed peek is gone (#552).** It existed for one reason: prd9's
 * legibility round made this the only panel that defaulted *collapsed*, and a
 * panel that defaults collapsed still has to say something rather than vanish,
 * so `PanelFrame`'s controlled-collapse mode kept it mounted to draw a
 * header-and-latest-line reading. prd-32 ruling 5 removes the premise — the
 * feed is a tab of the dock now, and **a tab is never hidden** (S3 forbids a
 * hidden empty tab outright). There is no collapsed state left for a peek to
 * be the reading of, and keeping the branch would have left a mode nothing can
 * reach. What the peek was *for* — "what just happened, at a glance, without
 * opening this" — is answered above the fold by the attention strip and the
 * scene, which is where prd-13 ruling 3 already put it.
 *
 * No frame and no heading of its own either: the dock draws the border and its
 * tab strip names this surface.
 */
export default function ActivityFeed() {
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

  /**
   * THE SESSION SEARCH (prd-31 ruling 4 / S3, #559), applied AFTER this panel's
   * own kind and lane filters and BEFORE `FEED_LIMIT`.
   *
   * The order is the whole correctness of the count. Searching after the cap
   * would search the first `FEED_LIMIT` rows and report a hidden count computed
   * from a window the reader never chose — a filtered view lying about what it
   * hid, which is the exact failure ruling 4's declaration exists to prevent.
   */
  const query = useSessionQuery()
  const search = filterByQuery(
    filterFeedEntries(allEntries, activeKinds, selectedId),
    query,
    feedEntryText,
  )
  const entries = search.shown.slice(0, FEED_LIMIT)
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
    <section className="flex h-full flex-col" data-panel="feed">
      <div className="flex flex-wrap items-center gap-3">
        <div className="ml-auto flex items-center gap-1.5" role="group" aria-label="Filter by kind">
          {FEED_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={activeKinds.has(kind)}
              data-testid={`feed-kind-${kind}`}
              onClick={() => toggleKind(kind)}
              className={`focus-ring rounded-none border px-1.5 py-0.5 heading tracking-wide ${
                activeKinds.has(kind)
                  ? 'border-(--ink-dim) text-(--ink-body)'
                  : 'border-(--line-strong) text-(--ink-dim)'
              }`}
            >
              {FEED_KIND_LABEL[kind]}
            </button>
          ))}
        </div>
      </div>

      {selectedId !== null ? (
        <div className="mt-1.5 flex items-center gap-2 text-inst text-(--ink-dim)">
          <span>
            lane <span className="figures text-(--ink-body)">{selectedId}</span>
          </span>
          <button
            type="button"
            data-testid="feed-clear-lane"
            className="focus-ring rounded-none text-(--ink-dim) hover:text-(--ink-body) hover:underline"
            onClick={clear}
          >
            clear
          </button>
        </div>
      ) : null}

      <HiddenNotice
        result={search}
        noun="events"
        query={query}
        shown={search.shown.length}
        surface="feed"
      />

      {entries.length === 0 && !connected ? (
        <p className="mt-2 text-read-body text-(--ink-dim)">Waiting for the stream…</p>
      ) : entries.length === 0 && search.filtering ? (
        // The search's own *no matches* line is already above, and it says what
        // was searched and where. A second empty state under it would be two
        // sentences for one absence.
        null
      ) : entries.length === 0 ? (
        <p className="mt-2 text-read-body text-(--ink-body)" role="status">
          {filtered ? 'Nothing matches this filter.' : 'No activity yet this session.'}
        </p>
      ) : (
        <ol className="mt-2 space-y-1.5 figures text-inst">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-testid="feed-entry"
              data-kind={entry.kind}
              className={`rounded-none px-1.5 py-(--space-row-y) leading-relaxed${entry.news ? ' feed-entry-pulse' : ''}`}
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
  return <span className="shrink-0 text-(--ink-dim)">{formatClock(ts)}</span>
}

function KindTag({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="shrink-0 rounded-none border border-(--line-strong) px-1 uppercase text-(--ink-dim)">
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
        <span key={branch} className="shrink-0 rounded-none border border-(--ink-dim) px-1 text-(--ink-body)">
          {branch}
        </span>
      ))}
      <span className="min-w-0 flex-1 truncate text-(--ink-body)">{commit.message}</span>
      <span className="shrink-0 text-(--ink-dim)">{formatDiffStat(commit)}</span>
    </div>
  )
}

function LandingRow({ entry }: { entry: LandingFeedEntry }): ReactElement {
  return (
    <div className="flex items-start gap-2">
      <Clock ts={entry.ts} />
      <KindTag>landed</KindTag>
      <span className="min-w-0 flex-1 truncate text-(--ink-body)">{entry.label}</span>
    </div>
  )
}

/**
 * Exhaustive over `AgentStatus` — the same property the witness record below
 * has, and for the same reason: a word added to `agentStatusSchema` must fail
 * here at typecheck rather than render as an empty tag. prd-57 ruling 5 widened
 * this from three words to seven, and this record is where the build said so.
 *
 * The labels are the words themselves, because the tag's job is to report what
 * was said rather than to interpret it. Declared-versus-inferred is carried by
 * the witness mark beside it and never by the wording — prd-57 ruling 3's
 * rendering law, which is the rule `evidenceLine` and the attention strip
 * already follow.
 */
const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'working',
  waiting: 'waiting',
  done: 'done',
  'tool-running': 'tool call',
  'waiting-permission': 'needs you',
  stopped: 'stopped',
  crashed: 'crashed',
}

/**
 * The tag a lane row wears (#290). A declared word is bare; an inferred one
 * wears the instrument's own inference mark, exactly as `evidenceLine` and the
 * attention strip render it — one mark, learned once. Exhaustive over
 * `AgentStatusWitness`: a third witness in `AGENT_STATUS_SOURCES` fails here
 * at typecheck rather than rendering as workmux's word.
 */
function laneTag(status: AgentStatus, witness: AgentStatusWitness): string {
  const label = AGENT_STATUS_LABEL[status]
  switch (witness) {
    case 'workmux':
      return label
    case 'sessionlog':
      return `${INFERRED_MARK} ${label}`
    default: {
      const _never: never = witness
      throw new Error(`unreachable agent.status witness: ${String(_never)}`)
    }
  }
}

function LaneRow({ entry }: { entry: LaneFeedEntry }): ReactElement {
  return (
    <div className="flex items-start gap-2" data-witness={entry.witness}>
      <Clock ts={entry.ts} />
      <KindTag>{laneTag(entry.status, entry.witness)}</KindTag>
      <span className="min-w-0 flex-1 truncate text-(--ink-body)">
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
      <span className="min-w-0 flex-1 truncate text-(--ink-body)">
        {entry.collector}
        {entry.message !== null ? ` — ${entry.message}` : ''}
      </span>
    </div>
  )
}
