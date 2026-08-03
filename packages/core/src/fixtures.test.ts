import { describe, expect, it } from 'vitest'
import * as core from './index.js'
import {
  FIXTURE_NOW,
  FIXTURE_START_TS,
  createEventFactory,
  fixtureSession,
  fixtureTraceSpans,
  makeEvent,
} from './fixtures.js'
import { rhizomorphEventSchema } from './events/index.js'
import { reduceAll } from './reduce.js'
import { selectCollisions } from './selectors/collisions.js'
import { selectFlatlinedPanes } from './selectors/liveness.js'

describe('the fixture factory', () => {
  it('fills in a plausible payload so a test can name only what it cares about', () => {
    const event = createEventFactory().commitLanded({ sha: 'c9' })
    expect(event.payload.sha).toBe('c9')
    expect(event.payload.branch).toBe('feature')
    expect(rhizomorphEventSchema.safeParse(event).success).toBe(true)
  })

  it('ticks its own clock and numbers its own ids', () => {
    const f = createEventFactory({ startTs: 1000, stepMs: 250, idPrefix: 'fx' })
    const first = f.paneActivity({ contentHash: 'a' })
    const second = f.paneActivity({ contentHash: 'b' })
    expect([first.id, second.id]).toEqual(['fx-000001', 'fx-000002'])
    expect([first.ts, second.ts]).toEqual([1000, 1250])
    expect(f.now()).toBe(1500)
  })

  it('lets a test pin the clock without disturbing the sequence', () => {
    const f = createEventFactory({ startTs: 1000, stepMs: 100 })
    f.paneActivity({ contentHash: 'a' })
    const pinned = f.paneActivity({ contentHash: 'b' }, { ts: 50_000 })
    const after = f.paneActivity({ contentHash: 'c' })
    expect(pinned.ts).toBe(50_000)
    expect(after.ts).toBe(1100)
    expect(f.at(9000).advance(1000).now()).toBe(10_000)
  })

  it('remembers everything it made, and can forget it', () => {
    const f = createEventFactory()
    f.sessionStarted()
    f.paneClosed()
    expect(f.all()).toHaveLength(2)
    expect(f.reset().all()).toEqual([])
    expect(f.sessionStarted().id).toBe('evt-000001')
  })

  it('makeEvent produces a validated one-off with a stable id', () => {
    const event = makeEvent('pane.closed', { paneId: '%4' }, { ts: 77 })
    expect(event).toEqual({
      id: 'evt-pane.closed-77',
      ts: 77,
      source: 'tmux',
      type: 'pane.closed',
      payload: { paneId: '%4' },
    })
  })

  it('validates fixture payloads too — a stale fixture must fail loudly', () => {
    // @ts-expect-error — status is an enum, not free text
    expect(() => createEventFactory().agentStatus({ status: 'vibing' })).toThrow()
  })
})

describe('fixtureSession', () => {
  const events = fixtureSession()

  it('is deterministic — two calls give identical logs', () => {
    expect(fixtureSession()).toEqual(events)
  })

  it('validates end to end', () => {
    for (const event of events) {
      expect(rhizomorphEventSchema.safeParse(event).success, event.type).toBe(true)
    }
    expect(events[0]?.ts).toBe(FIXTURE_START_TS)
  })

  it('contains the two collisions it advertises', () => {
    const collisions = selectCollisions(reduceAll(events))
    expect(collisions.map((entry) => entry.path)).toEqual([
      'packages/core/src/index.ts',
      'docs/architecture.md',
    ])
    expect(collisions[0]?.branches).toEqual(['2-core', '3-git', '7-web'])
    expect(collisions[1]?.branches).toEqual(['2-core', '3-git'])
  })

  it('contains the one flatlined agent it advertises', () => {
    const flatlined = selectFlatlinedPanes(reduceAll(events), { now: FIXTURE_NOW })
    expect(flatlined.map((pane) => pane.paneId)).toEqual(['%3'])
    // Silent since roughly t+1m, measured at FIXTURE_NOW = t+10m.
    expect(flatlined[0]?.idleMs).toBeGreaterThan(8 * 60_000)
  })
})

describe('fixtureTraceSpans', () => {
  const spans = fixtureTraceSpans()

  it('is deterministic — two calls give identical logs', () => {
    expect(fixtureTraceSpans()).toEqual(spans)
  })

  it('validates end to end', () => {
    for (const event of spans) {
      expect(rhizomorphEventSchema.safeParse(event).success, event.payload.name).toBe(true)
    }
  })

  it('is the tree the capture found, delivered leaves-first', () => {
    expect(spans.map((event) => event.payload.name)).toEqual([
      'claude_code.llm_request',
      'claude_code.tool.blocked_on_user',
      'claude_code.tool.execution',
      'claude_code.tool',
      'claude_code.interaction',
    ])
    // Export-on-end: every envelope ts follows its span's end, and the root's
    // is last of all.
    for (const event of spans) {
      expect(event.ts).toBeGreaterThan(event.payload.endTs)
    }
    expect(spans[spans.length - 1]?.ts).toBe(Math.max(...spans.map((event) => event.ts)))
  })

  it('puts tokens on the llm_request span and nowhere else', () => {
    const withTokens = spans.filter((event) => event.payload.tokens != null)
    expect(withTokens.map((event) => event.payload.kind)).toEqual(['llm_request'])
  })

  it('takes a lane, a session and a trace id, so a test can build a fleet', () => {
    const other = fixtureTraceSpans({ lane: '7-web', traceId: 'trace-x', idPrefix: 'web-span' })
    expect(new Set(other.map((event) => event.payload.lane))).toEqual(new Set(['7-web']))
    expect(new Set(other.map((event) => event.payload.traceId))).toEqual(new Set(['trace-x']))
    expect(new Set(other.map((event) => event.payload.sessionId))).toEqual(new Set(['sess-7-web']))
    expect(other[0]?.id).toBe('web-span-000001')
  })
})

describe('the package barrel', () => {
  it('exports everything wave-2 packages build against', () => {
    for (const name of [
      'rhizomorphEventSchema',
      'createEvent',
      'parseEvent',
      'createIdFactory',
      'reduce',
      'reduceAll',
      'initialSessionState',
      'eventToLine',
      'lineToEvent',
      'parseJsonl',
      'eventsToJsonl',
      'selectWorktreeViews',
      'selectWorktreeIndex',
      'selectCollisionMap',
      'selectCollisions',
      'selectPaneLiveness',
      'selectWorktreeLiveness',
      'selectAheadOfMain',
      'selectBranches',
      'selectCommits',
      'createEventFactory',
      'fixtureSession',
      'fixtureTraceSpans',
      'makeEvent',
      'traceSpanPayloadSchema',
      'spanKindSchema',
      'initialTraceState',
      'DEFAULT_FLATLINE_MS',
    ] as const) {
      expect(core[name], `@rhizomorph/core should export ${name}`).toBeDefined()
    }
  })
})
