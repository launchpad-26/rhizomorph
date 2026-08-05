import type { TurnEntry, TurnGrammar } from './turn-grammar.js'

/**
 * Claude Code's session-JSONL turn grammar — a **versioned capture, not
 * documentation** (dialect-verification discipline; prd15 ruling 1).
 *
 * Derived 2026-08-05 by surveying this machine's entire Claude Code corpus:
 * **253 transcripts, 64,979 lines, 42,842 conversational entries**, spanning
 * claude-code 2.1.220 / 2.1.221 / 2.1.222 (the grammar is identical across
 * all three). The fixtures beside this file (`fixtures/claude-code-2.1.222-*`)
 * are real slices of that corpus, mechanically redacted — see
 * `fixtures/CAPTURE.md` for the recipe and how to re-derive it.
 *
 * ## What the corpus says
 *
 * **1. The last LINE of a transcript is almost never conversation.** Of 253
 * files, 213 end on `last-prompt`, 29 on `permission-mode`, 4 on `mode`, and
 * only 4 on an `assistant`/`user` entry. The trailing run of non-conversational
 * lines is 3 in the modal case and up to 7. A reader that took "the last line"
 * as the turn shape would be wrong 98% of the time. {@link CONVERSATIONAL_TYPES}
 * is therefore the first thing this grammar applies, and the metadata-skip is
 * the single most load-bearing fact in the whole dialect.
 *
 * Observed non-conversational types, by frequency: `last-prompt` (4192),
 * `ai-title` (4186), `permission-mode` (4168), `mode` (4165), `attachment`
 * (2772), `file-history-delta` (1459), `system` (483), `file-history-snapshot`
 * (445), `queue-operation` (283), `agent-name` (1). All are bookkeeping the
 * CLI writes around the conversation; none of them advances a turn. They still
 * move the file's mtime, which is exactly why `lane-state.ts` refuses to let
 * write recency stand in for work recency.
 *
 * **2. `message.stop_reason` is the completion discriminator.** Across 26,567
 * assistant entries: `tool_use` 26,178 · `end_turn` 345 · `stop_sequence` 43 ·
 * `null` 1. {@link COMPLETING_STOP_REASONS} names the two that mean "the model
 * returned control"; every completed transcript in the corpus tails on one of
 * them (`end_turn` 212, `stop_sequence` 26 — 238 of the 242 files that have a
 * conversational entry at all).
 *
 * **3. `stop_reason: tool_use` splits in two, and the split matters.** With a
 * `tool_use` content block (15,821 entries) the model is *awaiting a result* —
 * PENDING. Without one (`thinking` 6,821, `text` 3,547) the reply is simply
 * still being written across lines: the very next conversational entry is
 * another `assistant` in 10,368 of 10,369 cases, and never EOF in a settled
 * file. Two genuinely different shapes wearing one stop_reason.
 *
 * **4. Tool results come back as `user` entries** whose content array carries
 * `tool_result` blocks with a `tool_use_id` (15,815 blocks). 15,804 of 15,822
 * opened calls resolve inside the next few entries; the 18 that never do are
 * abandoned turns, which is why a completing entry clears the pending set.
 *
 * **5. `isSidechain` is present on 100% of conversational entries** (42,842 of
 * 42,842) — so the sidechain filter is structural, never an inference. This
 * corpus contains **zero** sidechain entries and zero `Task` tool calls, so
 * *where* a delegating lane's subagent lines land is UNVERIFIED here (labelled
 * per dialect-verification §6). The grammar reports the flag faithfully and
 * `turn-shape.ts` refuses to let a sidechain entry speak for the lane's main
 * turn either way — correct whichever way the next capture falls.
 *
 * ## Unverified in this capture
 *
 * - Sidechain placement (see 5 above).
 * - `stop_reason: null` (1 entry, on a `thinking` block): treated as
 *   not-completing, i.e. mid-stream, which is what its neighbours show.
 * - Compaction/summary boundaries: no `summary`-type line appears in this
 *   corpus, so nothing is claimed about them.
 */

/**
 * The only two line types that carry conversation. Everything else Claude Code
 * writes to the transcript is bookkeeping — see fact 1 above.
 */
export const CONVERSATIONAL_TYPES = ['assistant', 'user'] as const

/**
 * `stop_reason` values that mean the model handed control back. Anything else
 * — including `null` and any value a future release invents — is treated as
 * "the turn is not over", the conservative reading: an unknown stop reason
 * must never be allowed to manufacture a WAITING summons.
 */
export const COMPLETING_STOP_REASONS = ['end_turn', 'stop_sequence'] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content
  if (!Array.isArray(content)) return []
  return content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block !== null)
}

function classifyClaudeLine(rawLine: string): TurnEntry | null {
  const trimmed = rawLine.trim()
  if (trimmed.length === 0) return null

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    // An unparsable line is a line still being written, or a corrupted one.
    // Either way it carries no opinion about turn shape — never an error.
    return null
  }

  const line = asRecord(value)
  if (!line) return null

  const type = line.type
  if (type !== 'assistant' && type !== 'user') return null

  const message = asRecord(line.message)
  if (!message) return null

  const sidechain = line.isSidechain === true
  const ts = asTimestamp(line.timestamp)

  if (type === 'assistant') {
    const stopReason = asString(message.stop_reason)
    const opensToolUseIds = contentBlocks(message)
      .filter((block) => block.type === 'tool_use')
      .map((block) => asString(block.id))
      .filter((id): id is string => id !== null)

    return {
      role: 'assistant',
      // Fact 2 + fact 3: a completing stop_reason is necessary, and an entry
      // that opened a tool call has by definition not returned control — the
      // corpus never pairs the two, and if a future release does, the pending
      // call is the stronger fact.
      turnComplete:
        stopReason !== null &&
        (COMPLETING_STOP_REASONS as readonly string[]).includes(stopReason) &&
        opensToolUseIds.length === 0,
      opensToolUseIds,
      sidechain,
      ts,
    }
  }

  // Fact 4. A human prompt arrives as string content (404 entries) or a `text`
  // block (39); either way it closes nothing and still means the model owes a
  // reply, which is what an empty `closesToolUseIds` says downstream.
  const closesToolUseIds = contentBlocks(message)
    .filter((block) => block.type === 'tool_result')
    .map((block) => asString(block.tool_use_id))
    .filter((id): id is string => id !== null)

  return { role: 'user', closesToolUseIds, sidechain, ts }
}

export const CLAUDE_JSONL_GRAMMAR: TurnGrammar = {
  cli: 'claude',
  capture: 'claude-code-2.1.222 (corpus 2.1.220–2.1.222; 253 transcripts, 64,979 lines, 2026-08-05)',
  classify: classifyClaudeLine,
}
