import {
  selectLaneInteractions,
  selectTraceTree,
  type InteractionSummary,
  type SessionState,
  type TraceTreeNode,
} from '@rhizomorph/core'

/**
 * prd9 B1a — the thin zip between the two core selectors both trace surfaces
 * need: {@link selectLaneInteractions}'s newest-first summaries carry a
 * `traceId`/`spanId` but not the span's own children, and
 * {@link selectTraceTree} answers a whole trace's forest but not "which root
 * is this lane's". Nothing here counts a token, sums a duration or walks a
 * wait — that is still exactly the core selectors' job — this only looks each
 * summary's root back up in its own trace so a component has both halves at
 * once.
 */

export interface InteractionView {
  summary: InteractionSummary
  root: TraceTreeNode
}

/**
 * Every interaction root a lane has produced, newest first, each paired with
 * its own span tree. A summary whose root cannot be found (the tree selector
 * disagreeing with the interaction selector) is dropped rather than thrown —
 * it would mean the two selectors' own invariants had already broken, which is
 * a core bug, not something a component can repair by guessing.
 */
export function selectLaneInteractionViews(state: SessionState, lane: string): InteractionView[] {
  const views: InteractionView[] = []
  for (const summary of selectLaneInteractions(state, lane)) {
    const tree = selectTraceTree(state, summary.traceId)
    const root = tree?.roots.find((node) => node.span.spanId === summary.spanId)
    if (root !== undefined) views.push({ summary, root })
  }
  return views
}

/**
 * "Σ" in the root row: how much of the tree is real, non-overlapping work.
 * Only leaves are summed — a container span (`tool`, `interaction`) encloses
 * its own children in time, so adding its duration on top of theirs would
 * double-count the same milliseconds twice. Comparing this against the root's
 * own wall duration is the wall-vs-Σ read the langfuse study called out: close
 * together means the tree ran mostly single-file, far apart means real
 * concurrency or gaps.
 */
export function sumLeafDurationsMs(node: TraceTreeNode): number {
  if (node.children.length === 0) return node.span.endTs - node.span.startTs
  return node.children.reduce((sum, child) => sum + sumLeafDurationsMs(child), 0)
}

export interface TraceRowView {
  node: TraceTreeNode
  /** 1 for a root's direct children, incrementing per generation — the tree's own indent. */
  depth: number
}

/**
 * Every descendant of `root`, depth-first and already in the selector's own
 * `startTs` order, flattened with an indent depth attached. The root itself is
 * never included — both surfaces render it separately, in the row format the
 * root alone carries (wall vs Σ, the interaction's own token sum).
 */
export function flattenDescendants(root: TraceTreeNode, depth = 1): TraceRowView[] {
  const rows: TraceRowView[] = []
  for (const child of root.children) {
    rows.push({ node: child, depth })
    rows.push(...flattenDescendants(child, depth + 1))
  }
  return rows
}
