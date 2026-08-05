import { describe, expect, it } from 'vitest'
import { FIXTURE_START_TS, createEventFactory, fixtureTraceSpans } from '../fixtures.js'
import type { EventOf, PayloadOf } from '../events/index.js'
import { reduceAll } from '../reduce.js'
import { initialSessionState, type SessionState, type SpanRecord } from '../state.js'
import { selectLaneInteractions, selectTraceTree, selectWaitingOnHuman } from './traces.js'

/**
 * prd9 wave A. `fixtureTraceSpans` gives the real capture shape (research §1);
 * the subagent tree below is hand-built because no existing fixture nests one
 * — the capture's own note that "subagents nest inside the Agent tool's
 * `execution` span" (research §1) has no fixture precedent to reuse.
 */

const WT = (name: string) => `/repo/rhizomorph-wt/${name}`

/**
 * `claude_code.interaction` → a top-level `llm_request` and a `Task` tool
 * call → the tool's `execution` span → a subagent `llm_request` nested
 * inside it, carrying `agentId`. Mirrors research §1's nesting note; no
 * `tool_blocked`/other noise so the two `llm_request`s are easy to reason
 * about.
 */
function subagentTraceSpans(lane = '2-core'): EventOf<'trace.span'>[] {
  const t0 = FIXTURE_START_TS
  const f = createEventFactory({ idPrefix: `subagent-${lane}` })
  const traceId = `trace-subagent-${lane}`
  const place = {
    lane,
    role: 'worker' as const,
    sessionId: `sess-${lane}`,
    worktreePath: WT(lane),
    branch: lane,
  }
  const span = (
    payload: Omit<
      PayloadOf<'trace.span'>,
      'lane' | 'role' | 'sessionId' | 'worktreePath' | 'branch' | 'traceId'
    >,
  ) => f.make('trace.span', { ...place, traceId, ...payload }, { ts: payload.endTs + 1_000 })

  const root = 'root'
  const task = 'task'
  const taskExecution = 'task-execution'

  const topLlm = span({
    spanId: 'top-llm',
    parentSpanId: root,
    name: 'claude_code.llm_request',
    kind: 'llm_request',
    startTs: t0 + 100,
    endTs: t0 + 2_000,
    status: 'ok',
    model: 'claude-opus-5',
    tokens: { input: 1, output: 100, cacheRead: 0, cacheCreation: 0 },
    ttftMs: 300,
    requestId: 'req-top',
  })
  const taskSpan = span({
    spanId: task,
    parentSpanId: root,
    name: 'claude_code.tool',
    kind: 'tool',
    startTs: t0 + 2_100,
    endTs: t0 + 9_000,
    status: 'ok',
    toolName: 'Task',
    toolUseId: 'toolu-task',
    subagentType: 'general-purpose',
  })
  const taskExecutionSpan = span({
    spanId: taskExecution,
    parentSpanId: task,
    name: 'claude_code.tool.execution',
    kind: 'tool_execution',
    startTs: t0 + 2_200,
    endTs: t0 + 8_900,
    status: 'ok',
    toolName: 'Task',
  })
  const subagentLlm = span({
    spanId: 'subagent-llm',
    parentSpanId: taskExecution,
    name: 'claude_code.llm_request',
    kind: 'llm_request',
    startTs: t0 + 3_000,
    endTs: t0 + 8_000,
    status: 'ok',
    model: 'claude-opus-5',
    tokens: { input: 2, output: 500, cacheRead: 1_000, cacheCreation: 50 },
    ttftMs: 900,
    requestId: 'req-sub',
    agentId: 'agent-1',
  })
  const interaction = span({
    spanId: root,
    parentSpanId: null,
    name: 'claude_code.interaction',
    kind: 'interaction',
    startTs: t0,
    endTs: t0 + 9_100,
    status: 'ok',
  })

  // Leaves-first order, same as the real exporter and `fixtureTraceSpans`.
  return [topLlm, taskExecutionSpan, subagentLlm, taskSpan, interaction]
}

// --- selectTraceTree ---------------------------------------------------------

describe('selectTraceTree', () => {
  it('returns null for a trace the log never saw', () => {
    expect(selectTraceTree(initialSessionState(), 'trace-nobody-sent')).toBeNull()
  })

  it('nests the capture-shaped tree under its real parents', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    const tree = selectTraceTree(state, 'trace-2-core-1')
    expect(tree).not.toBeNull()
    expect(tree?.roots).toHaveLength(1)

    const root = tree!.roots[0]!
    expect(root.span.kind).toBe('interaction')
    // Children sorted by startTs: the llm_request starts well before the tool.
    expect(root.children.map((node) => node.span.kind)).toEqual(['llm_request', 'tool'])

    const toolNode = root.children.find((node) => node.span.kind === 'tool')!
    expect(toolNode.children.map((node) => node.span.kind)).toEqual([
      'tool_blocked',
      'tool_execution',
    ])
    expect(toolNode.children.flatMap((node) => node.children)).toEqual([])
  })

  it('treats a span whose parent has not arrived yet as a root — orphans are normal mid-stream', () => {
    const f = createEventFactory()
    const event = f.traceSpan({
      traceId: 'trace-orphan',
      spanId: 'child-1',
      parentSpanId: 'root-still-open',
      kind: 'tool',
      name: 'claude_code.tool',
      toolName: 'Bash',
    })
    const state = reduceAll([event])
    const tree = selectTraceTree(state, 'trace-orphan')

    expect(tree?.roots).toHaveLength(1)
    expect(tree?.roots[0]?.span.spanId).toBe('child-1')
    expect(tree?.roots[0]?.children).toEqual([])
  })

  it('allows more than one independent root in the same trace', () => {
    const f = createEventFactory()
    const a = f.traceSpan({
      traceId: 'trace-multi',
      spanId: 'a',
      parentSpanId: null,
      startTs: FIXTURE_START_TS,
      endTs: FIXTURE_START_TS + 100,
    })
    const b = f.traceSpan({
      traceId: 'trace-multi',
      spanId: 'b',
      parentSpanId: null,
      startTs: FIXTURE_START_TS + 50,
      endTs: FIXTURE_START_TS + 150,
    })
    const state = reduceAll([a, b])
    const tree = selectTraceTree(state, 'trace-multi')

    expect(tree?.roots.map((node) => node.span.spanId)).toEqual(['a', 'b'])
  })

  it('nests a subagent llm_request under the Agent tool\'s execution span', () => {
    const state = reduceAll(subagentTraceSpans())
    const tree = selectTraceTree(state, 'trace-subagent-2-core')
    expect(tree?.roots).toHaveLength(1)

    const root = tree!.roots[0]!
    expect(root.children.map((node) => node.span.spanId)).toEqual(['top-llm', 'task'])
    const task = root.children.find((node) => node.span.spanId === 'task')!
    const execution = task.children[0]!
    expect(execution.span.kind).toBe('tool_execution')
    expect(execution.children.map((node) => node.span.spanId)).toEqual(['subagent-llm'])
    expect(execution.children[0]?.span.agentId).toBe('agent-1')
  })

  it('is unaffected by a re-delivered tree — the fold already dedups on (traceId, spanId)', () => {
    const tree = fixtureTraceSpans({ lane: '2-core' })
    const state = reduceAll([...tree, ...tree])
    const result = selectTraceTree(state, 'trace-2-core-1')

    expect(result?.roots).toHaveLength(1)
    expect(result?.roots[0]?.children).toHaveLength(2)
  })
})

// --- selectLaneInteractions ---------------------------------------------------

describe('selectLaneInteractions', () => {
  it('returns nothing for a lane the log never mentioned', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    expect(selectLaneInteractions(state, '3-git')).toEqual([])
  })

  it('summarises one interaction: wall duration, llm count, tool calls, ttft, tokens', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    const [summary] = selectLaneInteractions(state, '2-core')

    expect(summary).toMatchObject({
      traceId: 'trace-2-core-1',
      kind: 'interaction',
      startTs: FIXTURE_START_TS,
      endTs: FIXTURE_START_TS + 14_100,
      wallDurationMs: 14_100,
      llmRequestCount: 1,
      toolCallCounts: { Bash: 1 },
      firstLlmTtftMs: 1_400,
      tokens: { input: 4, output: 3_100, cacheRead: 180_000, cacheCreation: 6_400 },
    })
    // Never an unlabelled all-tier total riding alongside the split.
    expect(summary?.tokens).not.toHaveProperty('total')
  })

  it('counts a subagent llm_request nested under the Agent tool, recursively', () => {
    const state = reduceAll(subagentTraceSpans())
    const [summary] = selectLaneInteractions(state, '2-core')

    expect(summary?.llmRequestCount).toBe(2)
    expect(summary?.toolCallCounts).toEqual({ Task: 1 })
    // The top-level request starts first, so its own ttft wins.
    expect(summary?.firstLlmTtftMs).toBe(300)
    expect(summary?.tokens).toEqual({ input: 3, output: 600, cacheRead: 1_000, cacheCreation: 50 })
  })

  it('sums tokens ONLY from llm_request spans — a smuggled tokens field on tool/interaction contributes nothing', () => {
    const t0 = FIXTURE_START_TS
    const f = createEventFactory({ idPrefix: 'smuggle' })
    const traceId = 'trace-smuggle'
    const place = { lane: '2-core', role: 'worker' as const }
    const smuggled = { input: 999, output: 999, cacheRead: 999, cacheCreation: 999 }
    const span = (
      payload: Omit<PayloadOf<'trace.span'>, 'lane' | 'role' | 'traceId'>,
    ) => f.make('trace.span', { ...place, traceId, ...payload }, { ts: payload.endTs + 1_000 })

    const llm = span({
      spanId: 'llm',
      parentSpanId: 'root',
      name: 'claude_code.llm_request',
      kind: 'llm_request',
      startTs: t0 + 10,
      endTs: t0 + 500,
      status: 'ok',
      tokens: { input: 5, output: 50, cacheRead: 10, cacheCreation: 2 },
      ttftMs: 120,
    })
    const tool = span({
      spanId: 'tool',
      parentSpanId: 'root',
      name: 'claude_code.tool',
      kind: 'tool',
      startTs: t0 + 20,
      endTs: t0 + 600,
      status: 'ok',
      toolName: 'Bash',
      // The schema permits `tokens` on any kind — a `tool` span reporting
      // some is not a real model request and must not be counted.
      tokens: smuggled,
    })
    const root = span({
      spanId: 'root',
      parentSpanId: null,
      name: 'claude_code.interaction',
      kind: 'interaction',
      startTs: t0,
      endTs: t0 + 700,
      status: 'ok',
      tokens: smuggled,
    })

    const state = reduceAll([llm, tool, root])
    const [summary] = selectLaneInteractions(state, '2-core')

    expect(summary?.tokens).toEqual({ input: 5, output: 50, cacheRead: 10, cacheCreation: 2 })
  })

  it('reports multiple traces for a lane, newest first', () => {
    const state = reduceAll([
      ...fixtureTraceSpans({ lane: '2-core', traceId: 'trace-1', startTs: FIXTURE_START_TS }),
      ...fixtureTraceSpans({
        lane: '2-core',
        traceId: 'trace-2',
        startTs: FIXTURE_START_TS + 100_000,
        idPrefix: 'span-2-core-b',
      }),
    ])
    const summaries = selectLaneInteractions(state, '2-core')
    expect(summaries.map((summary) => summary.traceId)).toEqual(['trace-2', 'trace-1'])
  })

  it('ignores spans from other lanes riding in a shared log', () => {
    const state = reduceAll([
      ...fixtureTraceSpans({ lane: '2-core' }),
      ...fixtureTraceSpans({ lane: '3-git' }),
    ])
    const summaries = selectLaneInteractions(state, '2-core')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.traceId).toBe('trace-2-core-1')
  })
})

// --- selectWaitingOnHuman -----------------------------------------------------

describe('selectWaitingOnHuman', () => {
  it('reports honest nothing for a state with no blocked spans', () => {
    expect(selectWaitingOnHuman(initialSessionState())).toEqual({
      totalWaitMs: 0,
      waitCount: 0,
      decisions: { accept: 0, reject: 0, unknown: 0 },
      longestWait: null,
    })
  })

  it("counts the capture's real unknown decision — a pre-allowed tool, nobody asked", () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    expect(selectWaitingOnHuman(state)).toEqual({
      totalWaitMs: 2,
      waitCount: 1,
      decisions: { accept: 0, reject: 0, unknown: 1 },
      longestWait: {
        waitMs: 2,
        toolName: 'Bash',
        lane: '2-core',
        traceId: 'trace-2-core-1',
        spanId: 'trace-2-core-1-blocked',
      },
    })
  })

  it('filters by lane', () => {
    const state = reduceAll([
      ...fixtureTraceSpans({ lane: '2-core' }),
      ...fixtureTraceSpans({ lane: '3-git' }),
    ])
    expect(selectWaitingOnHuman(state, { lane: '3-git' }).longestWait?.lane).toBe('3-git')
    expect(selectWaitingOnHuman(state, { lane: '3-git' }).waitCount).toBe(1)
    expect(selectWaitingOnHuman(state).waitCount).toBe(2)
  })

  it('tallies a real census and finds the single longest wait across accept/reject/unknown', () => {
    const t0 = FIXTURE_START_TS
    const f = createEventFactory({ idPrefix: 'waits' })
    const place = { lane: '2-core', role: 'worker' as const }
    const span = (
      payload: Omit<PayloadOf<'trace.span'>, 'lane' | 'role'>,
    ) => f.make('trace.span', { ...place, ...payload }, { ts: payload.endTs + 1_000 })

    const accepted = span({
      traceId: 'trace-waits',
      spanId: 'accepted',
      parentSpanId: null,
      name: 'claude_code.tool.blocked_on_user',
      kind: 'tool_blocked',
      startTs: t0,
      endTs: t0 + 5_000,
      status: 'ok',
      decision: 'accept',
      toolName: 'Bash',
    })
    const rejected = span({
      traceId: 'trace-waits',
      spanId: 'rejected',
      parentSpanId: null,
      name: 'claude_code.tool.blocked_on_user',
      kind: 'tool_blocked',
      startTs: t0,
      endTs: t0 + 12_000,
      status: 'ok',
      decision: 'reject',
      toolName: 'Write',
    })
    const unknown = span({
      traceId: 'trace-waits',
      spanId: 'unknown',
      parentSpanId: null,
      name: 'claude_code.tool.blocked_on_user',
      kind: 'tool_blocked',
      startTs: t0,
      endTs: t0 + 1,
      status: 'ok',
      decision: 'unknown',
      toolName: 'Read',
    })

    const state = reduceAll([accepted, rejected, unknown])
    const summary = selectWaitingOnHuman(state)

    expect(summary.waitCount).toBe(3)
    expect(summary.decisions).toEqual({ accept: 1, reject: 1, unknown: 1 })
    expect(summary.totalWaitMs).toBe(5_000 + 12_000 + 1)
    expect(summary.longestWait).toEqual({
      waitMs: 12_000,
      toolName: 'Write',
      lane: '2-core',
      traceId: 'trace-waits',
      spanId: 'rejected',
    })
  })

  it('is retrospective: a wait still open has no span yet, so it reports as if it never happened', () => {
    // Only the tool call itself has exported so far — the permission wait is
    // still open and has not ended, so no `tool_blocked` span exists for it.
    // Ruling 6: this selector cannot and must not report it as live waiting.
    const f = createEventFactory()
    const state = reduceAll([
      f.traceSpan({
        traceId: 'trace-open',
        spanId: 'tool-open',
        parentSpanId: null,
        kind: 'tool',
        name: 'claude_code.tool',
        toolName: 'Bash',
      }),
    ])
    expect(selectWaitingOnHuman(state)).toEqual({
      totalWaitMs: 0,
      waitCount: 0,
      decisions: { accept: 0, reject: 0, unknown: 0 },
      longestWait: null,
    })
  })
})

/**
 * #184 — selector compatibility, proven rather than asserted.
 *
 * The trace fold stopped accumulating `byTrace`/`bySession` a Record copy at a
 * time and now derives them from `spans` on demand (`traceStateOf` in
 * `state.ts`). Every selector in this file reads one or both, so "no selector
 * moves" is a claim that has to be *shown*, on a state big enough to have an
 * opinion: many traces, many lanes, several sessions, spans with no session at
 * all, a re-delivery, and the nested subagent shape.
 *
 * The reference is the removed line itself. `accumulatedTraces` folds the same
 * spans into a plain, eagerly-built slice exactly as the fold used to, and
 * every selector answers both states. The comparison is `JSON.stringify`, not
 * `toEqual`: order inside a waterfall's children, inside a summary list and
 * inside a `toolCallCounts` Record is part of the answer, and bytes are the
 * only comparison that reads all of it.
 */
describe('law — the trace selectors cannot tell how the indexes were built (#184)', () => {
  /** The pre-#184 slice: `byTrace`/`bySession` accumulated, then held. */
  function accumulatedTraces(spans: readonly SpanRecord[]): SessionState['traces'] {
    let byTrace: Record<string, number[]> = {}
    let bySession: Record<string, number[]> = {}
    spans.forEach((span, at) => {
      byTrace = { ...byTrace, [span.traceId]: [...(byTrace[span.traceId] ?? []), at] }
      if (span.sessionId !== null) {
        bySession = { ...bySession, [span.sessionId]: [...(bySession[span.sessionId] ?? []), at] }
      }
    })
    return { spans: [...spans], byTrace, bySession }
  }

  /** Two lanes' capture-shaped traces, a subagent tree, and the awkward edges. */
  function realMix(): EventOf<'trace.span'>[] {
    const f = createEventFactory({ idPrefix: 'mix' })
    const anon = f.traceSpan({
      traceId: 'trace-2-core-1',
      spanId: 'orphan-no-session',
      parentSpanId: 'never-arrives',
      sessionId: null,
      lane: '2-core',
      kind: 'llm_request',
      name: 'claude_code.llm_request',
      tokens: { input: 7, output: 70, cacheRead: 700, cacheCreation: 7 },
      ttftMs: 90,
    })
    const spans = [
      ...fixtureTraceSpans({ lane: '2-core' }),
      ...fixtureTraceSpans({ lane: '3-git' }),
      ...subagentTraceSpans('2-core'),
      anon,
      // A second interaction on a lane that already has one, so the newest-first
      // ordering has something to order.
      ...fixtureTraceSpans({ lane: '2-core', traceId: 'trace-2-core-2', idPrefix: 'second' }),
    ]
    // A re-delivery: folds to nothing, and must leave every answer alone.
    return [...spans, spans[0] as EventOf<'trace.span'>]
  }

  it('answers byte-identically against an eagerly accumulated slice', () => {
    const derived = reduceAll(realMix())
    const eager: SessionState = { ...derived, traces: accumulatedTraces(derived.traces.spans) }

    // The state the selectors read really is the awkward one it claims to be.
    expect(derived.traces.spans.length).toBeGreaterThan(15)
    expect(Object.keys(derived.traces.byTrace).length).toBeGreaterThan(3)
    expect(JSON.stringify(eager.traces)).toBe(JSON.stringify(derived.traces))

    const lanes = ['2-core', '3-git', 'lane-that-never-existed']
    const answers = (state: SessionState): string =>
      JSON.stringify({
        // The waterfall tree, per trace — including one the log never saw.
        trees: [...Object.keys(state.traces.byTrace), 'trace-nobody-sent'].map((traceId) =>
          selectTraceTree(state, traceId),
        ),
        // The span sums and exemplar picks: llm counts, tool tallies, the
        // first-ttft pick and the four token tiers, per lane.
        interactions: lanes.map((lane) => selectLaneInteractions(state, lane)),
        // The retrospective wait totals, unfiltered and per lane — its
        // `longestWait` is the other exemplar pick in this file.
        waiting: [selectWaitingOnHuman(state), ...lanes.map((lane) => selectWaitingOnHuman(state, { lane }))],
      })

    expect(answers(eager)).toBe(answers(derived))
    // Not vacuous: the selectors actually found the mix.
    expect(answers(derived)).toContain('llmRequestCount')
    expect(answers(derived)).toContain('longestWait')
  })
})
