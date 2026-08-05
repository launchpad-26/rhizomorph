import type { TurnEntry, TurnGrammar } from './turn-grammar.js'

/**
 * The turn-shape fold — input (a) of the transcript-tail state machine
 * (prd15 ruling 1).
 *
 * A transcript's tail shape is derived as a **left fold over its lines**, not
 * as a query against the whole file. That is the design, not an optimisation:
 *
 * - **The replay law applies to liveness.** Rhizomorph's whole contract is
 *   that a fold over a prefix of the log equals the fold over the full log
 *   truncated at that point. A tail shape computed by seeking backwards from
 *   EOF would break that the moment a line arrived mid-read; a fold cannot.
 *   `turn-shape.test.ts` states this as a law over every prefix of a real
 *   transcript.
 * - **The collector already has the lines.** `tailProjectDir` reads exactly
 *   the bytes appended since last poll. Folding them costs no extra I/O — the
 *   organ rides along on a read the collector was making anyway.
 * - **The state stays bounded.** Only the outstanding tool calls and the last
 *   entry's facts survive a step, so a 60,000-line transcript folds into the
 *   same handful of fields a 5-line one does.
 */

/**
 * What the transcript's tail says the lane is *in the middle of*. This is a
 * statement about SHAPE alone — it knows nothing about clocks or processes,
 * and on its own it never decides a lane's state.
 */
export type TurnShape =
  /** No conversational entry seen at all. Nothing to derive — the honest gap. */
  | 'empty'
  /** The model returned control and owes nothing. The ONLY road to WAITING. */
  | 'turn-complete'
  /** Tool calls opened and not yet answered. A delegating lane lives here. */
  | 'pending-tool'
  /** The reply is still being written across lines (thinking/text, no tool). */
  | 'mid-stream'
  /** The user spoke last — a tool result or a prompt. The model owes a turn. */
  | 'awaiting-reply'

/**
 * Every shape except `turn-complete` and `empty` means a turn is unfinished.
 * FROZEN is defined against exactly this set (a stalled *mid-turn* transcript);
 * WAITING is defined against its complement.
 */
export function isMidTurn(shape: TurnShape): boolean {
  return shape === 'pending-tool' || shape === 'mid-stream' || shape === 'awaiting-reply'
}

/**
 * The fold's carried state. Plain JSON — it lives in the collector snapshot,
 * so it must survive a structured-clone round trip and a persisted resume.
 */
export interface TurnShapeState {
  shape: TurnShape
  /**
   * Tool calls opened on the MAIN thread and not yet answered, in open order.
   * Parallel tool calls legitimately put several here at once (the corpus
   * shows one `tool_use` block per assistant line, resolved together).
   */
  pendingToolUseIds: readonly string[]
  /**
   * Source time of the last MAIN-thread conversational entry — **the work
   * witness**. Distinct from the file's mtime on purpose: Claude Code appends
   * `last-prompt` / `ai-title` / `mode` bookkeeping after a turn ends, so a
   * transcript's mtime moves when no agent is working. See `lane-state.ts`.
   */
  lastEntryTs: number | null
  /**
   * Conversational entries seen on a Task/subagent thread. Counted, never
   * allowed to change {@link shape}: a subagent finishing its own turn is not
   * the lane's hand going up (#133). Zero across the pinned corpus — kept
   * because the flag is structural and the next capture may fill it.
   */
  sidechainEntries: number
  /** Source time of the last sidechain entry — a delegating lane's heartbeat. */
  lastSidechainTs: number | null
}

export function initialTurnShape(): TurnShapeState {
  return {
    shape: 'empty',
    pendingToolUseIds: [],
    lastEntryTs: null,
    sidechainEntries: 0,
    lastSidechainTs: null,
  }
}

/**
 * Folds one classified entry into the tail shape. Pure: same `(prev, entry)`
 * always yields the same next state, with no clock and no I/O anywhere near it.
 */
export function advanceTurnShape(prev: TurnShapeState, entry: TurnEntry): TurnShapeState {
  // A sidechain entry is life, not a turn. It can never complete the lane's
  // main turn, never close its pending calls, and never move its work witness
  // — a lane whose subagent just said "done" has not itself stopped (#133).
  if (entry.sidechain) {
    return {
      ...prev,
      sidechainEntries: prev.sidechainEntries + 1,
      lastSidechainTs: maxTs(prev.lastSidechainTs, entry.ts),
    }
  }

  const lastEntryTs = maxTs(prev.lastEntryTs, entry.ts)

  if (entry.role === 'assistant') {
    if (entry.turnComplete) {
      // The model handed control back. Anything still open was abandoned with
      // it — 18 of 15,822 calls in the corpus are never answered, and a stale
      // id must not hold a finished lane in `pending-tool` forever.
      return { ...prev, shape: 'turn-complete', pendingToolUseIds: [], lastEntryTs }
    }

    const pendingToolUseIds = [...prev.pendingToolUseIds, ...entry.opensToolUseIds]
    return {
      ...prev,
      shape: pendingToolUseIds.length > 0 ? 'pending-tool' : 'mid-stream',
      pendingToolUseIds,
      lastEntryTs,
    }
  }

  const closed = new Set(entry.closesToolUseIds)
  const pendingToolUseIds = prev.pendingToolUseIds.filter((id) => !closed.has(id))
  return {
    ...prev,
    // Parallel calls: one result back with another still outstanding leaves the
    // lane pending, not awaiting. The user's turn is only "the last word" when
    // nothing the model asked for is still missing.
    shape: pendingToolUseIds.length > 0 ? 'pending-tool' : 'awaiting-reply',
    pendingToolUseIds,
    lastEntryTs,
  }
}

/**
 * Folds raw transcript lines through a grammar. Equal by construction to
 * `lines.reduce(advance…)` — which is what makes an incremental tail (the
 * collector, reading only new bytes) and a from-scratch scan agree, prefix by
 * prefix.
 */
export function scanTurnShape(
  lines: Iterable<string>,
  grammar: TurnGrammar,
  from: TurnShapeState = initialTurnShape(),
): TurnShapeState {
  let state = from
  for (const line of lines) {
    const entry = grammar.classify(line)
    if (entry === null) continue
    state = advanceTurnShape(state, entry)
  }
  return state
}

function maxTs(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}
