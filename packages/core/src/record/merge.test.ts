import { describe, expect, it } from 'vitest'
import { createEventFactory, FIXTURE_START_TS } from '../fixtures.js'
import { reduceAll } from '../reduce.js'
import { buildRecord } from './build.js'
import { mergeRecords } from './merge.js'

const REPO_SLUG = 'rhizomorph-abc123'

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
