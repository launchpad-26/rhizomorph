/**
 * Pure parsing of one raw line from a Claude Code session JSONL file. Real
 * shapes captured on this machine (see `research/2026-07-30-telemetry-capture-routes.md`
 * §S2 and the fixtures alongside this collector):
 *
 * - Every line is one JSON object; only `type: "assistant"` lines carry
 *   token usage or tool calls — everything else (`user`, `system`,
 *   `ai-title`, …) is skipped.
 * - A single logical reply can span several `assistant` lines (one per
 *   content block: a `text` block, then a `tool_use` block, …), and every
 *   one of those lines repeats the *same* `message.usage` and `requestId`.
 *   Counting tokens per line would overcount; the collector dedupes on
 *   `requestId` and this module just reports it per line so that's possible.
 */

/**
 * One `tool_use` content block's facts. `filePath` is populated straight from
 * the block's own `input.file_path` — present on Edit/Write/Read and kin,
 * absent on Bash and everything else that isn't a file tool. Never inferred,
 * never guessed: a tool that didn't report `input.file_path` gets `null`.
 */
export interface ToolUseFacts {
  tool: string
  /** The block's own `tool_use` id, when present — the join key to `trace.span.toolUseId`. */
  toolUseId: string | null
  filePath: string | null
}

export interface AssistantLineFacts {
  sessionId: string | null
  cwd: string | null
  gitBranch: string | null
  requestId: string | null
  model: string
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheCreation: number
  }
  /** Every `tool_use` content block on this line, in order. */
  toolUses: ToolUseFacts[]
  /**
   * Epoch millis parsed from the line's own `timestamp` (when the agent
   * actually said this), or null when absent/unparsable — the caller falls
   * back to tick time rather than guessing.
   */
  timestamp: number | null
  /**
   * The line's own `isSidechain` marker: true when this turn ran on a
   * Task/subagent thread rather than the session's main conversation. Absent
   * or non-boolean is treated as `false`, same as every real capture seen so
   * far (`fixtures/conductor-root.jsonl:1` et al., always an explicit boolean).
   */
  isSidechain: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function asTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function asBool(value: unknown): boolean {
  return value === true
}

/**
 * Extracts the facts sessionlog cares about from one raw JSONL line. Returns
 * null for anything that isn't a usable `assistant` line — every other line
 * type, or an `assistant` line missing a model/usage (a shape not seen on
 * this machine, so it's skipped rather than guessed at).
 */
export function parseAssistantLine(raw: string): AssistantLineFacts | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }

  const line = asRecord(value)
  if (!line || line.type !== 'assistant') return null

  const message = asRecord(line.message)
  const model = message ? asString(message.model) : null
  if (!message || !model) return null

  const usage = asRecord(message.usage)
  if (!usage) return null

  const content = Array.isArray(message.content) ? message.content : []
  const toolUses = content
    .map((block) => asRecord(block))
    .filter((block): block is Record<string, unknown> => block !== null && block.type === 'tool_use')
    .map((block): ToolUseFacts | null => {
      const tool = asString(block.name)
      if (!tool) return null
      const input = asRecord(block.input)
      return {
        tool,
        toolUseId: asString(block.id),
        filePath: input ? asString(input.file_path) : null,
      }
    })
    .filter((toolUse): toolUse is ToolUseFacts => toolUse !== null)

  return {
    sessionId: asString(line.sessionId),
    cwd: asString(line.cwd),
    gitBranch: asString(line.gitBranch),
    requestId: asString(line.requestId),
    model,
    tokens: {
      input: asCount(usage.input_tokens),
      output: asCount(usage.output_tokens),
      cacheRead: asCount(usage.cache_read_input_tokens),
      cacheCreation: asCount(usage.cache_creation_input_tokens),
    },
    toolUses,
    timestamp: asTimestamp(line.timestamp),
    isSidechain: asBool(line.isSidechain),
  }
}
