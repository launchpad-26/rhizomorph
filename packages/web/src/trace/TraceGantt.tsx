import type { SessionState, TraceTreeNode } from '@rhizomorph/core'
import { EmptyTrace } from './EmptyTrace.js'
import { formatSpan } from './format.js'
import { flattenDescendants, selectLaneInteractionViews } from './model.js'
import { RowLabel, RowMeta } from './TraceRow.js'

/**
 * THE GANTT — the full-width surface FOCUS TRACE opens into. Same rows, same
 * glyphs, same badges as the tree (`TraceRow.tsx`); the only thing that
 * changes is how a duration is drawn — a positioned bar with its label at the
 * bar's own end (langfuse study), rather than stacked text under the name.
 *
 * One interaction at a time — the newest, since a lane's gantt is reached by
 * focusing from the drawer's own current view of that lane, not by paging
 * through history (the tree already does newest-first paging, on the same
 * data). DOM bars, not canvas: this is a handful of rows, not a scene.
 */
export interface TraceGanttProps {
  state: SessionState
  lane: string
}

/** Milliseconds per pixel of track width. Long traces scroll; short ones don't. */
const MS_PER_PX = 12
const MIN_BAR_PX = 3
const LABEL_GUTTER_PX = 8

export function TraceGantt({ state, lane }: TraceGanttProps) {
  const [latest] = selectLaneInteractionViews(state, lane)
  if (latest === undefined) return <EmptyTrace />

  const originTs = latest.root.span.startTs
  const totalMs = Math.max(1, latest.root.span.endTs - originTs)
  const trackWidthPx = totalMs / MS_PER_PX + 160

  const rows: { node: TraceTreeNode; depth: number }[] = [
    { node: latest.root, depth: 0 },
    ...flattenDescendants(latest.root),
  ]

  return (
    <div data-testid="trace-gantt" className="overflow-x-auto rounded border border-ice-850 bg-ice-1000">
      <div className="flex items-baseline justify-between px-2 py-1 text-[10px] text-ice-600" style={{ minWidth: `${trackWidthPx}px` }}>
        <span>0s</span>
        <span>{formatSpan(totalMs)}</span>
      </div>
      <div style={{ minWidth: `${trackWidthPx}px` }}>
        {rows.map(({ node, depth }) => {
          const left = (node.span.startTs - originTs) / MS_PER_PX
          const width = Math.max(MIN_BAR_PX, (node.span.endTs - node.span.startTs) / MS_PER_PX)

          return (
            <div
              key={node.span.spanId}
              data-testid="trace-gantt-row"
              data-kind={node.span.kind}
              className="flex items-center gap-2 border-t border-ice-850/60 px-2 py-1 first:border-t-0"
            >
              <div
                className="sticky left-0 z-10 w-44 shrink-0 bg-ice-1000 pr-2"
                style={{ paddingLeft: `${depth * 0.9}rem` }}
              >
                <RowLabel node={node} />
              </div>
              <div className="relative h-3 flex-1">
                <div
                  className="absolute inset-y-0 rounded-sm bg-ice-700"
                  style={{ marginLeft: `${left}px`, width: `${width}px` }}
                />
                <div
                  className="absolute inset-y-0 flex items-center whitespace-nowrap"
                  style={{ marginLeft: `${left + width + LABEL_GUTTER_PX}px` }}
                >
                  <RowMeta node={node} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
