/**
 * The per-CLI turn-shape grammar seam (prd15 ruling 1).
 *
 * Every observable agent CLI writes a session transcript as it works. What
 * differs between CLIs is only the *dialect* — which lines are conversation
 * and which are bookkeeping, how a completed turn announces itself, how a
 * pending tool call is written down. This module names that seam so the state
 * machine above it (`turn-shape.ts`, `lane-state.ts`) never learns a single
 * fact about Claude Code's JSONL, and a codex or pi grammar lands as one new
 * file implementing {@link TurnGrammar} plus its own version-pinned capture —
 * no change to the organ, no change to the reducer, no change to the UI.
 *
 * **Claude first, and only claude.** prd15's sequencing puts codex and pi in
 * later waves *behind captures*: "Per-CLI turn-shape grammars are adapter
 * facts pinned by dialect-verification captures." A grammar written from
 * documentation validates our reading of the docs, not the tool. So the
 * registry ships exactly one entry and {@link grammarFor} answers `null` for
 * every other CLI rather than guessing at a dialect nobody has captured.
 */

import { CLAUDE_JSONL_GRAMMAR } from './turn-grammar-claude.js'

/** Which CLI dialect a transcript is written in. Extended per adapter wave. */
export type TranscriptCli = 'claude'

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

export interface TurnGrammar {
  /** Dialect name — also the fixture-filename prefix for its captures. */
  readonly cli: TranscriptCli
  /**
   * Provenance of the capture this grammar was derived from, in the
   * dialect-verification sense: a *versioned capture*, not documentation.
   * Read by the next person to touch the dialect, and asserted by its tests.
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
}

/** Every dialect this build can read. One entry today, on purpose. */
export const TURN_GRAMMARS: Readonly<Record<TranscriptCli, TurnGrammar>> = Object.freeze({
  claude: CLAUDE_JSONL_GRAMMAR,
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
