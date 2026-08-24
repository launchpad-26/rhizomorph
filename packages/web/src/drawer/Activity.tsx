import { useEffect, useRef } from 'react'
import { formatSpan } from '../fleet/index.js'
import { KIND_APPEARANCE, kindTagClass, type WorkKind } from '../theme/kind.js'
import { activityCounts, type ActivityEntry, type ActivityKind } from './foldActivity.js'

/**
 * THE ACTIVITY VIEW — the lane's audit trail (ruling 17).
 *
 * The git/file/commit record of what a lane actually did to the repo, which the
 * conversation itself cannot prove. Every entry stays reachable; none of them is
 * hidden behind a fold or a filter.
 *
 * Quiet lines, mono data, newest first. It is a *ledger of what happened*, not
 * a feed that moves: nothing here animates, because ruling 10 spends motion on
 * events arriving in the scene and this list is history the moment it renders.
 *
 * Deliberately no filter chips (still true post-#163): a control that hides
 * part of the ledger is a control that makes an operator ask "was that
 * everything?" — which is the question the evidence-bearing register exists to
 * never provoke. `highlightPath` below does not filter anything; it scrolls to
 * and marks one entry among the rest, all of which stay exactly as reachable.
 *
 * **Two layouts, one component (#163).** `fill` is what the drawer's own
 * ACTIVITY tab passes: no self max-height, because the tab body is now the
 * drawer's one scroll region and this fills all of it, header pinned above a
 * `flex-1 overflow-y-auto` list — the same pattern `Conversation` already
 * proved. Without `fill` (the default), this is the bounded strip `LanePage`
 * still lays it out as, unchanged, since that page is outside this issue's
 * fence and keeps its own multi-section grid.
 */

export interface ActivityViewProps {
  entries: readonly ActivityEntry[]
  /** The clock the fleet was measured against, so ages match the vitals above. */
  now: number
  /** True inside the drawer's own ACTIVITY tab — fills the tab body instead of a bounded strip. */
  fill?: boolean
  /** The file path WHY's "activity ↗" jump landed on (#163) — scrolled to and marked, never filtered to. */
  highlightPath?: string | null
}

export function ActivityView({ entries, now, fill = false, highlightPath = null }: ActivityViewProps) {
  const counts = activityCounts(entries)
  const itemRefs = useRef(new Map<string, HTMLLIElement>())

  useEffect(() => {
    if (highlightPath === null) return
    const match = entries.find((entry) => entry.kind === 'file' && entry.path === highlightPath)
    if (match === undefined) return
    // jsdom carries no `scrollIntoView` at all (no layout engine) — the
    // optional call is real defensive code, not a test-only workaround.
    itemRefs.current.get(match.id)?.scrollIntoView?.({ block: 'center' })
  }, [highlightPath, entries])

  const header = (
    <>
      <h3 className="text-inst-dense font-semibold uppercase tracking-[0.2em] text-(--ink-dim)">Activity</h3>
      <p className="figures text-inst-dense text-(--ink-dim)">
        {counts.tool} tools · {counts.file} files · {counts.commit} commits
      </p>
    </>
  )

  const body =
    entries.length === 0 ? (
      <p role="status" className="mt-2 text-inst text-(--ink-dim)">
        NO ACTIVITY RECORDED — this lane has produced no tool call, file change or commit in the
        session so far — the conversation is the only thing left to read.
      </p>
    ) : (
      <ol className="mt-2 space-y-0.5">
        {entries.map((entry) => {
          const highlighted = entry.kind === 'file' && entry.path === highlightPath
          return (
            <li
              key={entry.id}
              ref={(el) => {
                if (el) itemRefs.current.set(entry.id, el)
                else itemRefs.current.delete(entry.id)
              }}
              data-testid="activity-entry"
              data-kind={entry.kind}
              data-highlighted={highlighted}
              className={`flex items-baseline gap-2 border-t border-(--line-hair) py-1 first:border-t-0 ${
                highlighted ? '-mx-1 rounded-none bg-(--surface-raised) px-1' : ''
              }`}
            >
              <span className="figures w-10 shrink-0 text-right text-inst-dense text-(--ink-dim)">
                {relative(entry.ts, now)}
              </span>
              <span className={kindTagClass(ACTIVITY_KIND[entry.kind])}>
                {KIND_APPEARANCE[ACTIVITY_KIND[entry.kind]].word}
              </span>
              <span className="min-w-0 flex-1 font-mono text-inst leading-relaxed text-(--ink-body)">
                <EntryBody entry={entry} />
              </span>
            </li>
          )
        })}
      </ol>
    )

  if (fill) {
    return (
      <section data-testid="drawer-activity" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex items-baseline justify-between px-4 pb-1 pt-2">{header}</header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 [scrollbar-gutter:stable]">{body}</div>
      </section>
    )
  }

  return (
    <section
      data-testid="drawer-activity"
      className="max-h-52 shrink-0 overflow-auto border-t border-(--line-hair) px-4 py-3 [scrollbar-gutter:stable]"
    >
      <header className="flex items-baseline justify-between">{header}</header>
      {body}
    </section>
  )
}

/**
 * Which of the app's kinds a ledger entry is. Vocabulary, not appearance: what
 * the tag *looks like* is `theme/kind.ts`'s single table (prd-31 ruling 1), and
 * the law it states is the one this file used to state for itself — a commit is
 * not a status, and an amber commit line in a calm lane would be a lie told in
 * colour. The ledger and the trace disagreed about `tool` for as long as they
 * each kept their own copy; they cannot now.
 */
const ACTIVITY_KIND: Record<ActivityKind, WorkKind> = {
  tool: 'tool',
  file: 'file',
  commit: 'commit',
}

function EntryBody({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === 'tool') {
    return (
      <>
        <span className="text-(--ink-body)">{entry.tool}</span>
        {entry.count > 1 ? <span className="ml-1 text-(--ink-dim)">×{entry.count}</span> : null}
        {entry.thread === 'subagent' ? <span className="ml-1 text-(--ink-dim)">sub</span> : null}
      </>
    )
  }

  if (entry.kind === 'file') {
    return (
      <>
        <span className="text-(--ink-dim)">{entry.status}</span> <span className="truncate">{entry.path}</span>
      </>
    )
  }

  return (
    <>
      <span className="text-(--ink-dim)">{entry.sha.slice(0, 7)}</span> {entry.subject}
      <span className="ml-1 text-(--ink-dim)">
        {entry.fileCount} file{entry.fileCount === 1 ? '' : 's'}
        {entry.insertions === null ? '' : ` +${entry.insertions}`}
        {entry.deletions === null ? '' : ` −${entry.deletions}`}
      </span>
    </>
  )
}

/** `2m` ago. Clamped at zero: an event from the future is a clock bug, not a negative age. */
function relative(ts: number, now: number): string {
  return formatSpan(Math.max(0, now - ts))
}
