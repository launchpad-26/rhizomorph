import {
  selectLaneInteractions,
  selectTraceTree,
  type SessionState,
  type SpanDecision,
  type SpanRecord,
  type TokenUsagePayload,
  type TraceTreeNode,
} from '@rhizomorph/core'
import type { DisclosureContent } from '../disclosure/index.js'
import type { TranscriptEntry } from '../drawer/useTranscript.js'

/**
 * THE INTERACTION CARD, as data (prd-31 ruling 6 and S1 · #556).
 *
 * One prompt→response cycle with its tool tree, reduced to exactly the facts
 * this instrument can source — and to nothing else. The rendering
 * ({@link InteractionCard}) draws this and computes no number of its own, so
 * every clause below is checkable in a plain test with no renderer.
 *
 * **Time is the headline, and work is Σ LEAF spans.** Wall is the interaction
 * root's own `endTs - startTs`; work is the sum of every *leaf* span's
 * duration. Never a container: a container encloses its children, so adding it
 * counts the same milliseconds twice and can make work exceed wall — the exact
 * defect S1 names, and the one `model.test.ts` rigs. The gap between the two is
 * the most interesting fact the instrument holds (thinking, rate-limiting, or
 * blocked on a human) and no other surface exposes it.
 *
 * **The words are QUOTED, never written.** {@link InteractionQuote} carries the
 * agent's own opening sentence verbatim plus the whole block behind it. The
 * instrument makes no model calls (prd-9 ruling 9; ADR-0009), so a summary is
 * not available to it and inventing one would be the confident lie every
 * honesty law in this repo exists to prevent. `no-model-call-law.test.ts` holds
 * this whole directory to it — the law is a grep, not a promise.
 *
 * **A fact we cannot source does not appear.** Skills loaded, context
 * percentage and check state have no feed here, so there is no field for them
 * on any type in this file: an omitted field is honest, a blank one implies we
 * looked. Cost is the one fact with three legible answers rather than two —
 * authoritative, estimated, or an honest gap ({@link InteractionCost}) — because
 * a dollar without its provenance is worse than no dollar at all.
 */

/** The four derived phases (ruling 7). Inferred from evidence, never declared by the agent. */
export type WorkPhase = 'exploring' | 'implementing' | 'verifying' | 'landing' | 'unknown'

/**
 * Which tools count as evidence of which phase, in the order a phase outranks
 * the one before it. Landing beats verifying beats implementing beats
 * exploring: an interaction that read a file, edited it, ran the suite and
 * committed was, on balance, landing — and the card shows the evidence behind
 * that word one disclosure away rather than asking the reader to trust it.
 */
const PHASE_TOOLS: readonly { phase: Exclude<WorkPhase, 'unknown'>; tools: readonly string[] }[] = [
  { phase: 'exploring', tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead'] },
  { phase: 'implementing', tools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] },
  { phase: 'verifying', tools: ['Bash'] },
]

/** The agent's own words. Both fields are verbatim slices of one text block — nothing here rewrites. */
export interface InteractionQuote {
  /** The opening sentence, as the card's headline. A cut, never a paraphrase. */
  headline: string
  /** The whole block the headline was cut from. Equal to `headline` when it was one sentence. */
  full: string
  /** True when `full` says more than `headline` — what `▸ full text` exists for. */
  hasMore: boolean
}

/**
 * Dollars, with their provenance, or the honest gap. Three arms rather than a
 * nullable number: `est.` is a fact about the figure and travels with it, and
 * "no cost feed reached this interaction" is a different claim from `$0.00`.
 */
export type InteractionCost =
  | { kind: 'authoritative'; usd: number }
  | { kind: 'estimated'; usd: number; sources: string[] }
  | { kind: 'gap'; disclosure: DisclosureContent }

/** One subagent's line inside its parent — its type, its duration, its spend (ruling 7). */
export interface InteractionSubagent {
  agentId: string
  subagentType: string | null
  spanCount: number
  durationMs: number
  tokens: TokenUsagePayload
}

/**
 * A tool call that stopped on a human, and what got decided. First-class
 * (ruling 7): a rejected or blocked call is often the entire explanation for a
 * lane that went quiet, and nothing else in the instrument surfaces it.
 * Retrospective-exact — a span exports only once it has ended, so this never
 * claims anyone is waiting now.
 */
export interface InteractionRefusal {
  spanId: string
  toolName: string | null
  decision: SpanDecision
  waitMs: number
}

/** Everything the facts strip may show. Every field here has a named source in S1. */
export interface InteractionFacts {
  /** From the `llm_request` spans. Null when none of them named one. */
  model: string | null
  /** Σ `llm_request` span tokens — annotation, never spend (prd9 ruling 4). */
  tokens: TokenUsagePayload
  /** `tool` spans in the subtree. */
  toolCount: number
  /** Files this interaction's own tool calls touched, joined by `toolUseId`. */
  files: string[]
  cost: InteractionCost
}

export interface InteractionPhase {
  phase: WorkPhase
  /** Always true. Present as a field so no surface can render the word without it. */
  inferred: true
  /** What the inference rests on, in the disclosure card's own shape. */
  disclosure: DisclosureContent
}

export interface InteractionCardModel {
  traceId: string
  /** The root span this card is rooted at. */
  spanId: string
  lane: string
  startTs: number
  endTs: number
  /**
   * True when the interaction's own root span has not exported yet — spans
   * export on END, so what is here is however many orphaned children have
   * landed. The card says so and shows no total, rather than a number that
   * will change (S1's *in flight* state).
   */
  inFlight: boolean
  /** Root span `endTs - startTs`. */
  wallMs: number
  /** Σ leaf span durations. Never containers. */
  workMs: number
  /** `wallMs - workMs`, floored at zero. */
  gapMs: number
  /** Why the two differ, for `▸ why the gap`. */
  gapDisclosure: DisclosureContent
  /** The agent's own opening words, or null for a pure tool turn — absent, never blank. */
  quote: InteractionQuote | null
  facts: InteractionFacts
  phase: InteractionPhase
  subagents: InteractionSubagent[]
  refusals: InteractionRefusal[]
}

export interface BuildInteractionOptions {
  /**
   * The reader's own position in time — now when live, the playhead in replay.
   * Every elapsed figure on a disclosure is measured against this and nothing
   * reads a clock (`disclosure/`'s own law, which this file honours by passing
   * the number through rather than calling `Date.now`).
   */
  now: number
  /** The lane's conversation, for the quote. Absent transcript = absent quote, never an invented one. */
  entries?: readonly TranscriptEntry[]
}

// ── the tree walk ────────────────────────────────────────────────────────────

function flatten(node: TraceTreeNode, into: SpanRecord[] = []): SpanRecord[] {
  into.push(node.span)
  for (const child of node.children) flatten(child, into)
  return into
}

/**
 * Every span in the subtree that has no children — the only spans whose
 * durations may be added. A container's own duration is its children's, so
 * adding it double-counts; that is the whole of prd-31's *work* definition and
 * the reason this function exists instead of a `reduce` over `flatten`.
 */
function leaves(node: TraceTreeNode, into: SpanRecord[] = []): SpanRecord[] {
  if (node.children.length === 0) {
    into.push(node.span)
    return into
  }
  for (const child of node.children) leaves(child, into)
  return into
}

export function sumLeafDurations(root: TraceTreeNode): number {
  return leaves(root).reduce((total, span) => total + Math.max(0, span.endTs - span.startTs), 0)
}

// ── the quote ────────────────────────────────────────────────────────────────

/** Sentence enders, plus a paragraph break — the boundaries a first sentence can end at. */
const SENTENCE_END = /([.!?])(\s|$)|\n/

/**
 * The opening sentence of a block, as a **slice** of it. Deliberately not a
 * summariser and structurally incapable of becoming one: it returns
 * `text.slice(0, n)`, so every character it hands back is a character the agent
 * wrote, in the order they wrote it.
 */
export function firstSentence(text: string): string {
  const match = SENTENCE_END.exec(text)
  if (match === null) return text
  const end = match.index + (match[1] === undefined ? 0 : 1)
  return text.slice(0, end).trimEnd()
}

/**
 * The first assistant text block inside this interaction's own window, verbatim.
 *
 * Matched by TIME, which is the only join the two sources share: a transcript
 * line carries the CLI's own ISO timestamp and a span carries epoch millis, and
 * nothing in either names the other. A turn outside `[startTs, endTs]` is
 * therefore not this interaction's, and a lane whose transcript is unreadable
 * simply has no quote — the card renders without a quote line rather than with
 * an empty one (S1's *no text* state, arrived at the same way as a pure tool
 * turn, which is correct: in both cases the instrument has no words to show).
 */
export function quoteFor(
  entries: readonly TranscriptEntry[],
  startTs: number,
  endTs: number,
): InteractionQuote | null {
  for (const entry of entries) {
    if (entry.role !== 'assistant') continue
    if (entry.ts === undefined) continue
    const ts = Date.parse(entry.ts)
    if (!Number.isFinite(ts) || ts < startTs || ts > endTs) continue
    for (const block of entry.blocks) {
      if (block.kind !== 'text') continue
      const full = block.text.trim()
      if (full.length === 0) continue
      const headline = firstSentence(full)
      return { headline, full, hasMore: headline.length < full.length }
    }
  }
  return null
}

// ── cost, with its provenance ────────────────────────────────────────────────

/**
 * The dollars for one interaction, joined to it by `requestId` — the documented
 * key from an `llm_request` span to a spend record (`SpanRecord.requestId`: "the
 * JOIN key to a spend record, never a source of one"). No request id, or no cost
 * record carrying it, is an honest gap: the lane's session total says nothing
 * about which interaction spent what, and apportioning it would be an invention.
 */
export function costFor(
  state: SessionState,
  requestIds: ReadonlySet<string>,
  lane: string,
  now: number,
  lastTs: number,
): InteractionCost {
  const matched = state.telemetry.costs.filter(
    (record) => record.requestId !== null && requestIds.has(record.requestId),
  )

  if (matched.length === 0) {
    return {
      kind: 'gap',
      disclosure: {
        label: 'cost',
        why: {
          reason: 'no dollars can be attributed to this interaction',
          evidence: {
            fact:
              requestIds.size === 0
                ? `no model request in "${lane}" carried a request id, so nothing joins a cost to it — last span`
                : `no cost record names any of this interaction's ${requestIds.size} request id(s) — last span`,
            elapsedMs: Math.max(0, now - lastTs),
          },
        },
        remedy: {
          kind: 'none',
          because:
            'the lane total cannot be split across interactions without inventing an apportionment — the figure is missing, not zero',
        },
      },
    }
  }

  const usd = matched.reduce((total, record) => total + record.costUsd, 0)
  if (matched.every((record) => record.authoritative)) return { kind: 'authoritative', usd }

  const sources = [
    ...new Set(
      matched
        .filter((record) => !record.authoritative)
        .map((record) => record.estimateSource)
        .filter((source): source is string => source !== null),
    ),
  ].sort()
  return { kind: 'estimated', usd, sources }
}

// ── phase, derived and said to be ────────────────────────────────────────────

/**
 * The phase this interaction's evidence supports, and the evidence itself.
 *
 * Reads-only reads as exploring, writes as implementing, test commands as
 * verifying, commits as landing — with the tools that decided it one disclosure
 * away. It is never presented as something the agent declared, because
 * rhizomorph watches whatever you run rather than imposing a pipeline; when
 * prd-27's beacons land, a *declared* phase arrives additively and outranks
 * this, and the card will say which it is showing.
 */
export function phaseFor(
  tools: readonly string[],
  commitCount: number,
  now: number,
  lastTs: number,
): InteractionPhase {
  const elapsedMs = Math.max(0, now - lastTs)
  const seen = new Set(tools)

  let phase: WorkPhase = 'unknown'
  let evidence = 'no tool call in this interaction names a phase'
  for (const rule of PHASE_TOOLS) {
    const hits = rule.tools.filter((tool) => seen.has(tool))
    if (hits.length === 0) continue
    phase = rule.phase
    evidence = `${hits.join(', ')} ${hits.length === 1 ? 'was' : 'were'} called`
  }
  if (commitCount > 0) {
    phase = 'landing'
    evidence = `${commitCount === 1 ? '1 commit' : `${commitCount} commits`} landed in this window`
  }

  return {
    phase,
    inferred: true,
    disclosure: {
      label: `${phase} — inferred`,
      why: {
        reason: 'this phase is derived from what ran, not declared by the agent',
        evidence: { fact: evidence, elapsedMs },
      },
      remedy: {
        kind: 'none',
        because:
          'nothing to correct — the instrument watches whatever you run rather than imposing a pipeline, so a declared phase can only arrive from the agent itself',
      },
    },
  }
}

// ── the card ─────────────────────────────────────────────────────────────────

function gapDisclosureFor(
  wallMs: number,
  workMs: number,
  leafCount: number,
  now: number,
  endTs: number,
): DisclosureContent {
  const gapMs = Math.max(0, wallMs - workMs)
  return {
    label: 'the gap',
    why: {
      reason:
        gapMs === 0
          ? 'every millisecond of this interaction was measured work'
          : 'wall-clock time exceeds summed work — the difference is thinking, rate-limiting, or waiting on a human',
      evidence: {
        fact: `${leafCount === 1 ? '1 leaf span' : `${leafCount} leaf spans`} summed (containers excluded, or they would count twice), last span`,
        elapsedMs: Math.max(0, now - endTs),
      },
    },
    remedy: {
      kind: 'none',
      because:
        'the gap is a measurement, not a fault — a span only exports once it ends, so unaccounted time is time no span was open for',
    },
  }
}

/**
 * Every interaction this lane produced, newest first — the run view's own
 * reading order, and `selectLaneInteractions`' own ordering, unchanged.
 */
export function buildInteractionCards(
  state: SessionState,
  lane: string,
  options: BuildInteractionOptions,
): InteractionCardModel[] {
  const entries = options.entries ?? []
  const cards: InteractionCardModel[] = []

  for (const summary of selectLaneInteractions(state, lane)) {
    const tree = selectTraceTree(state, summary.traceId)
    const root = tree?.roots.find((candidate) => candidate.span.spanId === summary.spanId)
    if (root === undefined) continue
    cards.push(buildCard(state, lane, root, options.now, entries))
  }

  return cards
}

/** One card, from one interaction root. Exported so a test can rig a tree straight into it. */
export function buildCard(
  state: SessionState,
  lane: string,
  root: TraceTreeNode,
  now: number,
  entries: readonly TranscriptEntry[],
): InteractionCardModel {
  const spans = flatten(root)
  const leafSpans = leaves(root)
  const wallMs = Math.max(0, root.span.endTs - root.span.startTs)
  const workMs = leafSpans.reduce((total, span) => total + Math.max(0, span.endTs - span.startTs), 0)

  const llm = spans.filter((span) => span.kind === 'llm_request')
  const toolSpans = spans.filter((span) => span.kind === 'tool')
  const requestIds = new Set(
    llm.map((span) => span.requestId).filter((id): id is string => id !== null),
  )

  let tokens: TokenUsagePayload = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  for (const span of llm) {
    if (span.tokens === null) continue
    tokens = {
      input: tokens.input + span.tokens.input,
      output: tokens.output + span.tokens.output,
      cacheRead: tokens.cacheRead + span.tokens.cacheRead,
      cacheCreation: tokens.cacheCreation + span.tokens.cacheCreation,
    }
  }

  // Files: this interaction's OWN tool calls, joined to the ledger by
  // `toolUseId` (prd11 ruling 1/2's key). Never the lane's whole touch list —
  // that would attribute every file the lane ever changed to every card.
  const toolUseIds = new Set(
    toolSpans.map((span) => span.toolUseId).filter((id): id is string => id !== null),
  )
  const files = [
    ...new Set(
      state.telemetry.tools
        .filter(
          (record) =>
            record.lane === lane &&
            record.filePath !== null &&
            record.toolUseId !== null &&
            toolUseIds.has(record.toolUseId),
        )
        .map((record) => record.filePath as string),
    ),
  ].sort()

  const subagents = subagentsOf(spans)
  const refusals = spans
    .filter((span) => span.kind === 'tool_blocked' && span.decision !== null)
    .map((span) => ({
      spanId: span.spanId,
      toolName: span.toolName,
      decision: span.decision as SpanDecision,
      waitMs: Math.max(0, span.endTs - span.startTs),
    }))

  const commitCount = state.commits.log.filter(
    (commit) => commit.landedAt >= root.span.startTs && commit.landedAt <= root.span.endTs,
  ).length

  const toolNames = toolSpans
    .map((span) => span.toolName)
    .filter((name): name is string => name !== null)

  return {
    traceId: root.span.traceId,
    spanId: root.span.spanId,
    lane,
    startTs: root.span.startTs,
    endTs: root.span.endTs,
    // The root of a finished interaction IS the interaction span. Anything else
    // rooting a forest is an orphan whose parent has not ended yet.
    inFlight: root.span.kind !== 'interaction',
    wallMs,
    workMs,
    gapMs: Math.max(0, wallMs - workMs),
    gapDisclosure: gapDisclosureFor(wallMs, workMs, leafSpans.length, now, root.span.endTs),
    quote: quoteFor(entries, root.span.startTs, root.span.endTs),
    facts: {
      model: llm.find((span) => span.model !== null)?.model ?? null,
      tokens,
      toolCount: toolSpans.length,
      files,
      cost: costFor(state, requestIds, lane, now, root.span.endTs),
    },
    phase: phaseFor(toolNames, commitCount, now, root.span.endTs),
    subagents,
    refusals,
  }
}

/** Subagent lines, one per `agentId` the subtree names. The tree is real in the data; this mirrors it. */
function subagentsOf(spans: readonly SpanRecord[]): InteractionSubagent[] {
  const byAgent = new Map<string, InteractionSubagent>()
  for (const span of spans) {
    if (span.agentId === null) continue
    const held = byAgent.get(span.agentId) ?? {
      agentId: span.agentId,
      subagentType: null,
      spanCount: 0,
      durationMs: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    }
    held.spanCount += 1
    held.durationMs = Math.max(held.durationMs, span.endTs - span.startTs)
    if (span.subagentType !== null) held.subagentType = span.subagentType
    if (span.kind === 'llm_request' && span.tokens !== null) {
      held.tokens = {
        input: held.tokens.input + span.tokens.input,
        output: held.tokens.output + span.tokens.output,
        cacheRead: held.tokens.cacheRead + span.tokens.cacheRead,
        cacheCreation: held.tokens.cacheCreation + span.tokens.cacheCreation,
      }
    }
    byAgent.set(span.agentId, held)
  }
  return [...byAgent.values()].sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0))
}
