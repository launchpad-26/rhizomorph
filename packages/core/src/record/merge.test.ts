import { describe, expect, it } from 'vitest'
import { createEventFactory, FIXTURE_START_TS } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import { buildRecord } from './build.js'
import { mergeRecords } from './merge.js'
import { withLinesAt } from './read.test.js'

const REPO_SLUG = 'rhizomorph-abc123'

/** A line the way a NEWER era's instrument would write it — prd17 ruling 1's own families. */
const FUTURE_LINE =
  '{"id":"evt-future-1","ts":1785930000000,"source":"system","type":"summons.raised","payload":{"lane":"a"}}'

function actorRecord(instance: string, handle: string, startTs: number, lane: string) {
  const f = createEventFactory({ idPrefix: 'evt', startTs, stepMs: 1000 })
  f.sessionStarted({ sessionId: `sess-${handle}`, repoPath: '/repo', repoName: 'repo' })
  f.agentStatus({ handle: lane, status: 'working' })
  f.toolActivity({ lane, tool: 'Write', role: 'worker' })
  f.toolActivity({ lane, tool: 'Bash', role: 'worker' })
  const events = f.all()
  const record = buildRecord(events, {
    repoSlug: REPO_SLUG,
    actor: { instance, handle, declared: true },
  })
  return { events, record }
}

describe('mergeRecords', () => {
  it('folds two disjoint actors into one coherent, deduped, ordered stream', () => {
    // Same id prefix on purpose: two independent sessions minting "evt-000001"
    // etc. must not collide just because their counters agree.
    const alice = actorRecord('inst-alice', 'alice', FIXTURE_START_TS, 'alice-lane')
    const bob = actorRecord('inst-bob', 'bob', FIXTURE_START_TS + 500, 'bob-lane')

    const result = mergeRecords(alice.record, bob.record)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)

    expect(result.merged.repoSlug).toBe(REPO_SLUG)
    expect(result.merged.actors).toEqual([alice.record.manifest.actor, bob.record.manifest.actor])
    // No events dropped and none doubled, despite the shared id namespace.
    expect(result.merged.events).toHaveLength(alice.events.length + bob.events.length)

    // Per-actor order survived the interleave.
    const aliceToolCalls = result.merged.events
      .filter((e) => e.type === 'tool.activity' && e.payload.lane === 'alice-lane')
      .map((e) => (e.type === 'tool.activity' ? e.payload.tool : null))
    expect(aliceToolCalls).toEqual(['Write', 'Bash'])
    const bobToolCalls = result.merged.events
      .filter((e) => e.type === 'tool.activity' && e.payload.lane === 'bob-lane')
      .map((e) => (e.type === 'tool.activity' ? e.payload.tool : null))
    expect(bobToolCalls).toEqual(['Write', 'Bash'])

    // The merged fold's lane attribution keeps each actor distinct.
    const state = reduceAll(result.merged.events)
    expect(state.agents['alice-lane']?.status).toBe('working')
    expect(state.agents['bob-lane']?.status).toBe('working')
    expect(state.telemetry.lanes['alice-lane']?.lane).toBe('alice-lane')
    expect(state.telemetry.lanes['bob-lane']?.lane).toBe('bob-lane')
    expect(state.eventCount).toBe(alice.events.length + bob.events.length)
  })

  it('dedupes a record merged against itself instead of doubling it', () => {
    const alice = actorRecord('inst-alice', 'alice', FIXTURE_START_TS, 'alice-lane')

    const result = mergeRecords(alice.record, alice.record)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)

    expect(result.merged.events).toHaveLength(alice.events.length)
    expect(result.merged.events).toEqual(alice.events)
  })

  it('says nothing about unknowns when both records are from this era', () => {
    const alice = actorRecord('inst-alice', 'alice', FIXTURE_START_TS, 'alice-lane')
    const bob = actorRecord('inst-bob', 'bob', FIXTURE_START_TS + 500, 'bob-lane')
    const result = mergeRecords(alice.record, bob.record)
    if (!result.ok) throw new Error(result.reason)
    expect(result.merged.unknown).toEqual([])
    expect(result.merged.unknownVoice).toBeNull()
  })

  it('refuses to merge records from different repos', () => {
    const alice = actorRecord('inst-alice', 'alice', FIXTURE_START_TS, 'alice-lane')
    const f = createEventFactory({ startTs: FIXTURE_START_TS })
    f.sessionStarted({ sessionId: 'sess-carol', repoPath: '/other', repoName: 'other' })
    const carolRecord = buildRecord(f.all(), {
      repoSlug: 'other-repo-xyz789',
      actor: { instance: 'inst-carol', handle: 'carol', declared: true },
    })

    const result = mergeRecords(alice.record, carolRecord)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain(REPO_SLUG)
    expect(result.reason).toContain('other-repo-xyz789')
  })
})

/**
 * prd17 ruling 3, item 1 — the federated half. A merge with a foreign actor
 * running a NEWER build of the instrument used to fail outright on the first
 * line it did not recognise, which is the worst possible outcome for the one
 * scenario federation exists to serve.
 */
describe('mergeRecords — a newer actor is folded, and its unknowns counted', () => {
  it('merges an era-ahead actor\'s record, keeping its unknown lines beside the stream', () => {
    const alice = actorRecord('inst-alice', 'alice', FIXTURE_START_TS, 'alice-lane')
    const bob = actorRecord('inst-bob', 'bob', FIXTURE_START_TS + 500, 'bob-lane')
    const bobAhead = withLinesAt(bob.record, 2, [FUTURE_LINE])

    const result = mergeRecords(alice.record, bobAhead)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)

    // Everything both eras share still folds, and the merged stream is whole.
    expect(result.merged.events).toHaveLength(alice.events.length + bob.events.length)
    // The one line this era cannot fold is counted, attributed and preserved.
    expect(result.merged.unknown).toHaveLength(1)
    expect(result.merged.unknown[0]?.actorInstance).toBe('inst-bob')
    expect(result.merged.unknown[0]?.line).toBe(FUTURE_LINE)
    expect(result.merged.unknownVoice).toBe(
      '1 event from a newer era was preserved but not understood (summons.raised)',
    )
  })

  it('counts BOTH actors\' unknowns, actor a\'s first', () => {
    const aliceAhead = withLinesAt(
      actorRecord('inst-alice', 'alice', FIXTURE_START_TS, 'alice-lane').record,
      1,
      [FUTURE_LINE.replace('evt-future-1', 'evt-a-1')],
    )
    const bobAhead = withLinesAt(
      actorRecord('inst-bob', 'bob', FIXTURE_START_TS + 500, 'bob-lane').record,
      1,
      [FUTURE_LINE.replace('evt-future-1', 'evt-b-1').replace('summons.raised', 'operator.ack')],
    )

    const result = mergeRecords(aliceAhead, bobAhead)
    if (!result.ok) throw new Error(result.reason)
    expect(result.merged.unknown.map((entry) => entry.actorInstance)).toEqual([
      'inst-alice',
      'inst-bob',
    ])
    expect(result.merged.unknownVoice).toBe(
      '2 events from a newer era were preserved but not understood (operator.ack, summons.raised)',
    )
  })

  it('does NOT dedupe unknowns — a merge against itself counts both, because neither has an id it can be keyed on', () => {
    const ahead = withLinesAt(
      actorRecord('inst-alice', 'alice', FIXTURE_START_TS, 'alice-lane').record,
      1,
      [FUTURE_LINE],
    )
    const result = mergeRecords(ahead, ahead)
    if (!result.ok) throw new Error(result.reason)
    // The events still dedupe on `(actor.instance, event.id)` as always...
    expect(result.merged.events).toHaveLength(4)
    // ...and the unknown is counted twice, honestly: dedup needs a parsed id,
    // and folding on raw line text would collapse two distinct newer-era events
    // that happened to serialise the same.
    expect(result.merged.unknown).toHaveLength(2)
  })

  it('still refuses a line that is not an event at all', () => {
    const alice = actorRecord('inst-alice', 'alice', FIXTURE_START_TS, 'alice-lane')
    const broken = withLinesAt(alice.record, 1, ['{"just":"an object"}'])
    const result = mergeRecords(alice.record, broken)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.reason).toContain('not an event at all')
    expect(result.reason).toContain('inst-alice')
  })
})
