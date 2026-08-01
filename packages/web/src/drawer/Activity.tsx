import { formatSpan } from '../fleet/index.js'
import { activityCounts, type ActivityEntry } from './activity.js'

/**
 * THE ACTIVITY VIEW — the drawer's default reading (ruling 17).
 *
 * Quiet lines, mono data, newest first. It is a *ledger of what happened*, not
 * a feed that moves: nothing here animates, because ruling 10 spends motion on
 * events arriving in the scene and this list is history the moment it renders.
 *
 * Deliberately no filter chips. The whole list is fifteen lines of a lane's
 * recent life, and a control that hides two thirds of it is a control that
 * makes an operator ask "was that everything?" — which is the question the
 * evidence-bearing register exists to never provoke.
 */

export interface ActivityViewProps {
  entries: readonly ActivityEntry[]
  /** The clock the fleet was measured against, so ages match the vitals above. */
  now: number
}

export function ActivityView({ entries, now }: ActivityViewProps) {
  const counts = activityCounts(entries)

  return (
    <section data-testid="drawer-activity" className="min-h-0 flex-1 overflow-auto px-4 py-3">
      <header className="flex items-baseline justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-ice-400">Activity</h3>
        <p className="figures text-[10px] text-ice-500">
          {counts.tool} tools · {counts.file} files · {counts.commit} commits
        </p>
      </header>

      {entries.length === 0 ? (
        <p role="status" className="mt-2 text-[11px] text-ice-500">
          NO ACTIVITY RECORDED — this lane has produced no tool call, file change or commit in the
          session so far — its transcript below is the only thing left to read.
        </p>
      ) : (
        <ol className="mt-2 space-y-0.5">
          {entries.map((entry) => (
            <li
              key={entry.id}
              data-testid="activity-entry"
              data-kind={entry.kind}
              className="flex items-baseline gap-2 border-t border-ice-850/60 py-0.5 first:border-t-0"
            >
              <span className="figures w-10 shrink-0 text-right text-[10px] text-ice-600">
                {relative(entry.ts, now)}
              </span>
              <span className={`w-14 shrink-0 text-[10px] uppercase tracking-wider ${KIND_CLASS[entry.kind]}`}>
                {KIND_WORD[entry.kind]}
              </span>
              <span className="min-w-0 flex-1 font-mono text-[11px] leading-snug text-ice-300">
                <EntryBody entry={entry} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

const KIND_WORD = { tool: 'tool', file: 'file', commit: 'commit' } as const

/**
 * Kinds differ by lightness, never by a ladder hue (law 9): a commit is not a
 * status, and an amber commit line in a calm lane would be a lie told in
 * colour.
 */
const KIND_CLASS = {
  tool: 'text-ice-500',
  file: 'text-ice-400',
  commit: 'text-ice-200',
} as const

function EntryBody({ entry }: { entry: ActivityEntry }) {
  if (entry.kind === 'tool') {
    return (
      <>
        <span className="text-ice-200">{entry.tool}</span>
        {entry.count > 1 ? <span className="ml-1 text-ice-500">×{entry.count}</span> : null}
        {entry.thread === 'subagent' ? <span className="ml-1 text-ice-600">sub</span> : null}
      </>
    )
  }

  if (entry.kind === 'file') {
    return (
      <>
        <span className="text-ice-500">{entry.status}</span> <span className="truncate">{entry.path}</span>
      </>
    )
  }

  return (
    <>
      <span className="text-ice-500">{entry.sha.slice(0, 7)}</span> {entry.subject}
      <span className="ml-1 text-ice-600">
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
