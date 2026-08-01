import { createEvent, createIdFactory, reduceAll } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import { buildFleet, fixtureHistory, manifestFor, pathologySpec } from '../fleet/index.js'
import { laneIndex, resolveLane } from './resolve.js'

/**
 * WHOSE THREAD IS THIS?
 *
 * The pulse layer needs one answer, and it has to be the answer the derived
 * model already gave — otherwise a commit lights a thread the fleet table says
 * belongs to somebody else, which is the exact class of quiet disagreement the
 * one-derived-fleet-object rule exists to prevent. So the index is built from
 * `Fleet.lanes` and these tests check it against the real fixture's own lanes.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const nextId = createIdFactory('r')

const spec = pathologySpec()
const fleet = buildFleet(reduceAll(fixtureHistory(spec, NOW)), {
  now: NOW,
  manifest: manifestFor(spec),
})
const index = laneIndex(fleet)

function usage(payload: { branch?: string; worktreePath?: string; lane: string }) {
  return createEvent(
    'llm.usage',
    {
      lane: payload.lane,
      role: 'worker',
      model: 'claude-opus-5',
      tokens: { input: 1, output: 100, cacheRead: 0, cacheCreation: 0 },
      thread: 'main',
      ...(payload.branch === undefined ? {} : { branch: payload.branch }),
      ...(payload.worktreePath === undefined ? {} : { worktreePath: payload.worktreePath }),
    },
    { id: nextId(), ts: NOW },
  )
}

describe('resolving an event to a thread', () => {
  it('prefers the branch — the identity that outlives the worktree', () => {
    // prd1: spend is keyed by branch precisely because a branch survives its
    // worktree's removal, so the branch is the durable answer here too.
    expect(resolveLane(index, usage({ lane: 'nonsense', branch: '46-spend-selectors' }))).toBe(
      '46-spend-selectors',
    )
  })

  it('falls back to the worktree path, then to the telemetry handle', () => {
    const byPath = usage({
      lane: 'nonsense',
      worktreePath: '/repo/observatory__worktrees/47-format-module',
    })
    expect(resolveLane(index, byPath)).toBe('47-format-module')
    expect(resolveLane(index, usage({ lane: '48-doctor-report' }))).toBe('48-doctor-report')
  })

  it('sends main home to the root-mass rather than to a thread', () => {
    // A commit on main is already home: it has no journey to make, so `null`
    // here means the mass, not "unknown".
    const landed = createEvent(
      'commit.landed',
      {
        sha: 'sha-main-999',
        branch: 'main',
        message: 'chore: land',
        author: { name: 'conductor', email: 'conductor@observatory' },
        files: [{ path: 'docs/roadmap.md', status: 'modified', insertions: 1, deletions: 0 }],
      },
      { id: nextId(), ts: NOW },
    )
    expect(resolveLane(index, landed)).toBeNull()
  })

  it('declines to invent a thread the fleet does not have', () => {
    // The scene draws the model's lanes and no others. A lane nobody has heard
    // of is not a reason to grow one.
    expect(resolveLane(index, usage({ lane: 'ghost', branch: 'ghost-branch' }))).toBeNull()
  })

  it('lights nothing for the events that only move clocks', () => {
    const beat = createEvent(
      'pane.activity',
      { paneId: '%1', contentHash: 'h', lines: 12 },
      { id: nextId(), ts: NOW },
    )
    expect(resolveLane(index, beat)).toBeNull()
  })

  it('resolves a lane declaring its own state — what the cord-cut fires on', () => {
    // prd5 ruling 3: `agent.status: done` is what cuts a lane's cord, so it needs
    // the same one answer to "whose lane is this?" a commit gets. workmux carries
    // all three identities and is only *sure* of the handle — the branch and
    // worktree are optional in the schema, because it knows what it launched
    // before git has seen it.
    const status = (payload: { handle: string; branch?: string }) =>
      createEvent(
        'agent.status',
        {
          handle: payload.handle,
          status: 'done' as const,
          ...(payload.branch === undefined ? {} : { branch: payload.branch }),
        },
        { id: nextId(), ts: NOW },
      )

    expect(resolveLane(index, status({ handle: '48-doctor-report' }))).toBe('48-doctor-report')
    expect(resolveLane(index, status({ handle: 'nonsense', branch: '47-format-module' }))).toBe(
      '47-format-module',
    )
    // Main declaring itself done is the mass, not a thread with a cord to cut.
    expect(resolveLane(index, status({ handle: 'conductor', branch: 'main' }))).toBeNull()
    expect(resolveLane(index, status({ handle: 'ghost' }))).toBeNull()
  })

  it('indexes every lane the fleet actually has', () => {
    for (const lane of fleet.lanes) {
      expect(resolveLane(index, usage({ lane: lane.handles[0] ?? lane.id }))).toBe(lane.id)
    }
  })
})
