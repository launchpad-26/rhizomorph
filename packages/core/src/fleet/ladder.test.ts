import { describe, expect, it } from 'vitest'
import { createEventFactory } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import type { CalmEvidence, Lane } from './types.js'
import { buildLadder } from './ladder.js'

const f = createEventFactory()
const NOW = 100_000

const NO_LANES: readonly Lane[] = []
const NO_COLLISIONS: readonly [] = []
const EVIDENCE: CalmEvidence = {
  lanes: 0,
  working: 0,
  branchesChecked: 0,
  filesChecked: 0,
  collisions: 0,
  line: 'collisions: 0 — checked 0 branches / 0 files',
}

/** The one broken-collector item `buildLadder` produces, or fails the test if there isn't exactly one. */
function collectorItem(state: ReturnType<typeof reduceAll>) {
  const ladder = buildLadder(NO_LANES, NO_COLLISIONS, state, NOW, EVIDENCE)
  expect(ladder.items).toHaveLength(1)
  return ladder.items[0]!
}

describe('buildLadder — ruling 15, a broken collector on the strip', () => {
  it("renders the collector's own message when it has one", () => {
    const state = reduceAll([f.collectorError({ collector: 'git', message: 'exit 128' }, { ts: 10 })])
    expect(collectorItem(state).evidence).toBe('exit 128')
  })

  it('appends (×N) using the freshest ErrorRecord\'s own coalesced count — the same convention the feed row uses (#530)', () => {
    const state = reduceAll([
      f.collectorError({ collector: 'otel', message: 'malformed OTLP request body', count: 12 }, { ts: 10 }),
      f.collectorError({ collector: 'otel', message: 'malformed OTLP request body', count: 5 }, { ts: 20 }),
    ])
    // The freshest record's own count (5), not the collector's lifetime
    // errorCount (17) — the same distinction the feed row draws per event.
    expect(collectorItem(state).evidence).toBe('malformed OTLP request body (×5)')
  })

  it('renders the bare message with no (×N) when the freshest occurrence was not coalesced', () => {
    const state = reduceAll([
      f.collectorError({ collector: 'git', message: 'boom' }, { ts: 10 }),
      f.collectorError({ collector: 'git', message: 'boom again' }, { ts: 20 }),
    ])
    expect(collectorItem(state).evidence).toBe('boom again')
  })

  it('an empty message falls through to the errorCount fallback, not blank evidence — the schema allows z.string(), not nonEmptyString (#588)', () => {
    // Mutation this test would catch: reverting `||` to `??` here passes
    // vacuously for every OTHER case in this file (a non-empty string is
    // truthy either way) and only fails on this one — an empty string is
    // exactly the value `??` treats as present and `||` treats as absent.
    const state = reduceAll([f.collectorError({ collector: 'workmux', message: '' }, { ts: 10 })])
    expect(collectorItem(state).evidence).toBe('1 errors')
  })

  it('an empty message on a coalesced burst still gets its own (×N), on top of the errorCount fallback', () => {
    const state = reduceAll([
      f.collectorError({ collector: 'workmux', message: '', count: 9 }, { ts: 10 }),
    ])
    expect(collectorItem(state).evidence).toBe('9 errors (×9)')
  })

  it('degrades to no (×N) — never a crash or a fabricated count — when the collector\'s own ErrorRecord has been evicted past MAX_ERRORS', () => {
    // `state.errors` is one arrival-order list shared by every collector
    // (MAX_ERRORS = 200, reduce.ts), so a collector's own fault can be pushed
    // out by 200 later faults from an unrelated collector while its
    // `CollectorState` — updated on every event, never capped — still reads
    // 'error'. `latestErrorFor` finds nothing for it and must fall back
    // honestly, not throw and not invent a count.
    const flood = Array.from({ length: 200 }, (_, i) => f.collectorError({ collector: 'flood', message: `f${i}` }, { ts: i + 1 }))
    const state = reduceAll([
      f.collectorError({ collector: 'target', message: 'evicted eventually' }, { ts: 0 }),
      ...flood,
    ])
    expect(state.errors.some((error) => error.collector === 'target')).toBe(false)
    expect(state.collectors['target']?.status).toBe('error')

    const ladder = buildLadder(NO_LANES, NO_COLLISIONS, state, NOW, EVIDENCE)
    const target = ladder.items.find((item) => item.id === 'collector:target')
    expect(target?.evidence).toBe('evicted eventually')
  })
})
