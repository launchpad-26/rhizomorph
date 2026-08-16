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
    // The MERGE is lossless — every event of both actors is in the stream.
    expect(result.merged.events).toHaveLength(alice.events.length + bob.events.length)
  })

  /**
   * AMENDED BY #592, and the amendment is a REPORT, not a tidy-up.
   *
   * `reduce` now treats a `session.started` naming a session other than the
   * one it is folding as SUCCESSION — the recording ended and another began —
   * because that is what it means on the live stream and in every replayed
   * log, and because ignoring it left the dashboard folding two recordings at
   * once after every rotation (#592).
   *
   * A federated merge means the other thing. Alice's and Bob's `session.started`
   * are two actors observing one repo side by side, not one replacing the
   * other — so folding the merged stream through this reducer now resets at
   * whichever actor's start comes second, and whatever the first actor
   * recorded before that instant is dropped.
   *
   * **The merge itself is unharmed** (asserted above: every event of both
   * actors is in `merged.events`, in per-actor append order). What cannot
   * represent two concurrent actors is `SessionState`, which has exactly one
   * `session` slot and one `mainBranch` — so even before #592 a merged fold
   * silently picked a winner for both, and every per-lane fact survived only
   * because these fixtures happen to interleave their starts ahead of their
   * facts. #592 makes that pre-existing single-session assumption LOUD instead
   * of leaving it as a coincidence of timestamps.
   *
   * The honest fix is not to weaken the succession rule — the live instrument
   * needs it — but to fold a merged record PER ACTOR, which is what a
   * multi-actor view needs regardless (prd11 ruling 3). Pinned here so the
   * next lane to reach federation finds the limitation stated rather than
   * discovers it as a mystery.
   */
  it('folding the merged stream collapses to the last actor to start — the single-session fold cannot hold two (#592)', () => {
    const alice = actorRecord('inst-alice', 'alice', FIXTURE_START_TS, 'alice-lane')
    const bob = actorRecord('inst-bob', 'bob', FIXTURE_START_TS + 500, 'bob-lane')
    const result = mergeRecords(alice.record, bob.record)
    if (!result.ok) throw new Error(result.reason)

    const boundaryAt = result.merged.events.findIndex(
      (event) => event.type === 'session.started' && event.payload.sessionId === 'sess-bob',
    )
    expect(boundaryAt).toBeGreaterThan(0)

    const state = reduceAll(result.merged.events)
    // The fold counts from the second actor's start, not from the stream's.
    expect(state.session?.sessionId).toBe('sess-bob')
    expect(state.eventCount).toBe(result.merged.events.length - boundaryAt)
    expect(state.eventCount).toBeLessThan(result.merged.events.length)
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
