import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { TurnEntry } from './turn-grammar.js'
import { CLAUDE_JSONL_GRAMMAR } from './turn-grammar-claude.js'
import { advanceTurnShape, initialTurnShape, isMidTurn, scanTurnShape, type TurnShape } from './turn-shape.js'

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url))
const CAPTURED_VERSION = 'claude-code-2.1.222'

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

function shapeOf(name: string): TurnShape {
  return scanTurnShape(fixtureLines(name), CLAUDE_JSONL_GRAMMAR).shape
}

function assistant(overrides: Partial<Extract<TurnEntry, { role: 'assistant' }>> = {}): TurnEntry {
  return { role: 'assistant', turnComplete: false, opensToolUseIds: [], sidechain: false, ts: null, ...overrides }
}

function user(overrides: Partial<Extract<TurnEntry, { role: 'user' }>> = {}): TurnEntry {
  return { role: 'user', closesToolUseIds: [], sidechain: false, ts: null, ...overrides }
}

describe('the turn-shape fold, over real transcripts', () => {
  it('derives each captured tail shape', () => {
    expect(shapeOf(`${CAPTURED_VERSION}-tail-turn-complete.jsonl`)).toBe('turn-complete')
    expect(shapeOf(`${CAPTURED_VERSION}-tail-stop-sequence.jsonl`)).toBe('turn-complete')
    expect(shapeOf(`${CAPTURED_VERSION}-tail-pending-tool.jsonl`)).toBe('pending-tool')
    expect(shapeOf(`${CAPTURED_VERSION}-tail-mid-stream.jsonl`)).toBe('mid-stream')
    expect(shapeOf(`${CAPTURED_VERSION}-tail-awaiting-reply.jsonl`)).toBe('awaiting-reply')
    expect(shapeOf(`${CAPTURED_VERSION}-tail-metadata-only.jsonl`)).toBe('empty')
  })

  it('takes the work witness from the entries, never from the bookkeeping that follows', () => {
    // The heartbeat/work split at its source: a real transcript's last LINE is
    // `last-prompt`, written after the turn ended. `lastEntryTs` must be the
    // assistant's own timestamp, not whenever the CLI last touched the file.
    const lines = fixtureLines(`${CAPTURED_VERSION}-tail-turn-complete.jsonl`)
    const state = scanTurnShape(lines, CLAUDE_JSONL_GRAMMAR)
    const lastConversationalTs = lines
      .map((line) => CLAUDE_JSONL_GRAMMAR.classify(line))
      .filter((entry): entry is TurnEntry => entry !== null)
      .map((entry) => entry.ts)
      .filter((ts): ts is number => ts !== null)
      .at(-1)
    expect(state.lastEntryTs).toBe(lastConversationalTs)
  })

  it('never leaves a pending call open across a whole real session', () => {
    const state = scanTurnShape(fixtureLines(`${CAPTURED_VERSION}-session-multi-turn.jsonl`), CLAUDE_JSONL_GRAMMAR)
    expect(state.shape).toBe('turn-complete')
    expect(state.pendingToolUseIds).toEqual([])
  })
})

describe('the prefix-consistency law (the replay law, applied to liveness)', () => {
  /**
   * prd15's keystone must be replayable: the state derived at time T from a
   * transcript truncated at T has to equal the state derived at T from the
   * full transcript read up to T. Stated over EVERY prefix of a real
   * multi-turn session, two ways — a from-scratch scan and the incremental
   * fold the collector actually runs — and compared byte-for-byte.
   */
  const lines = fixtureLines(`${CAPTURED_VERSION}-session-multi-turn.jsonl`)

  it('agrees with itself at every prefix of a real session, byte for byte', () => {
    let incremental = initialTurnShape()
    for (let k = 0; k <= lines.length; k += 1) {
      const fromScratch = scanTurnShape(lines.slice(0, k), CLAUDE_JSONL_GRAMMAR)
      expect(JSON.stringify(incremental), `prefix ${k} disagrees`).toBe(JSON.stringify(fromScratch))
      if (k < lines.length) {
        incremental = scanTurnShape([lines[k] as string], CLAUDE_JSONL_GRAMMAR, incremental)
      }
    }
    expect(lines.length).toBeGreaterThan(20)
  })

  it('agrees whatever the chunking — the collector reads whatever bytes happened to land', () => {
    // A poll reads however many lines arrived since the last one. Any split of
    // the same stream must fold to the same state, or liveness would depend on
    // poll timing rather than on the transcript.
    const whole = scanTurnShape(lines, CLAUDE_JSONL_GRAMMAR)
    for (const chunk of [1, 2, 3, 7, 13, lines.length]) {
      let state = initialTurnShape()
      for (let i = 0; i < lines.length; i += chunk) {
        state = scanTurnShape(lines.slice(i, i + chunk), CLAUDE_JSONL_GRAMMAR, state)
      }
      expect(JSON.stringify(state), `chunk size ${chunk}`).toBe(JSON.stringify(whole))
    }
  })

  it('is pure: the same fold run twice produces identical bytes', () => {
    expect(JSON.stringify(scanTurnShape(lines, CLAUDE_JSONL_GRAMMAR))).toBe(
      JSON.stringify(scanTurnShape(lines, CLAUDE_JSONL_GRAMMAR)),
    )
  })
})

describe('the fold rules', () => {
  it('holds a lane pending until every parallel call it opened is answered', () => {
    let state = initialTurnShape()
    state = advanceTurnShape(state, assistant({ opensToolUseIds: ['a'] }))
    state = advanceTurnShape(state, assistant({ opensToolUseIds: ['b'] }))
    expect(state.shape).toBe('pending-tool')

    state = advanceTurnShape(state, user({ closesToolUseIds: ['a'] }))
    expect(state.shape).toBe('pending-tool')
    expect(state.pendingToolUseIds).toEqual(['b'])

    state = advanceTurnShape(state, user({ closesToolUseIds: ['b'] }))
    expect(state.shape).toBe('awaiting-reply')
    expect(state.pendingToolUseIds).toEqual([])
  })

  it('clears abandoned calls when the model hands control back', () => {
    // 18 of 15,822 calls in the corpus are never answered. A stale id must not
    // hold a finished lane in `pending-tool` forever — that would make WAITING
    // unreachable for the rest of the session.
    let state = initialTurnShape()
    state = advanceTurnShape(state, assistant({ opensToolUseIds: ['abandoned'] }))
    state = advanceTurnShape(state, assistant({ turnComplete: true }))
    expect(state.shape).toBe('turn-complete')
    expect(state.pendingToolUseIds).toEqual([])
  })

  it('reads a human prompt as the model owing a turn', () => {
    const state = advanceTurnShape(initialTurnShape(), user())
    expect(state.shape).toBe('awaiting-reply')
  })

  it('lets a subagent entry count as life without letting it speak for the lane (#133)', () => {
    // The false-summons law at the fold: a delegating lane's subagent finishes
    // its own turn constantly. If a sidechain `end_turn` could set the shape,
    // every delegation would summon the operator the moment its helper
    // reported back — while the lane itself is mid-Task and busy.
    let state = initialTurnShape()
    state = advanceTurnShape(state, assistant({ opensToolUseIds: ['task-1'], ts: 1_000 }))
    expect(state.shape).toBe('pending-tool')

    state = advanceTurnShape(state, assistant({ turnComplete: true, sidechain: true, ts: 2_000 }))
    state = advanceTurnShape(state, user({ sidechain: true, ts: 3_000 }))

    expect(state.shape).toBe('pending-tool')
    expect(state.pendingToolUseIds).toEqual(['task-1'])
    expect(state.lastEntryTs).toBe(1_000)
    expect(state.sidechainEntries).toBe(2)
    expect(state.lastSidechainTs).toBe(3_000)
  })

  it('will not let a subagent close the main thread\'s tool call', () => {
    let state = initialTurnShape()
    state = advanceTurnShape(state, assistant({ opensToolUseIds: ['task-1'] }))
    state = advanceTurnShape(state, user({ closesToolUseIds: ['task-1'], sidechain: true }))
    expect(state.pendingToolUseIds).toEqual(['task-1'])
  })

  it('keeps the work witness monotonic against an out-of-order timestamp', () => {
    let state = initialTurnShape()
    state = advanceTurnShape(state, assistant({ ts: 5_000 }))
    state = advanceTurnShape(state, assistant({ ts: 1_000 }))
    expect(state.lastEntryTs).toBe(5_000)
  })

  it('stays bounded: a long transcript folds to the same fields a short one does', () => {
    let state = initialTurnShape()
    for (let i = 0; i < 5_000; i += 1) {
      state = advanceTurnShape(state, assistant({ opensToolUseIds: [`t-${i}`] }))
      state = advanceTurnShape(state, user({ closesToolUseIds: [`t-${i}`] }))
    }
    expect(state.pendingToolUseIds).toEqual([])
    expect(Object.keys(state).sort()).toEqual(Object.keys(initialTurnShape()).sort())
  })
})

describe('isMidTurn', () => {
  it('names exactly the shapes with an unfinished turn', () => {
    expect(isMidTurn('pending-tool')).toBe(true)
    expect(isMidTurn('mid-stream')).toBe(true)
    expect(isMidTurn('awaiting-reply')).toBe(true)
    expect(isMidTurn('turn-complete')).toBe(false)
    expect(isMidTurn('empty')).toBe(false)
  })
})
