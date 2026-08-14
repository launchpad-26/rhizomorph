import type { AssistantLineFacts, ToolUseFacts, TurnEntry, TurnGrammar } from '../sessionlog/turn-grammar.js'

/**
 * pi's session-JSONL turn grammar — a **versioned capture, not documentation**
 * (dialect-verification discipline; prd15 ruling 1), derived from
 * `pi 0.83.0` (`@earendil-works/pi-coding-agent`), captured 2026-08-14 from
 * inside this worktree. See `./fixtures/CAPTURE.md` for the full recipe, the
 * real captures backing every claim below, and what this capture could NOT
 * establish.
 *
 * ## Why pi is a different shape from codex, and why this file exists where
 * codex declined
 *
 * codex's rollout (`../codex/index.ts`) could not honestly back a grammar for
 * two reasons: no capture ever showed a tool call written before its result,
 * and usage/model facts were split across three different line types. Neither
 * problem holds for pi:
 *
 * 1. **A pending tool call is directly observed, live, not inferred.**
 *    `fixtures/CAPTURE.md`'s incrementality proof: a `sleep 3` bash tool call
 *    held the session file at exactly 5 lines — ending on the assistant
 *    entry with `stopReason: "toolUse"` — for 19 consecutive 100ms polls
 *    while the command was still running, before the `toolResult` line
 *    landed as line 6. `fixtures/pi-0.83.0-tail-pending-tool-interrupted.jsonl`
 *    pins the even stronger case: a real SIGINT sent 6s into a `sleep 15`
 *    tool call left a truncated, real, on-disk transcript ending on that same
 *    pending `toolCall` line, permanently — the tool call really was written
 *    before its result, not just briefly, but for good once interrupted.
 * 2. **Usage, model and tool calls are one line, not three.** Every
 *    `assistant` message entry carries `message.model`, `message.usage`
 *    (tokens **and**, uniquely among this repo's harnesses, a real per-turn
 *    dollar `cost`) and `message.content[].toolCall` blocks together, on the
 *    exact same JSON object `extractFacts(rawLine)` receives. Nothing here
 *    is joined across lines the way codex's `model`/`token_count` split
 *    would have required.
 *
 * ## What this grammar does NOT carry (real gaps, not omissions)
 *
 * - **`sessionId`/`cwd`/`gitBranch`/`requestId` are always `null`.** Every
 *   capture confirms these facts exist exactly once, on the session header
 *   line (`type: "session"`) — never repeated on a `message` entry the way
 *   claude repeats `sessionId`/`cwd`/`gitBranch`/`requestId` on every
 *   `assistant` line. `AssistantLineFacts` types these four fields nullable
 *   for exactly this reason: an honest per-line absence, not a join this
 *   interface's one-line contract would have to violate to fill in.
 * - **No sidechain/subagent concept was found.** pi's own docs describe no
 *   such marker, and no capture shows one; `sidechain`/`isSidechain` are
 *   always `false` here, the same conservative default claude's own grammar
 *   uses for its one never-observed shape.
 * - **`stopReason` values `"length"` and `"aborted"` are documented
 *   (`session-format.md`) but never captured.** Only `"stop"` (plain
 *   completion), `"toolUse"` (pending call) and `"error"` (the real API
 *   rejection in `fixtures/pi-0.83.0-task-error.jsonl`) were ever observed on
 *   this machine, so only those three are named in
 *   {@link PI_COMPLETING_STOP_REASONS}'s derivation below. An unverified
 *   `stopReason` — `"length"`, `"aborted"`, or anything a future pi release
 *   invents — is treated as **not completing**, the same conservative
 *   direction claude's grammar takes for a stop reason its own corpus never
 *   saw: a false WAITING summons is worse than a missed one.
 * - **`cacheRead`/`cacheWrite` were never observed nonzero.** Four
 *   back-to-back turns in one real session (not kept as a fixture — see
 *   `fixtures/CAPTURE.md`) never triggered caching via
 *   `openrouter/anthropic-claude-haiku-4.5`. The mapping below (pi's
 *   `cacheWrite` → the shared `cacheCreation`) is inferred from the field's
 *   own name and `session-format.md`'s documented `Usage` interface, not
 *   verified against a real nonzero value — pinned instead by a labelled
 *   synthetic line in `grammar.test.ts`.
 *
 * ## `ts`/`timestamp` reads the entry's own `line.timestamp`, never `message.timestamp`
 *
 * The one place this grammar reads a fact NOT off the `message` object: both
 * `classify`'s `ts` and `extractFacts`' `timestamp` parse `line.timestamp` —
 * present on every entry (`SessionEntryBase`), still the same raw line
 * `rawLine` names, just the outer key rather than a nested one. Real evidence
 * (`fixtures/pi-0.83.0-tool-call.jsonl`) is why: a `toolResult` entry and the
 * assistant entry that closes the turn right after it can carry the *exact
 * same* `message.timestamp` (both stamped when a model request was issued,
 * not when the entry was durably written) — `1786685538551` on both lines 6
 * and 7 in that fixture. Reading `message.timestamp` would make a
 * turn-closing entry advance a live fold's clock by zero, which is exactly
 * the false-WAITING risk this file already names for `stopReason` above.
 * `line.timestamp` is strictly increasing across every real capture; see
 * {@link asTimestamp}.
 */

/** `stopReason` values this capture actually observed as "the model handed control back." */
export const PI_COMPLETING_STOP_REASONS = ['stop', 'error'] as const

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** The entry's own ISO `timestamp`, parsed to epoch ms — see this file's header comment for why `message.timestamp` is the wrong field. */
function asTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function parseLine(rawLine: string): Record<string, unknown> | null {
  const trimmed = rawLine.trim()
  if (trimmed.length === 0) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    // An unparsable line is one still being written, or corrupted — no
    // opinion either way, never an error (conformance rule 2).
    return null
  }
  return asRecord(value)
}

/** Tool names pi's own file tools use — the only ones whose `arguments` carry a `path` (confirmed by real `write` and `edit` captures; `read` inferred from the same tool family, not independently captured). */
const FILE_TOOL_NAMES = new Set(['write', 'edit', 'read'])

function toolCallBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message.content
  if (!Array.isArray(content)) return []
  return content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block !== null && block.type === 'toolCall')
}

function classifyPiLine(rawLine: string): TurnEntry | null {
  const line = parseLine(rawLine)
  if (!line || line.type !== 'message') return null

  const message = asRecord(line.message)
  if (!message) return null

  const role = message.role
  const ts = asTimestamp(line.timestamp)

  if (role === 'assistant') {
    const stopReason = asString(message.stopReason)
    const opensToolUseIds = toolCallBlocks(message)
      .map((block) => asString(block.id))
      .filter((id): id is string => id !== null)

    return {
      role: 'assistant',
      turnComplete:
        stopReason !== null &&
        (PI_COMPLETING_STOP_REASONS as readonly string[]).includes(stopReason) &&
        opensToolUseIds.length === 0,
      opensToolUseIds,
      sidechain: false,
      ts,
    }
  }

  if (role === 'toolResult') {
    // pi represents a tool result as its own dedicated `role: "toolResult"`
    // entry, never nested inside a `user` entry the way claude's
    // `tool_result` content blocks are — an honest translation into the
    // shared `role: 'user'` ("closes tool uses") shape, not a guess: the
    // semantic is identical, only the raw dialect's own labelling differs.
    const toolCallId = asString(message.toolCallId)
    return {
      role: 'user',
      closesToolUseIds: toolCallId !== null ? [toolCallId] : [],
      sidechain: false,
      ts,
    }
  }

  if (role === 'user') {
    // Every real user entry captured here is a plain prompt: it never closes
    // a tool call (pi never nests a tool result inside a `user` message).
    return { role: 'user', closesToolUseIds: [], sidechain: false, ts }
  }

  return null
}

function extractFactsPi(rawLine: string): AssistantLineFacts | null {
  const line = parseLine(rawLine)
  if (!line || line.type !== 'message') return null

  const message = asRecord(line.message)
  if (!message || message.role !== 'assistant') return null

  const model = asString(message.model)
  const usage = asRecord(message.usage)
  if (!model || !usage) return null

  const toolUses: ToolUseFacts[] = toolCallBlocks(message)
    .map((block): ToolUseFacts | null => {
      const tool = asString(block.name)
      if (!tool) return null
      const args = asRecord(block.arguments)
      const filePath = tool !== null && FILE_TOOL_NAMES.has(tool) && args ? asString(args.path) : null
      return { tool, toolUseId: asString(block.id), filePath }
    })
    .filter((toolUse): toolUse is ToolUseFacts => toolUse !== null)

  return {
    // Never present on a pi `message` entry — see this file's header comment.
    sessionId: null,
    cwd: null,
    gitBranch: null,
    requestId: null,
    model,
    tokens: {
      input: asCount(usage.input),
      output: asCount(usage.output),
      cacheRead: asCount(usage.cacheRead),
      // pi calls this tier `cacheWrite`; the shared fact is `cacheCreation`.
      cacheCreation: asCount(usage.cacheWrite),
    },
    toolUses,
    timestamp: asTimestamp(line.timestamp),
    isSidechain: false,
  }
}

export const PI_JSONL_GRAMMAR: TurnGrammar = {
  cli: 'pi',
  capture: 'pi-0.83.0 (@earendil-works/pi-coding-agent, openrouter/anthropic-claude-haiku-4.5; 8 real captures, 2026-08-14)',
  classify: classifyPiLine,
  extractFacts: extractFactsPi,
}
