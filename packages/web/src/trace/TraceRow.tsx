import type { SpanRecord, TraceTreeNode } from '@rhizomorph/core'
import { formatSpan } from './format.js'
import { DecisionBadge, KindTag } from './glyphs.js'

/**
 * THE ONE ROW, shared by the tree and the gantt (the brief's "same
 * rows/glyphs/badges"). What differs between the two surfaces is only how a
 * row's duration is drawn — stacked text under the name in the tree, a
 * positioned bar with the same text at its end in the gantt — never what a
 * row says. `RowLabel` is that shared "what it is" half; `RowMeta` is the
 * shared "how long, and what happened" half, placed differently by each
 * caller.
 */

/**
 * The row's own name. `llm_request` names itself by model (the fact an
 * operator actually wants at a glance); anything else names itself by the
 * tool it called, falling back to the raw span name so a `hook` or `other`
 * row — never hidden, per the brief — still says something rather than
 * nothing.
 */
export function rowName(span: SpanRecord): string {
  if (span.kind === 'llm_request' && span.model !== null) return span.model
  if (span.toolName !== null) return span.toolName
  return span.name
}

export interface RowLabelProps {
  node: TraceTreeNode
}

export function RowLabel({ node }: RowLabelProps) {
  const { span } = node
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <KindTag kind={span.kind} />
      <span className="min-w-0 truncate font-mono text-[11px] text-ice-200">{rowName(span)}</span>
      {span.kind === 'llm_request' && span.ttftMs !== null ? (
        <span className="shrink-0 text-[10px] text-ice-500">ttft {formatSpan(span.ttftMs)}</span>
      ) : null}
    </span>
  )
}

export interface RowMetaProps {
  node: TraceTreeNode
}

/**
 * `tool_blocked` reads through {@link DecisionBadge} (ruling 6's "waited",
 * never "waiting", plus the honest `unknown` state); every other kind is a
 * plain formatted duration.
 */
export function RowMeta({ node }: RowMetaProps) {
  const { span } = node
  if (span.kind === 'tool_blocked' && span.decision !== null) {
    return <DecisionBadge decision={span.decision} waitedFor={formatSpan(span.endTs - span.startTs)} />
  }
  return (
    <span data-testid="trace-duration" className="text-[10px] text-ice-500">
      {formatSpan(span.endTs - span.startTs)}
    </span>
  )
}
