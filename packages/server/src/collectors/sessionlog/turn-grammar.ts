/**
 * The per-CLI transcript-dialect seam (prd15 ruling 1; widened by prd26
 * ruling 5 / ADR-0017).
 *
 * Every observable agent CLI writes a session transcript as it works. What
 * differs between CLIs is only the *dialect* — which lines are conversation
 * and which are bookkeeping, how a completed turn announces itself, how a
 * pending tool call is written down, and separately, how usage/model/tool
 * facts sit inside a line. This module names that seam for both facts, but
 * only one reader is actually wired through it today. The turn-shape state
 * machine (`turn-shape.ts`, `lane-state.ts`) reads turn shape exclusively
 * through `classify()` — it has never learned a fact about Claude Code's
 * JSONL directly. The event-emitting organ that reports tokens, models and
 * tool calls has **not** made the same jump: `collector.ts` imports
 * `parseAssistantLine` and calls it directly, a few lines after it calls
 * `turnGrammar.classify()` on the very same line — `extractFacts()` exists
 * and claude implements it, but nothing calls it yet. Rewiring that call
 * site is real, required work for landing a second dialect, left to prd26
 * wave 4 (recorded as a Bad consequence in ADR-0017, which also names why
 * this issue's fence left `collector.ts` alone). #324's fence left it alone
 * too, for pi — `collector.ts` is claude-specific (it watches
 * `~/.claude/projects/`, not `~/.pi/agent/sessions/`), so registering a
 * second grammar here does not by itself give pi a live reader. Both
 * dialects' `extractFacts()` remain reachable only by calling them directly
 * (as `../pi/grammar.test.ts` and `turn-grammar-claude.test.ts` do), which is
 * exactly what proves the seam without needing a multi-dialect collector to
 * exist yet.
 *
 * **Why one interface and not two.** `classify` and `extractFacts` are read
 * from the *same* raw line, for the *same* dialect, pinned to the *same*
 * capture — ADR-0017 has the rejected alternative (a second, parallel
 * interface) and why it lost: two interfaces means two `cli`/`capture`
 * pairs per dialect that could silently drift apart, and ruling 4 already
 * requires a dialect to land whole, in one issue, so nothing is ever gained
 * by letting one half of a dialect exist without the other.
 *
 * **Claude first, capture behind capture.** prd15's sequencing puts codex and
 * pi behind captures: "Per-CLI turn-shape grammars are adapter facts pinned
 * by dialect-verification captures. A grammar written from documentation
 * validates our reading of the docs, not the tool." codex (#322) captured
 * real evidence and declined — its rollout never showed a tool call written
 * before its result, and split usage/model across lines this interface's
 * one-line contract cannot join. pi (#324) is the first dialect whose real
 * captures support both halves honestly; see `../pi/grammar.ts`. Every other
 * CLI still gets a `null` from {@link grammarFor} rather than a guess.
 */

import { PI_JSONL_GRAMMAR } from '../pi/grammar.js'
import { CLAUDE_JSONL_GRAMMAR } from './turn-grammar-claude.js'

/** Which CLI dialect a transcript is written in. Extended per adapter wave. */
export type TranscriptCli = 'claude' | 'pi'

/**
 * One conversational entry, reduced to the four facts turn shape depends on.
 * Everything else a transcript line carries — tokens, models, prompts, file
 * paths — belongs to the other readers of this directory, not here.
 */
export type TurnEntry =
  | {
      role: 'assistant'
      /**
       * The model returned control at this entry: nothing further is owed
       * without a new prompt. This is the ONLY shape that can become WAITING.
       */
      turnComplete: boolean
      /** Tool calls this entry opened, awaiting results. Empty for a plain reply. */
      opensToolUseIds: readonly string[]
      sidechain: boolean
      /** The entry's own source time (epoch ms), or null when unparsable. */
      ts: number | null
    }
  | {
      role: 'user'
      /** Tool results carried by this entry, matched against open calls. */
      closesToolUseIds: readonly string[]
      sidechain: boolean
      ts: number | null
    }

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

/**
 * One transcript line's usage/model/tool facts — the extraction half of a
 * dialect, seamed beside {@link TurnEntry} because it has a different reader
 * (the organ that emits `llm.usage`/`tool.activity`, not the turn-shape state
 * machine) and a different shape (assistant-only; a `user` line never carries
 * these facts, so it extracts to `null`, same as any bookkeeping line).
 */
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
   * Epoch millis parsed from the line's own timestamp (when the agent
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

export interface TurnGrammar {
  /** Dialect name — also the fixture-filename prefix for its captures. */
  readonly cli: TranscriptCli
  /**
   * Provenance of the capture this grammar was derived from, in the
   * dialect-verification sense: a *versioned capture*, not documentation.
   * Read by the next person to touch the dialect, and asserted by its tests.
   * One string serves both `classify` and `extractFacts` — they are read off
   * the same capture, never two.
   */
  readonly capture: string
  /**
   * Classifies one raw transcript line. `null` means "this line says nothing
   * about turn shape" — bookkeeping, an unparsable line, a shape this capture
   * never saw. Never an error: an unknown line type maps to a stable "no
   * opinion", exactly as the trace parser maps an unknown span name to
   * `other` (adapters spike, conformance rule 2).
   */
  classify(rawLine: string): TurnEntry | null
  /**
   * Extracts usage/model/tool facts from one raw transcript line. `null`
   * means "this line carries none of these facts" — every non-assistant
   * line, an unparsable line, or an assistant line missing a model/usage
   * block (a shape this capture never saw). Never an error, for the same
   * reason `classify` never is: an unrecognised shape is a fixture gap, not
   * a crash (conformance rule 2).
   */
  extractFacts(rawLine: string): AssistantLineFacts | null
}

/**
 * Every dialect this build can read. `pi` is the second entry, and the first
 * time this seam has taken a real second dialect (prd26 wave 4, #324) — codex
 * (#322) captured real evidence and declined, because its rollout never
 * showed a tool call written before its result and split usage/model across
 * lines this interface's one-line contract cannot join. Neither problem holds
 * for pi; see `../pi/grammar.ts`'s header comment for the capture that proves it.
 */
export const TURN_GRAMMARS: Readonly<Record<TranscriptCli, TurnGrammar>> = Object.freeze({
  claude: CLAUDE_JSONL_GRAMMAR,
  pi: PI_JSONL_GRAMMAR,
})

/**
 * The grammar for a CLI, or `null` when this build has never captured that
 * dialect. A null grammar is an honest gap the caller must voice — never a
 * fallback to claude's shapes, which would read another CLI's transcript
 * through the wrong eyes and produce confident nonsense.
 */
export function grammarFor(cli: string): TurnGrammar | null {
  return Object.hasOwn(TURN_GRAMMARS, cli) ? TURN_GRAMMARS[cli as TranscriptCli] : null
}
