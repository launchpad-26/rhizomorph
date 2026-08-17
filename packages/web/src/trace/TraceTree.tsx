import { useState } from 'react'
import type { SessionState } from '@rhizomorph/core'
import { HiddenNotice } from '../panels/search/HiddenNotice.js'
import { filterByQuery, useSessionQuery } from '../panels/search/session.js'
import { EmptyTrace } from './EmptyTrace.js'
import { formatSpan, tokenHeadline, tokenTitle } from './format.js'
import {
  flattenDescendants,
  interactionText,
  selectLaneInteractionViews,
  sumLeafDurationsMs,
} from './model.js'
import { RowLabel, RowMeta } from './TraceRow.js'

/**
 * THE TREE — the compact trace surface (langfuse study: duration-under-name,
 * wall-vs-Σ). One collapsible block per interaction, newest first; everything
 * under it is `state.traces` read through the two selectors this whole
 * directory is built on (`selectLaneInteractionViews` only zips their outputs
 * together — see `model.ts`).
 *
 * **The session search filters here rather than in either caller** (prd-31
 * ruling 4, #559). Both surfaces that render a trace — the dock's trace tab and
 * the run view's trace column — would otherwise each have to filter, and the
 * two would drift the first time one of them changed what it matched on. One
 * filter, one hidden count, in the component that owns the list.
 *
 * The ordinal is deliberately computed from the UNFILTERED list. "interaction
 * #7" is a fact about the lane's life, not about the current query, and
 * renumbering the survivors 1..n under a filter would make the same interaction
 * carry two different names depending on what was typed — which is exactly what
 * a person searching to find one again cannot afford.
 */
export interface TraceTreeProps {
  state: SessionState
  lane: string
}

export function TraceTree({ state, lane }: TraceTreeProps) {
  const all = selectLaneInteractionViews(state, lane)
  const query = useSessionQuery()
  const search = filterByQuery(all, query, interactionText)
  const views = search.shown
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = (traceId: string) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(traceId)) next.delete(traceId)
      else next.add(traceId)
      return next
    })
  }

  // The honest gap and the empty filter are different facts: "no trace
  // telemetry from this lane" is a claim about the collectors, and "none of
  // this lane's spans match what you typed" is a claim about the query. Only
  // the first is `EmptyTrace`'s to make.
  if (all.length === 0) return <EmptyTrace />

  return (
    <>
      <HiddenNotice
        result={search}
        noun="interactions"
        query={query}
        shown={views.length}
        surface="trace"
      />
      <ol data-testid="trace-tree" className="space-y-1">
      {views.map((view) => {
        const ordinal = all.length - all.indexOf(view)
        const isOpen = expanded.has(view.summary.traceId)
        const rows = flattenDescendants(view.root)

        return (
          <li key={view.summary.traceId} data-testid="trace-interaction" className="border-t border-ice-850/60 pt-1 first:border-t-0 first:pt-0">
            <button
              type="button"
              onClick={() => toggle(view.summary.traceId)}
              aria-expanded={isOpen}
              aria-label={`${isOpen ? 'Collapse' : 'Expand'} interaction ${ordinal}`}
              data-testid="trace-interaction-toggle"
              className="flex w-full items-baseline gap-2 text-left font-mono text-[11px] text-ice-200 hover:text-ice-100"
            >
              <span className="w-3 shrink-0 text-ice-400">{isOpen ? '▾' : '▸'}</span>
              <span className="min-w-0 flex-1 truncate">
                interaction #{ordinal} · {formatSpan(view.summary.wallDurationMs)} · Σ
                {formatSpan(sumLeafDurationsMs(view.root))}
                {' · '}
                <span title={tokenTitle(view.summary.tokens)}>
                  {tokenHeadline(view.summary.tokens)}
                </span>
              </span>
            </button>

            {isOpen ? (
              <ol className="mt-1 space-y-1">
                {rows.map(({ node, depth }) => (
                  <li
                    key={node.span.spanId}
                    data-testid="trace-row"
                    data-kind={node.span.kind}
                    style={{ paddingLeft: `${depth * 0.9}rem` }}
                    className="flex flex-col gap-0.5"
                  >
                    <RowLabel node={node} />
                    <RowMeta node={node} />
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        )
      })}
      </ol>
    </>
  )
}
