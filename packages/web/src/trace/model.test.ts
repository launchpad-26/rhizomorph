import { fixtureTraceSpans, initialSessionState, reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { flattenDescendants, selectLaneInteractionViews, sumLeafDurationsMs } from './model.js'

describe('selectLaneInteractionViews', () => {
  it('zips each interaction summary with its own span tree, newest first', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    const [view] = selectLaneInteractionViews(state, '2-core')

    expect(view).toBeDefined()
    expect(view?.summary.traceId).toBe('trace-2-core-1')
    expect(view?.root.span.kind).toBe('interaction')
    expect(view?.root.children.map((node) => node.span.kind)).toEqual(['llm_request', 'tool'])
  })

  it('is honestly empty for a lane the log never mentioned', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    expect(selectLaneInteractionViews(state, '3-git')).toEqual([])
  })

  it('is honestly empty for an untouched state', () => {
    expect(selectLaneInteractionViews(initialSessionState(), '2-core')).toEqual([])
  })
})

describe('sumLeafDurationsMs', () => {
  it('sums only leaf spans — a container and its own children never double-count', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    const [view] = selectLaneInteractionViews(state, '2-core')

    // llm_request (leaf, 9_400ms) + tool_blocked (leaf, 2ms) + tool_execution
    // (leaf, 4_198ms) — the `tool` container's own 4_300ms span is never added
    // on top of its children's.
    expect(view && sumLeafDurationsMs(view.root)).toBe(9_400 + 2 + 4_198)
    expect(view?.summary.wallDurationMs).toBe(14_100)
  })

  it('is the span\'s own duration for a childless node', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    const [view] = selectLaneInteractionViews(state, '2-core')
    const llmNode = view?.root.children.find((node) => node.span.kind === 'llm_request')

    expect(llmNode && sumLeafDurationsMs(llmNode)).toBe(9_400)
  })
})

describe('flattenDescendants', () => {
  it('flattens depth-first in the tree\'s own startTs order, root excluded', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    const [view] = selectLaneInteractionViews(state, '2-core')
    const rows = view ? flattenDescendants(view.root) : []

    expect(rows.map((row) => [row.node.span.kind, row.depth])).toEqual([
      ['llm_request', 1],
      ['tool', 1],
      ['tool_blocked', 2],
      ['tool_execution', 2],
    ])
  })

  it('is empty for a leaf root', () => {
    const state = reduceAll(fixtureTraceSpans({ lane: '2-core' }))
    const [view] = selectLaneInteractionViews(state, '2-core')
    const llmNode = view?.root.children.find((node) => node.span.kind === 'llm_request')

    expect(llmNode && flattenDescendants(llmNode)).toEqual([])
  })
})
