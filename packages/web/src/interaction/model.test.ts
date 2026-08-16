import {
  createEventFactory,
  fixtureTraceSpans,
  reduceAll,
  selectTraceTree,
  type RhizomorphEvent,
  type SessionState,
  type TraceTreeNode,
} from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../drawer/useTranscript.js'
import { buildInteractionCards, firstSentence, quoteFor, sumLeafDurations } from './model.js'

/**
 * THE INTERACTION CARD, as data (prd-31 ruling 6, S1 · #556).
 *
 * S1 names five things that would make this card wrong, and there is a test
 * below for each: a summarised verdict line, a placeholder for an unsourceable
 * field, a total shown for an in-flight interaction, work exceeding wall (a
 * container summed by mistake), and an estimated dollar without its flag.
 */

const LANE = '556-run-view'
const T0 = Date.UTC(2026, 7, 16, 19, 4, 12)
const WORKTREE = '/repo-wt/556-run-view'

/**
 * The capture's real shape (`fixtureTraceSpans`): an `interaction` root over an
 * `llm_request` and a `tool`, the tool over a `tool_blocked` and a
 * `tool_execution`. Wall is the root's 14.1 s; the leaves are 9,400 + 2 + 4,198.
 */
function traceState(extra: readonly RhizomorphEvent[] = []): SessionState {
  const f = createEventFactory({ startTs: T0 - 1_000, stepMs: 10, idPrefix: 'base' })
  return reduceAll([
    f.sessionStarted({ sessionId: '1000', repoPath: '/repo', repoName: 'r', mainBranch: 'main' }),
    f.worktreeDiscovered({ path: WORKTREE, branch: LANE, head: 'sha', isMain: false }),
    ...fixtureTraceSpans({ lane: LANE, sessionId: 'claude-1', startTs: T0 }),
    ...extra,
  ])
}

function rootOf(state: SessionState): TraceTreeNode {
  const tree = selectTraceTree(state, `trace-${LANE}-1`)
  const root = tree?.roots.find((candidate) => candidate.span.kind === 'interaction')
  if (root === undefined) throw new Error('fixture has no interaction root')
  return root
}

function cards(state: SessionState, entries: readonly TranscriptEntry[] = []) {
  return buildInteractionCards(state, LANE, { now: T0 + 60_000, entries })
}

describe('the time shape leads, and work is Σ LEAF spans', () => {
  const card = cards(traceState())[0]

  it('reports wall as the interaction root’s own span', () => {
    expect(card?.wallMs).toBe(14_100)
  })

  it('sums only the leaves — 9,400 + 2 + 4,198', () => {
    expect(card?.workMs).toBe(13_600)
  })

  it('reports the gap between them, which no other surface holds', () => {
    expect(card?.gapMs).toBe(500)
  })

  it('never lets work exceed wall', () => {
    expect(card?.workMs).toBeLessThanOrEqual(card?.wallMs ?? 0)
  })

  /**
   * THE MUTATION S1 ASKS FOR. `sumEverySpan` is the defect written out: it adds
   * the containers too. A container encloses its children, so its milliseconds
   * are already counted — the wrong sum is more than twice the wall clock, and
   * the assertion above goes red the moment `sumLeafDurations` is replaced by
   * it. Without this, "work ≤ wall" is a test that could not fail.
   */
  it('a rigged container-summing turns the wall/work assertion red', () => {
    const sumEverySpan = (node: TraceTreeNode): number =>
      node.span.endTs - node.span.startTs + node.children.reduce((total, child) => total + sumEverySpan(child), 0)

    const root = rootOf(traceState())
    expect(sumLeafDurations(root)).toBe(13_600)
    expect(sumEverySpan(root)).toBe(32_000)
    expect(sumEverySpan(root)).toBeGreaterThan(root.span.endTs - root.span.startTs)
  })
})

describe('the words are QUOTED, never written', () => {
  const said =
    "I'll add the plan/run split first, then wire the route. After that the index needs a test that deletes a worktree."
  const entries: TranscriptEntry[] = [
    { ts: new Date(T0 + 1_000).toISOString(), role: 'assistant', blocks: [{ kind: 'text', text: said }] },
  ]

  it('quotes the agent’s opening sentence verbatim — every character is the agent’s', () => {
    const card = cards(traceState(), entries)[0]
    expect(card?.quote?.headline).toBe("I'll add the plan/run split first, then wire the route.")
    // The strongest form of "not summarised": the headline is a PREFIX of what
    // was said. A paraphrase cannot be one.
    expect(said.startsWith(card?.quote?.headline ?? '')).toBe(true)
  })

  it('keeps the whole block behind it, for `▸ full text`', () => {
    const card = cards(traceState(), entries)[0]
    expect(card?.quote?.full).toBe(said)
    expect(card?.quote?.hasMore).toBe(true)
  })

  it('says there is no more when the agent said one sentence', () => {
    const one: TranscriptEntry[] = [
      { ts: new Date(T0 + 1_000).toISOString(), role: 'assistant', blocks: [{ kind: 'text', text: 'Done.' }] },
    ]
    const card = cards(traceState(), one)[0]
    expect(card?.quote?.headline).toBe('Done.')
    expect(card?.quote?.hasMore).toBe(false)
  })

  it('is ABSENT for an interaction with no assistant text — never an empty quote', () => {
    expect(cards(traceState())[0]?.quote).toBeNull()
    expect(
      cards(traceState(), [
        { ts: new Date(T0 + 1_000).toISOString(), role: 'user', blocks: [{ kind: 'text', text: 'do the thing' }] },
      ])[0]?.quote,
    ).toBeNull()
  })

  it('ignores a turn outside the interaction’s own window — a quote belongs to one card', () => {
    const elsewhere: TranscriptEntry[] = [
      { ts: new Date(T0 - 60_000).toISOString(), role: 'assistant', blocks: [{ kind: 'text', text: 'earlier' }] },
      { ts: new Date(T0 + 600_000).toISOString(), role: 'assistant', blocks: [{ kind: 'text', text: 'later' }] },
    ]
    expect(cards(traceState(), elsewhere)[0]?.quote).toBeNull()
  })

  it('never rewrites — `firstSentence` returns a slice of its input and nothing else', () => {
    for (const text of ['One. Two.', 'No terminator at all', 'Line one\nline two', 'Why? Because.']) {
      expect(text.startsWith(firstSentence(text))).toBe(true)
    }
  })

  it('takes the first TEXT block, skipping a turn whose blocks are all tool traffic', () => {
    const entries2: TranscriptEntry[] = [
      { ts: new Date(T0 + 500).toISOString(), role: 'assistant', blocks: [{ kind: 'tool_use', name: 'Bash', hint: 'ls' }] },
      { ts: new Date(T0 + 900).toISOString(), role: 'assistant', blocks: [{ kind: 'text', text: 'Then this.' }] },
    ]
    expect(quoteFor(entries2, T0, T0 + 14_100)?.headline).toBe('Then this.')
  })
})

describe('the facts, and only the ones we can source', () => {
  it('names the model, the tool count and the tokens from the spans themselves', () => {
    const card = cards(traceState())[0]
    expect(card?.facts.model).toBe('claude-opus-5')
    expect(card?.facts.toolCount).toBe(1)
    expect(card?.facts.tokens.output).toBe(3_100)
  })

  it('carries no field for anything unsourceable — skills, context %, check state', () => {
    const card = cards(traceState())[0]
    // The law is structural: an omitted field is honest, a blank one implies we
    // looked. If a later hand adds one of these, this fails by diff.
    expect(Object.keys(card?.facts ?? {}).sort()).toEqual(['cost', 'files', 'model', 'toolCount', 'tokens'].sort())
  })

  it('joins files by `toolUseId`, so a card claims only the files ITS calls touched', () => {
    const f = createEventFactory({ startTs: T0 + 10_000, stepMs: 10, idPrefix: 'tools' })
    const state = traceState([
      f.toolActivity({
        lane: LANE,
        branch: LANE,
        worktreePath: WORKTREE,
        sessionId: 'claude-1',
        tool: 'Bash',
        filePath: 'packages/web/src/interaction/model.ts',
        toolUseId: `toolu_${LANE}_1`,
      }),
      // A file the lane touched under a DIFFERENT tool call: real work, not
      // this card's. Attributing it here is how one card comes to claim every
      // file the lane ever changed.
      f.toolActivity({
        lane: LANE,
        branch: LANE,
        worktreePath: WORKTREE,
        sessionId: 'claude-1',
        tool: 'Edit',
        filePath: 'somewhere/else.ts',
        toolUseId: 'toolu_other',
      }),
    ])
    expect(cards(state)[0]?.facts.files).toEqual(['packages/web/src/interaction/model.ts'])
  })
})

describe('cost carries its provenance, or it is an honest gap', () => {
  function withCost(costUsd: number, authoritative: boolean, estimateSource: string | null) {
    const f = createEventFactory({ startTs: T0 + 12_000, stepMs: 10, idPrefix: 'cost' })
    return traceState([
      f.llmCost({
        lane: LANE,
        branch: LANE,
        worktreePath: WORKTREE,
        sessionId: 'claude-1',
        model: 'claude-opus-5',
        costUsd,
        authoritative,
        estimateSource,
        // The join key the span carries: `fixtureTraceSpans` stamps
        // `req-<lane>-1` on its `llm_request`.
        requestId: `req-${LANE}-1`,
      }),
    ])
  }

  it('is authoritative when the CLI computed the dollars', () => {
    expect(cards(withCost(0.31, true, null))[0]?.facts.cost).toEqual({ kind: 'authoritative', usd: 0.31 })
  })

  it('is estimated, WITH its source, when we computed them', () => {
    expect(cards(withCost(0.31, false, 'langfuse-prices@cfac485'))[0]?.facts.cost).toEqual({
      kind: 'estimated',
      usd: 0.31,
      sources: ['langfuse-prices@cfac485'],
    })
  })

  it('is a gap — never `$0.00` — when nothing joins a dollar to this interaction', () => {
    const cost = cards(traceState())[0]?.facts.cost
    expect(cost?.kind).toBe('gap')
    if (cost?.kind !== 'gap') throw new Error('unreachable')
    expect(cost.disclosure.why.reason).toContain('no dollars')
    expect(cost.disclosure.why.evidence.fact).toContain('request id')
    // A remedy of `none` WITH a reason, never a silently missing third line.
    expect(cost.disclosure.remedy.kind).toBe('none')
  })

  it('will not take a cost record whose request id this interaction never named', () => {
    const f = createEventFactory({ startTs: T0 + 12_000, stepMs: 10, idPrefix: 'other' })
    const state = traceState([
      f.llmCost({
        lane: LANE,
        sessionId: 'claude-1',
        model: 'claude-opus-5',
        costUsd: 99,
        authoritative: true,
        requestId: 'req-someone-else',
      }),
    ])
    expect(cards(state)[0]?.facts.cost.kind).toBe('gap')
  })
})

describe('refusals are first-class, and phase is derived', () => {
  it('renders the decision on a tool call that stopped on a human', () => {
    const card = cards(traceState())[0]
    // The capture's own shape: a pre-allowed tool reports `unknown` — nobody
    // was asked — and that is a real value, not an absence.
    expect(card?.refusals).toHaveLength(1)
    expect(card?.refusals[0]?.decision).toBe('unknown')
    expect(card?.refusals[0]?.toolName).toBe('Bash')
  })

  it('infers a phase from what ran, and says the inference out loud', () => {
    const card = cards(traceState())[0]
    // `Bash` is the fixture's only tool: a test command reads as verifying.
    expect(card?.phase.phase).toBe('verifying')
    expect(card?.phase.inferred).toBe(true)
    expect(card?.phase.disclosure.why.reason).toContain('not declared by the agent')
    expect(card?.phase.disclosure.why.evidence.fact).toContain('Bash')
  })

  it('outranks every tool with a commit — landing is what actually happened', () => {
    const f = createEventFactory({ startTs: T0 + 5_000, stepMs: 10, idPrefix: 'commit' })
    const state = traceState([
      f.commitLanded({
        branch: LANE,
        sha: 'abc1234',
        message: 'feat: the run view (#556)',
        files: [{ path: 'a.ts', status: 'modified' }],
        worktreePath: WORKTREE,
      }),
    ])
    expect(cards(state)[0]?.phase.phase).toBe('landing')
  })
})

describe('an in-flight interaction shows no total', () => {
  it('marks a forest whose interaction root has not exported yet', () => {
    // Spans export on END, so the root of a still-open interaction is missing
    // and its children arrive as orphans. Dropping the root from the fixture is
    // exactly that state.
    const f = createEventFactory({ startTs: T0 - 1_000, stepMs: 10, idPrefix: 'live' })
    const spans = fixtureTraceSpans({ lane: LANE, sessionId: 'claude-1', startTs: T0 }).filter(
      (event) => event.payload.kind !== 'interaction',
    )
    const state = reduceAll([
      f.sessionStarted({ sessionId: '1000', repoPath: '/repo', repoName: 'r', mainBranch: 'main' }),
      ...spans,
    ])
    const open = cards(state)
    expect(open.length).toBeGreaterThan(0)
    expect(open.every((card) => card.inFlight)).toBe(true)
  })

  it('is not in flight once the root has landed', () => {
    expect(cards(traceState())[0]?.inFlight).toBe(false)
  })
})
