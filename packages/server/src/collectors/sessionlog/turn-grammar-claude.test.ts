import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { grammarFor, type TurnEntry } from './turn-grammar.js'
import { CLAUDE_JSONL_GRAMMAR, COMPLETING_STOP_REASONS, CONVERSATIONAL_TYPES } from './turn-grammar-claude.js'
import { scanTurnShape } from './turn-shape.js'

/**
 * The claude dialect, stated against **real captures** (prd15 ruling 1's
 * dialect-verification clause). Every fixture read here is a mechanically
 * redacted slice of this machine's own Claude Code transcripts — see
 * `fixtures/CAPTURE.md`. Nothing in this file is hand-written from docs: a
 * hand-written fixture validates our reading, not the tool.
 */

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))
const CAPTURED_VERSION = 'claude-code-2.1.222'

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

function classifiedTail(name: string): TurnEntry | null {
  const entries = fixtureLines(name)
    .map((line) => CLAUDE_JSONL_GRAMMAR.classify(line))
    .filter((entry): entry is TurnEntry => entry !== null)
  return entries.at(-1) ?? null
}

describe('the claude JSONL turn grammar', () => {
  it('names the capture it was derived from, not a document', () => {
    // dialect-verification: the grammar is a versioned capture. If someone
    // re-derives it against a newer claude, this string moves with the
    // fixtures — that is the whole discipline in one assertion.
    expect(CLAUDE_JSONL_GRAMMAR.cli).toBe('claude')
    expect(CLAUDE_JSONL_GRAMMAR.capture).toContain(CAPTURED_VERSION)
    expect(CLAUDE_JSONL_GRAMMAR.capture).toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('skips every non-conversational line type the corpus contains', () => {
    // The load-bearing fact: 213 of 253 real transcripts END on `last-prompt`,
    // and 249 of 253 end on something non-conversational. A grammar that read
    // "the last line" as the turn shape would be wrong 98% of the time.
    const noise = [
      '{"type":"last-prompt","lastPrompt":"x"}',
      '{"type":"ai-title","aiTitle":"x"}',
      '{"type":"permission-mode","permissionMode":"default"}',
      '{"type":"mode","mode":"x"}',
      '{"type":"attachment","attachment":{"type":"skill_listing"}}',
      '{"type":"file-history-delta"}',
      '{"type":"file-history-snapshot"}',
      '{"type":"queue-operation"}',
      '{"type":"agent-name","agentName":"x"}',
      '{"type":"system"}',
    ]
    for (const line of noise) {
      expect(CLAUDE_JSONL_GRAMMAR.classify(line)).toBeNull()
    }
    expect(CONVERSATIONAL_TYPES).toEqual(['assistant', 'user'])
  })

  it('reads a completed turn through the metadata that follows it (the 213/253 shape)', () => {
    const tail = classifiedTail(`${CAPTURED_VERSION}-tail-turn-complete.jsonl`)
    expect(tail).toMatchObject({ role: 'assistant', turnComplete: true, opensToolUseIds: [] })
    // Proven on the fixture, not asserted about it: the file's own last line
    // is bookkeeping, so the grammar had to skip past it to find this.
    const rawLast = JSON.parse(fixtureLines(`${CAPTURED_VERSION}-tail-turn-complete.jsonl`).at(-1) as string)
    expect(CONVERSATIONAL_TYPES).not.toContain(rawLast.type)
  })

  it('treats stop_sequence as completing, exactly as end_turn (43 entries, 26 file tails)', () => {
    expect(COMPLETING_STOP_REASONS).toEqual(['end_turn', 'stop_sequence'])
    expect(classifiedTail(`${CAPTURED_VERSION}-tail-stop-sequence.jsonl`)).toMatchObject({
      role: 'assistant',
      turnComplete: true,
    })
  })

  it('reads an open tool call as pending, carrying its id', () => {
    const tail = classifiedTail(`${CAPTURED_VERSION}-tail-pending-tool.jsonl`)
    expect(tail).toMatchObject({ role: 'assistant', turnComplete: false })
    expect(tail?.role === 'assistant' && tail.opensToolUseIds.length).toBeGreaterThan(0)
  })

  it('distinguishes a still-being-written reply from a pending tool, though both say stop_reason tool_use', () => {
    // Corpus fact 3: `tool_use` with no tool_use block (10,368 entries) is
    // mid-stream, not pending. Collapsing the two would make every thinking
    // block look like an unanswered tool call.
    const tail = classifiedTail(`${CAPTURED_VERSION}-tail-mid-stream.jsonl`)
    expect(tail).toMatchObject({ role: 'assistant', turnComplete: false, opensToolUseIds: [] })
  })

  it('reads a tool result as a user entry that closes the call it answers', () => {
    const tail = classifiedTail(`${CAPTURED_VERSION}-tail-awaiting-reply.jsonl`)
    expect(tail).toMatchObject({ role: 'user' })
    expect(tail?.role === 'user' && tail.closesToolUseIds.length).toBeGreaterThan(0)
  })

  it('has no opinion at all about a transcript of pure bookkeeping (the absence capture)', () => {
    // dialect-verification rule 1: a capture of the ABSENCE outcome, not only
    // the success one. A file with no conversation must produce no shape.
    expect(classifiedTail(`${CAPTURED_VERSION}-tail-metadata-only.jsonl`)).toBeNull()
    const shape = scanTurnShape(fixtureLines(`${CAPTURED_VERSION}-tail-metadata-only.jsonl`), CLAUDE_JSONL_GRAMMAR)
    expect(shape.shape).toBe('empty')
  })

  it('maps an unknown or malformed line to no-opinion, never to an error', () => {
    // Conformance rule 2: an upstream rename is a fixture update, not a crash.
    for (const line of ['', '   ', 'not json at all', '{"type":"a-shape-from-2027"}', '[]', 'null', '{']) {
      expect(() => CLAUDE_JSONL_GRAMMAR.classify(line)).not.toThrow()
      expect(CLAUDE_JSONL_GRAMMAR.classify(line)).toBeNull()
    }
  })

  it('refuses to let an unrecognised stop_reason manufacture a completed turn', () => {
    const line = JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      timestamp: '2026-08-05T00:00:00.000Z',
      message: { stop_reason: 'refusal_from_a_future_release', content: [{ type: 'text', text: 'x' }] },
    })
    expect(CLAUDE_JSONL_GRAMMAR.classify(line)).toMatchObject({ role: 'assistant', turnComplete: false })
  })

  it('never calls a turn complete while it has an open tool call, whatever stop_reason says', () => {
    const line = JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }],
      },
    })
    expect(CLAUDE_JSONL_GRAMMAR.classify(line)).toMatchObject({ turnComplete: false, opensToolUseIds: ['toolu_x'] })
  })

  it('reports isSidechain faithfully — the flag is on 100% of conversational entries', () => {
    const main = CLAUDE_JSONL_GRAMMAR.classify('{"type":"assistant","isSidechain":false,"message":{"stop_reason":"end_turn","content":[]}}')
    const sub = CLAUDE_JSONL_GRAMMAR.classify('{"type":"assistant","isSidechain":true,"message":{"stop_reason":"end_turn","content":[]}}')
    expect(main?.sidechain).toBe(false)
    expect(sub?.sidechain).toBe(true)
  })
})

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

describe('fixture hygiene law', () => {
  const fixtures = readdirSync(FIXTURES_DIR).filter((name) => name.startsWith('claude-code-'))

  it('pins every captured fixture to the tool version in its filename', () => {
    expect(fixtures.length).toBeGreaterThan(0)
    for (const name of fixtures) {
      expect(name).toMatch(/^claude-code-\d+\.\d+\.\d+-/)
    }
  })

  it('carries no identity, no host paths and no NUL bytes into a repo that will go public', () => {
    // Same posture as the otel collector's own fixture-hygiene law: a
    // transcript is the most content-bearing artifact this product touches, so
    // the redaction is checked structurally rather than trusted to capture time.
    for (const name of fixtures) {
      const raw = readFileSync(path.join(FIXTURES_DIR, name), 'utf8')
      expect(raw, `${name} carries an email address`).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      expect(raw, `${name} carries a real home directory`).not.toMatch(/\/(home|Users)\//)
      expect(raw.includes('\u0000'), `${name} carries a NUL byte`).toBe(false)
    }
  })

  it('keeps every fixture parseable line-by-line, so a capture cannot rot silently', () => {
    for (const name of fixtures) {
      for (const line of fixtureLines(name)) {
        expect(() => JSON.parse(line), `${name} has an unparsable line`).not.toThrow()
      }
    }
  })
})
