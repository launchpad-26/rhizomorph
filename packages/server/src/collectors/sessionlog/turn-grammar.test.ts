import { describe, expect, it } from 'vitest'
import { CLAUDE_JSONL_GRAMMAR } from './turn-grammar-claude.js'
import { grammarFor, TURN_GRAMMARS } from './turn-grammar.js'

/**
 * Dialect-agnostic tests for the widened `TurnGrammar` contract itself
 * (prd26 ruling 5 / ADR-0017) — the registry seam and the shape every
 * dialect must implement, as opposed to `turn-grammar-claude.test.ts`, which
 * states claude's own dialect against a real capture. A codex or pi grammar
 * lands its dialect-specific tests beside its own file; this file's tests
 * stay true for any dialect the registry ever gains.
 */

describe('the grammar registry (the pluggable seam)', () => {
  it('answers for claude', () => {
    expect(grammarFor('claude')).toBe(CLAUDE_JSONL_GRAMMAR)
  })

  it('answers null for a dialect nobody has captured — never claude\'s eyes on another CLI', () => {
    // prd15 sequences codex and pi behind captures. Falling back to claude
    // would read a codex rollout through the wrong grammar and produce
    // confident nonsense; a null is the honest gap the caller must voice.
    for (const cli of ['codex', 'pi', 'gemini', 'openclaw', '', 'toString', 'constructor']) {
      expect(grammarFor(cli)).toBeNull()
    }
  })
})

describe('every registered grammar implements the whole widened contract', () => {
  it('carries a classify, an extractFacts, a cli and a capture — never half a dialect', () => {
    // ADR-0017's argument against a second, parallel interface: a dialect
    // that only implements one half is exactly the drift the merged
    // interface exists to make impossible. If this ever iterates over more
    // than one entry, every one of them is held to the same bar.
    for (const grammar of Object.values(TURN_GRAMMARS)) {
      expect(typeof grammar.cli).toBe('string')
      expect(typeof grammar.capture).toBe('string')
      expect(grammar.capture.length).toBeGreaterThan(0)
      expect(typeof grammar.classify).toBe('function')
      expect(typeof grammar.extractFacts).toBe('function')
    }
  })
})
