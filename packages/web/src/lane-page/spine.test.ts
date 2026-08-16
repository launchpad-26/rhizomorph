import { initialSessionState } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { buildSpine } from './spine.js'
import type { LaneIndexEntry, LaneIndexSlice } from './laneIndex.js'

/**
 * The spine's arithmetic, on its own (prd-31 S2, region 2 · #556). What the run
 * view's own tests cannot show cheaply: the cost provenance rules at session
 * altitude, and the phase inference over an index slice that carries tool names
 * but no spans.
 */

const NOW = Date.UTC(2026, 7, 16, 20, 0, 0)
const LANE = '556-run-view'

function slice(overrides: Partial<LaneIndexSlice> = {}): LaneIndexSlice {
  return {
    sessionId: '900',
    startedAt: 900,
    label: null,
    recordingPresent: true,
    gap: null,
    firstTs: NOW - 10_000,
    lastTs: NOW - 5_000,
    branch: LANE,
    worktreePath: '/repo-wt/556-run-view',
    worktreeRemoved: true,
    outputTokens: 100,
    costUsd: 0,
    costIsAuthoritative: null,
    estimateSources: [],
    toolCallCount: 0,
    toolCounts: {},
    models: [],
    interactionCount: 0,
    files: [],
    commits: [],
    transcript: null,
    ...overrides,
  }
}

function entry(sessions: LaneIndexSlice[]): LaneIndexEntry {
  return {
    handle: LANE,
    issue: '556',
    aliases: [LANE],
    branch: LANE,
    worktreePath: '/repo-wt/556-run-view',
    worktreeRemoved: true,
    firstSeenAt: NOW - 10_000,
    lastSeenAt: NOW - 5_000,
    sessions,
    missingSessionIds: [],
    partialVoice: null,
  }
}

function spineOf(sessions: LaneIndexSlice[]) {
  return buildSpine({ entry: entry(sessions), state: initialSessionState(), lane: LANE, now: NOW })
}

describe('cost, at session altitude, keeps the card’s own three arms', () => {
  it('is a GAP — never $0.00 — when no dollars were counted', () => {
    const cost = spineOf([slice()])[0]?.cost
    expect(cost?.kind).toBe('gap')
    if (cost?.kind !== 'gap') throw new Error('unreachable')
    expect(cost.disclosure.why.reason).toContain('no cost record reached this lane')
    expect(cost.disclosure.remedy.kind).toBe('none')
  })

  it('says a DIFFERENT thing when the recording itself could not be read', () => {
    // Both are "no dollars", and a reader has to be able to tell "nothing was
    // spent that we could see" from "we could not look".
    const cost = spineOf([slice({ recordingPresent: false, gap: 'RECORDING MISSING for session 900' })])[0]?.cost
    if (cost?.kind !== 'gap') throw new Error('expected a gap')
    expect(cost.disclosure.why.reason).toContain('could not be read')
  })

  it('is authoritative when the CLI’s own figure covered the session', () => {
    expect(spineOf([slice({ costUsd: 0.42, costIsAuthoritative: true })])[0]?.cost).toEqual({
      kind: 'authoritative',
      usd: 0.42,
    })
  })

  it('carries the estimate’s source with it', () => {
    expect(
      spineOf([slice({ costUsd: 0.31, costIsAuthoritative: false, estimateSources: ['langfuse-prices@cfac485'] })])[0]
        ?.cost,
    ).toEqual({ kind: 'estimated', usd: 0.31, sources: ['langfuse-prices@cfac485'] })
  })
})

describe('phase is inferred from the slice’s own evidence', () => {
  it('reads reads-only as exploring', () => {
    expect(spineOf([slice({ toolCounts: { Read: 4, Grep: 1 } })])[0]?.phase.phase).toBe('exploring')
  })

  it('reads writes as implementing, outranking the reads beside them', () => {
    expect(spineOf([slice({ toolCounts: { Read: 4, Edit: 2 } })])[0]?.phase.phase).toBe('implementing')
  })

  it('reads a test command as verifying', () => {
    expect(spineOf([slice({ toolCounts: { Read: 1, Edit: 1, Bash: 3 } })])[0]?.phase.phase).toBe('verifying')
  })

  it('reads a commit as landing, whatever ran before it', () => {
    const commits = [{ sha: 'abc1234', message: 'feat: x (#556)', landedAt: NOW - 6_000, branch: LANE, fileCount: 2 }]
    expect(spineOf([slice({ toolCounts: { Read: 9 }, commits })])[0]?.phase.phase).toBe('landing')
  })

  it('says unknown rather than guessing when nothing names a phase', () => {
    const phase = spineOf([slice()])[0]?.phase
    expect(phase?.phase).toBe('unknown')
    expect(phase?.disclosure.why.evidence.fact).toContain('no tool call')
  })

  it('always marks itself inferred, in the shape the disclosure card renders', () => {
    const cases: Record<string, number>[] = [{ Read: 1 }, { Edit: 1 }, { Bash: 1 }, {}]
    for (const counts of cases) {
      const phase = spineOf([slice({ toolCounts: counts })])[0]?.phase
      expect(phase?.inferred).toBe(true)
      expect(phase?.disclosure.why.reason).toContain('not declared by the agent')
      expect(phase?.disclosure.why.evidence.elapsedMs).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('the spine is one row per recording', () => {
  it('keeps the index’s own order and marks none loaded when the fold is empty', () => {
    const rows = spineOf([slice({ sessionId: '900', startedAt: 900 }), slice({ sessionId: '1000', startedAt: 1_000 })])
    expect(rows.map((row) => row.sessionId)).toEqual(['900', '1000'])
    expect(rows.every((row) => !row.loaded)).toBe(true)
    expect(rows.every((row) => row.cards.length === 0)).toBe(true)
  })

  it('falls back to a single row for the loaded recording when there is no index', () => {
    const rows = buildSpine({ entry: null, state: initialSessionState(), lane: LANE, now: NOW })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.loaded).toBe(true)
    expect(rows[0]?.cost.kind).toBe('gap')
  })
})
