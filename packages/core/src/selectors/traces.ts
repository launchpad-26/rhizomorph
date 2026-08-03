import type { SpanDecision, SpanKind, TokenUsagePayload } from '../events/index.js'
import { ZERO_TOKENS, addTokens } from '../events/index.js'
import type { SessionState, SpanRecord } from '../state.js'
import { compareStrings } from './touches.js'

/**
 * prd9 wave A — the trees and summaries every trace surface reads. The
 * keystone (`state.traces`) stores spans whole, in observation order; nothing
 * is accumulated there, so a trace's shape, a lane's interaction history and
 * how long a lane sat waiting are all derived here, on read, exactly like the
 * money layer's own totals in `selectors/spend.ts`.
 *
 * One rule runs through every summary in this file: **sums come only from
 * `kind === 'llm_request'` spans** (prd9 ruling 4). The payload schema lets
 * `tokens` ride on any span, but only an `llm_request` span is a real model
 * request — a token smuggled onto a `tool` or `interaction` span is not
 * spend, so it is never added. And per the house token rulings, the four
 * tiers are always reported separately; nothing here ever collapses them into
 * one unlabelled total.
 */

// --- the nested tree ---------------------------------------------------------

export interface TraceTreeNode {
  span: SpanRecord
  /** This node's direct children, sorted by `startTs`. */
  children: TraceTreeNode[]
}

export interface TraceTree {
  traceId: string
  /**
   * Every span with no arrived parent, sorted by `startTs`. Usually one
   * (`claude_code.interaction`), but a span whose parent has not exported yet
   * is a root too — orphans are the normal mid-stream shape, not an error —
   * and a trace can carry more than one independent root.
   */
  roots: TraceTreeNode[]
}

/** `null` when the trace has no spans at all — a trace id the log never saw. */
export function selectTraceTree(state: SessionState, traceId: string): TraceTree | null {
  const spans = spansOfTrace(state, traceId)
  if (spans.length === 0) return null
  return { traceId, roots: buildForest(spans) }
}

function spansOfTrace(state: SessionState, traceId: string): SpanRecord[] {
  const positions = state.traces.byTrace[traceId]
  if (positions === undefined) return []
  const spans: SpanRecord[] = []
  for (const at of positions) {
    const span = state.traces.spans[at]
    if (span !== undefined) spans.push(span)
  }
  return spans
}

/**
 * Nests a trace's own spans into however many roots it actually has. A span
 * is a root when it declares no parent, or when its declared parent is not
 * among the spans passed in — which happens whenever the ancestor is still
 * open (spans export only once they END, so a child can arrive well before a
 * parent that has not finished yet). The fold's idempotence guarantees no
 * `spanId` repeats, so every span becomes exactly one node.
 */
function buildForest(spans: readonly SpanRecord[]): TraceTreeNode[] {
  const bySpanId = new Map(spans.map((span) => [span.spanId, span] as const))
  const childrenOf = new Map<string, SpanRecord[]>()
  const roots: SpanRecord[] = []

  for (const span of spans) {
    const parentId = span.parentSpanId
    if (parentId !== null && bySpanId.has(parentId)) {
      const siblings = childrenOf.get(parentId) ?? []
      siblings.push(span)
      childrenOf.set(parentId, siblings)
    } else {
      roots.push(span)
    }
  }

  const toNode = (span: SpanRecord): TraceTreeNode => ({
    span,
    children: byStartTs(childrenOf.get(span.spanId) ?? []).map(toNode),
  })

  return byStartTs(roots).map(toNode)
}

/** `startTs` ascending, `spanId` as the deterministic tiebreak. */
function byStartTs(spans: readonly SpanRecord[]): SpanRecord[] {
  return [...spans].sort((a, b) => a.startTs - b.startTs || compareStrings(a.spanId, b.spanId))
}

// --- lane interaction summaries ----------------------------------------------

export interface InteractionSummary {
  traceId: string
  /** The root span this summary is rooted at — see {@link TraceTree.roots}. */
  spanId: string
  name: string
  kind: SpanKind
  startTs: number
  endTs: number
  /** `endTs - startTs` of the root span itself. */
  wallDurationMs: number
  /** Every `llm_request` span in the subtree, subagents included. */
  llmRequestCount: number
  /** `toolName` → call count, over every `tool` span in the subtree. */
  toolCallCounts: Record<string, number>
  /** The chronologically-first `llm_request`'s own `ttftMs`; null with none in the subtree. */
  firstLlmTtftMs: number | null
  /** Four tiers, summed ONLY from `llm_request` spans in the subtree. */
  tokens: TokenUsagePayload
}

/**
 * One row per interaction root a lane has produced, newest first. "Root" is
 * exactly {@link TraceTree.roots}' definition, so a live, still-open
 * interaction shows up as however many orphaned roots have exported so far —
 * a partial summary, not a missing one.
 */
export function selectLaneInteractions(state: SessionState, lane: string): InteractionSummary[] {
  const summaries: InteractionSummary[] = []

  for (const traceId of Object.keys(state.traces.byTrace)) {
    const spans = spansOfTrace(state, traceId)
    if (!spans.some((span) => span.lane === lane)) continue

    for (const root of buildForest(spans)) {
      if (root.span.lane !== lane) continue
      summaries.push(summarise(traceId, root))
    }
  }

  return summaries.sort(
    (a, b) => b.startTs - a.startTs || compareStrings(a.spanId, b.spanId),
  )
}

function summarise(traceId: string, root: TraceTreeNode): InteractionSummary {
  const llmSpans: SpanRecord[] = []
  const toolCallCounts: Record<string, number> = {}
  let tokens: TokenUsagePayload = ZERO_TOKENS

  const walk = (node: TraceTreeNode): void => {
    const span = node.span
    if (span.kind === 'llm_request') {
      llmSpans.push(span)
      // Ruling 4: only an `llm_request` span's own tokens are real spend
      // annotation. A `tool` or `interaction` span carrying `tokens` (the
      // schema permits it) is never added.
      if (span.tokens !== null) tokens = addTokens(tokens, span.tokens)
    }
    if (span.kind === 'tool' && span.toolName !== null) {
      toolCallCounts[span.toolName] = (toolCallCounts[span.toolName] ?? 0) + 1
    }
    for (const child of node.children) walk(child)
  }
  walk(root)

  const firstLlm = llmSpans.reduce<SpanRecord | null>(
    (earliest, span) => (earliest === null || span.startTs < earliest.startTs ? span : earliest),
    null,
  )

  return {
    traceId,
    spanId: root.span.spanId,
    name: root.span.name,
    kind: root.span.kind,
    startTs: root.span.startTs,
    endTs: root.span.endTs,
    wallDurationMs: root.span.endTs - root.span.startTs,
    llmRequestCount: llmSpans.length,
    toolCallCounts,
    firstLlmTtftMs: firstLlm === null ? null : firstLlm.ttftMs,
    tokens,
  }
}

// --- waiting on human, retrospectively ---------------------------------------

export interface WaitingOnHumanFilter {
  lane?: string
}

export interface LongestWait {
  waitMs: number
  toolName: string | null
  lane: string
  traceId: string
  spanId: string
}

/**
 * How long lanes SAT waiting on a human, and what got decided — never who is
 * waiting right now. prd9 ruling 6: a span exports only once it ends, so an
 * open permission wait has no `tool_blocked` span yet and cannot appear here.
 * This selector is RETROSPECTIVE by construction, not by convention: it
 * answers "how long did we wait, in total, and what did we decide", not "is
 * anyone waiting". Live waiting is the attention strip's own signal — no
 * surface may read this selector as a stand-in for it.
 */
export interface WaitingOnHumanSummary {
  totalWaitMs: number
  waitCount: number
  decisions: Record<SpanDecision, number>
  /** Null when no `tool_blocked` span matched the filter. */
  longestWait: LongestWait | null
}

export function selectWaitingOnHuman(
  state: SessionState,
  filter: WaitingOnHumanFilter = {},
): WaitingOnHumanSummary {
  const decisions: Record<SpanDecision, number> = { accept: 0, reject: 0, unknown: 0 }
  let totalWaitMs = 0
  let waitCount = 0
  let longestWait: LongestWait | null = null

  for (const span of state.traces.spans) {
    if (span.kind !== 'tool_blocked') continue
    if (filter.lane !== undefined && span.lane !== filter.lane) continue

    const waitMs = span.endTs - span.startTs
    totalWaitMs += waitMs
    waitCount += 1
    if (span.decision !== null) decisions[span.decision] += 1

    if (longestWait === null || waitMs > longestWait.waitMs) {
      longestWait = {
        waitMs,
        toolName: span.toolName,
        lane: span.lane,
        traceId: span.traceId,
        spanId: span.spanId,
      }
    }
  }

  return { totalWaitMs, waitCount, decisions, longestWait }
}
