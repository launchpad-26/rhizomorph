import { createEvent, createIdFactory, type ObservatoryEvent } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import {
  NEWS_GRACE_MS,
  foldStreamEvents,
  initialStreamState,
  type StreamState,
} from '../app/streamState.js'
import { EVENT } from './motion.js'
import {
  MAX_MOTES_PER_REQUEST,
  MAX_PULSES,
  ORBIT_STEP,
  PulseField,
  TOKENS_PER_MOTE,
  takeNews,
  type Pulse,
} from './pulses.js'
import type { LaneIndex } from './resolve.js'

/**
 * EVERY PULSE IS AN EVENT (ruling 32, adopted as law).
 *
 * These tests hold the three enforcement rules the pick ruling adopted, because
 * each one fails silently and beautifully: a scene that invents traffic looks
 * *better* than one that does not, right up until an operator trusts it.
 *
 * 1. history never pulses — a replay burst builds state and lights nothing;
 * 2. traffic is coalesced, never invented — the cap turns surplus into glow;
 * 3. an arrival flare is the end of a real journey — no journey, no flare.
 *
 * Every clock here is a number this file chose. Nothing in the pulse field reads
 * `Date.now()`, which is the whole reason the field can be tested at all.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const nextId = createIdFactory('t')

const INDEX: LaneIndex = {
  byBranch: new Map([
    ['77-strip', 'lane-a'],
    ['78-table', 'lane-b'],
  ]),
  byWorktree: new Map(),
  byHandle: new Map([['77-strip', 'lane-a']]),
  mainBranch: 'main',
  mainWorktree: '/repo',
}

function usage(branch: string, output: number, ts = NOW): ObservatoryEvent {
  return createEvent(
    'llm.usage',
    {
      lane: branch,
      role: 'worker',
      model: 'claude-opus-5',
      tokens: { input: 10, output, cacheRead: 0, cacheCreation: 0 },
      branch,
      thread: 'main',
    },
    { id: nextId(), ts },
  )
}

function commit(branch: string, files: number, ts = NOW): ObservatoryEvent {
  return createEvent(
    'commit.landed',
    {
      sha: `sha-${branch}-${ts}`,
      branch,
      message: 'feat: a step',
      author: { name: 'agent', email: 'agent@observatory' },
      files: Array.from({ length: files }, (_unused, i) => ({
        path: `src/file-${i}.ts`,
        status: 'modified' as const,
        insertions: 3,
        deletions: 1,
      })),
    },
    { id: nextId(), ts },
  )
}

function tool(branch: string, ts = NOW): ObservatoryEvent {
  return createEvent(
    'tool.activity',
    { lane: branch, tool: 'Read', role: 'worker', branch, thread: 'main' },
    { id: nextId(), ts },
  )
}

function paneBeat(ts = NOW): ObservatoryEvent {
  return createEvent(
    'pane.activity',
    { paneId: '%1', contentHash: `h-${ts}`, lines: 40 },
    { id: nextId(), ts },
  )
}

/** How many real events the live animations stand for, counts included. */
function represented(field: PulseField): number {
  return field.pulses().reduce((total, pulse) => total + pulse.count, 0)
}

describe('rule 1 — history never pulses', () => {
  it('lights nothing for a replayed session, however big the burst', () => {
    const connectedAt = NOW
    let state: StreamState = initialStreamState(connectedAt)

    // Two hours of a busy fleet, all of it already over by the time we connect.
    const past: ObservatoryEvent[] = []
    for (let i = 0; i < 400; i += 1) {
      const ts = connectedAt - 2 * 3_600_000 + i * 1_000
      past.push(usage('77-strip', 900, ts), commit('78-table', 4, ts), tool('77-strip', ts))
    }
    state = foldStreamEvents(state, past)

    // The state is fully built…
    expect(state.events).toHaveLength(1_200)
    // …and none of it is news, so nothing can reach the field.
    expect(state.newsCount).toBe(0)

    const field = new PulseField()
    const taken = takeNews(state, 0)
    field.ingest(taken.events, INDEX, NOW)
    field.step(NOW)

    expect(taken.events).toHaveLength(0)
    expect(field.pulses()).toHaveLength(0)
    expect(field.surge()).toBe(0)
  })

  it('lights the live tail that follows the same burst', () => {
    const connectedAt = NOW
    let state = initialStreamState(connectedAt)
    state = foldStreamEvents(state, [usage('77-strip', 900, connectedAt - 3_600_000)])
    state = foldStreamEvents(state, [commit('77-strip', 3, connectedAt + 1_000)])

    const field = new PulseField()
    const taken = takeNews(state, 0)
    field.ingest(taken.events, INDEX, NOW)

    expect(taken.events).toHaveLength(1)
    expect(field.pulses().map((pulse) => pulse.kind)).toEqual(['commit'])
  })

  it('takes each news event exactly once', () => {
    let state = initialStreamState(NOW)
    state = foldStreamEvents(state, [commit('77-strip', 1, NOW), commit('77-strip', 1, NOW)])

    const first = takeNews(state, 0)
    expect(first.events).toHaveLength(2)
    expect(takeNews(state, first.cursor).events).toHaveLength(0)
  })

  it('counts an event from just before the connection as news, not history', () => {
    // The seam where the replay burst meets the live tail: something emitted a
    // moment before we connected genuinely did just happen.
    let state = initialStreamState(NOW)
    state = foldStreamEvents(state, [commit('77-strip', 1, NOW - NEWS_GRACE_MS + 500)])
    expect(takeNews(state, 0).events).toHaveLength(1)
  })
})

describe('rule 2 — traffic is coalesced, never invented', () => {
  it('spawns motes in proportion to real output tokens', () => {
    const field = new PulseField()
    field.ingest([usage('77-strip', TOKENS_PER_MOTE * 2)], INDEX, NOW)
    expect(field.pulses().filter((p) => p.kind === 'mote')).toHaveLength(2)
  })

  it('never sprays more than the per-request ceiling', () => {
    const field = new PulseField()
    field.ingest([usage('77-strip', TOKENS_PER_MOTE * 500)], INDEX, NOW)
    expect(field.pulses()).toHaveLength(MAX_MOTES_PER_REQUEST)
  })

  it('turns a burst into a handful of pulses and a count, losing nothing', () => {
    const field = new PulseField()
    const requests = Array.from({ length: 20 }, () => usage('77-strip', TOKENS_PER_MOTE * 3))
    field.ingest(requests, INDEX, NOW)

    // 60 motes wanted, five animations drawn — and every one of the 60 is still
    // accounted for, in a count or in the lane's glow.
    expect(field.concurrency()).toBe(EVENT.maxConcurrent)
    expect(represented(field) + field.energyOf('lane-a').coalesced).toBe(60)
    expect(field.energyOf('lane-a').heat).toBeGreaterThan(0)
  })

  it('never drops anything outright — the motion cap coalesces long first', () => {
    const field = new PulseField()
    for (let i = 0; i < MAX_PULSES + 50; i += 1) {
      field.ingest([commit('77-strip', 1, NOW + i)], INDEX, NOW + i)
    }
    expect(field.concurrency()).toBeLessThanOrEqual(EVENT.maxConcurrent)
    // The memory backstop is far above the motion cap, so it is never reached
    // and the gap voice has nothing to report. Zero here means zero.
    expect(field.dropped()).toBe(0)
    expect(represented(field)).toBe(MAX_PULSES + 50)
  })

  it('lights nothing for the two event types that only move clocks', () => {
    const field = new PulseField()
    field.ingest([paneBeat()], INDEX, NOW)
    expect(field.pulses()).toHaveLength(0)
  })

  it('declines to invent a thread for a lane the fleet has never heard of', () => {
    const field = new PulseField()
    field.ingest([usage('99-unknown', 5_000)], INDEX, NOW)
    expect(field.pulses()).toHaveLength(0)
  })
})

/**
 * THE MOTION CAP (ruling 4) — rule 2, extended from traffic to motion.
 *
 * Five is not a performance budget. It is the number of independent moving
 * targets a person can actually follow (Pylyshyn & Storm), and a scene that
 * fires twelve at once reports *less* than one that fires five, because none of
 * the twelve can be tracked. So the sixth event does not get its own light — it
 * folds into a journey that is already running, which starts carrying a count.
 */
describe('ruling 4 — five concurrent animations, then a count', () => {
  const aggregateOf = (field: PulseField): Pulse | undefined =>
    field.pulses().find((pulse) => pulse.kind === 'aggregate')

  it('animates the first five events and coalesces the sixth', () => {
    const field = new PulseField()
    const six = Array.from({ length: 6 }, (_unused, i) => commit('77-strip', 1, NOW + i))
    field.ingest(six, INDEX, NOW)

    expect(field.concurrency()).toBe(EVENT.maxConcurrent)

    const aggregate = aggregateOf(field)
    expect(aggregate).toBeDefined()
    // Two events on one animation: the journey it was already making, plus the
    // one that could not have its own.
    expect(aggregate?.count).toBe(2)
    expect(represented(field)).toBe(6)
  })

  it('keeps counting past the cap without ever adding a seventh moving thing', () => {
    const field = new PulseField()
    for (let i = 0; i < 40; i += 1) field.ingest([commit('77-strip', 1, NOW + i)], INDEX, NOW)

    expect(field.concurrency()).toBe(EVENT.maxConcurrent)
    expect(aggregateOf(field)?.count).toBe(40 - (EVENT.maxConcurrent - 1))
    expect(represented(field)).toBe(40)
  })

  it('folds only into a journey going the same way', () => {
    // A commit folded into an outbound mote would be a lie about direction, and
    // direction is the one thing the light in this scene is *for*.
    const field = new PulseField()
    field.ingest(
      Array.from({ length: EVENT.maxConcurrent }, () => usage('77-strip', TOKENS_PER_MOTE)),
      INDEX,
      NOW,
    )
    expect(field.pulses().every((pulse) => !pulse.homeward)).toBe(true)

    field.ingest([commit('77-strip', 1)], INDEX, NOW)

    // No homeward journey to join, so it became the lane's glow rather than
    // riding out to the tip on somebody else's mote.
    expect(field.pulses().every((pulse) => !pulse.homeward)).toBe(true)
    expect(field.energyOf('lane-a').coalesced).toBe(1)
  })

  it('never folds one lane’s traffic onto another lane’s thread', () => {
    const field = new PulseField()
    field.ingest(
      Array.from({ length: EVENT.maxConcurrent }, (_unused, i) => commit('77-strip', 1, NOW + i)),
      INDEX,
      NOW,
    )
    field.ingest([commit('78-table', 1)], INDEX, NOW)

    expect(field.pulses().every((pulse) => pulse.laneId === 'lane-a')).toBe(true)
    expect(field.energyOf('lane-b').coalesced).toBe(1)
    expect(field.energyOf('lane-b').heat).toBeGreaterThan(0)
  })

  it('lets a tick yield its slot to light that is going somewhere', () => {
    // A tick is a flick across the thread with no journey in it. A fleet running
    // tools must not be able to starve the one motion that means "work landed".
    const field = new PulseField()
    field.ingest(
      Array.from({ length: EVENT.maxConcurrent }, (_unused, i) => tool('77-strip', NOW + i)),
      INDEX,
      NOW,
    )
    expect(field.pulses().every((pulse) => pulse.kind === 'tick')).toBe(true)

    field.ingest([commit('77-strip', 2)], INDEX, NOW)

    const kinds = field.pulses().map((pulse) => pulse.kind)
    expect(kinds).toContain('commit')
    expect(kinds.filter((kind) => kind === 'tick')).toHaveLength(EVENT.maxConcurrent - 1)
    expect(field.concurrency()).toBe(EVENT.maxConcurrent)
  })

  it('drops a tick of its own rather than growing the count for a flash', () => {
    const field = new PulseField()
    for (let i = 0; i < EVENT.maxConcurrent + 3; i += 1) {
      field.ingest([tool('77-strip', NOW + i)], INDEX, NOW)
    }
    expect(field.concurrency()).toBe(EVENT.maxConcurrent)
    expect(field.pulses().every((pulse) => pulse.count === 1)).toBe(true)
    // The wheel still turned for every one of them: the fact survives the flash.
    expect(field.energyOf('lane-a').orbitTarget).toBeCloseTo(ORBIT_STEP * 8, 10)
  })

  it('flares for every arrival an aggregate carried home', () => {
    // Coalescing changes how traffic is drawn, never how much of it there was.
    const one = new PulseField()
    one.ingest([commit('77-strip', 1)], INDEX, NOW)
    one.step(NOW + 3_000)

    const many = new PulseField()
    for (let i = 0; i < 12; i += 1) many.ingest([commit('77-strip', 1, NOW + i)], INDEX, NOW)
    many.step(NOW + 3_000)

    expect(many.surge()).toBeGreaterThan(one.surge())
  })

  it('frees its slots again as the journeys end', () => {
    const field = new PulseField()
    for (let i = 0; i < 12; i += 1) field.ingest([commit('77-strip', 1, NOW + i)], INDEX, NOW)
    expect(field.concurrency()).toBe(EVENT.maxConcurrent)

    field.step(NOW + 4_000)
    expect(field.concurrency()).toBe(0)

    field.ingest([commit('77-strip', 1)], INDEX, NOW + 4_000)
    expect(field.pulses().map((pulse) => pulse.kind)).toEqual(['commit'])
  })
})

describe('rule 3 — an arrival flare is the end of a real journey', () => {
  it('does not flare while the packet is still travelling', () => {
    const field = new PulseField()
    field.ingest([commit('77-strip', 3)], INDEX, NOW)
    field.step(NOW + 500)
    expect(field.surge()).toBe(0)
  })

  it('flares when the journey ends, and decays afterwards', () => {
    const field = new PulseField()
    field.ingest([commit('77-strip', 3)], INDEX, NOW)

    field.step(NOW + 3_000)
    const atArrival = field.surge()
    expect(atArrival).toBeGreaterThan(0)
    expect(field.pulses()).toHaveLength(0)

    field.step(NOW + 6_000)
    expect(field.surge()).toBeLessThan(atArrival)
  })

  it('flares directly for a commit on main — it is already home', () => {
    const field = new PulseField()
    field.ingest([commit('main', 2)], INDEX, NOW)
    expect(field.pulses()).toHaveLength(0)
    expect(field.surge()).toBeGreaterThan(0)
  })

  it('sends a landing home bigger than a commit', () => {
    const of = (event: ObservatoryEvent): number => {
      const field = new PulseField()
      field.ingest([event], INDEX, NOW)
      field.step(NOW + 4_000)
      return field.surge()
    }

    const landing = createEvent(
      'worktree.removed',
      { path: '/repo__worktrees/77-strip' },
      { id: nextId(), ts: NOW },
    )
    const index: LaneIndex = {
      ...INDEX,
      byWorktree: new Map([['/repo__worktrees/77-strip', 'lane-a']]),
    }

    const field = new PulseField()
    field.ingest([landing], index, NOW)
    expect(field.pulses().map((p) => p.kind)).toEqual(['landing'])
    field.step(NOW + 4_000)
    expect(field.surge()).toBeGreaterThan(of(commit('77-strip', 3)))
  })
})

describe('the direction of travel', () => {
  it('runs a commit home and a mote out to the growing tip', () => {
    const field = new PulseField()
    field.ingest([commit('77-strip', 2), usage('77-strip', TOKENS_PER_MOTE)], INDEX, NOW)

    const byKind = new Map(field.pulses().map((pulse) => [pulse.kind, pulse]))
    const homeward = byKind.get('commit')
    const outward = byKind.get('mote')
    expect(homeward?.homeward).toBe(true)
    expect(outward?.homeward).toBe(false)

    // 0 is the root-mass and 1 is the node, whichever way the light is going.
    expect(PulseField.position(homeward as never, NOW)).toBeCloseTo(1, 5)
    expect(PulseField.position(outward as never, NOW)).toBeCloseTo(0, 5)
  })

  it('sizes a commit by the files that rode in', () => {
    const field = new PulseField()
    field.ingest([commit('77-strip', 1), commit('78-table', 9)], INDEX, NOW)
    const [small, large] = field.pulses()
    expect((large?.size as number) > (small?.size as number)).toBe(true)
    expect(large?.weight).toBe(9)
  })
})

describe("the loop's wheel", () => {
  it('advances one notch per real tool call and not otherwise', () => {
    const field = new PulseField()
    field.ingest([tool('77-strip'), tool('77-strip')], INDEX, NOW)
    expect(field.energyOf('lane-a').orbitTarget).toBeCloseTo(ORBIT_STEP * 2, 10)

    // Time alone must not turn it: a loop that stopped looks stopped.
    const before = field.energyOf('lane-a').orbitTarget
    field.step(NOW + 10_000)
    field.step(NOW + 20_000)
    expect(field.energyOf('lane-a').orbitTarget).toBe(before)
  })

  it('eases the drawn phase toward the notch rather than snapping to it', () => {
    const field = new PulseField()
    field.ingest([tool('77-strip')], INDEX, NOW)
    field.step(NOW)
    field.step(NOW + 100)
    const phase = field.energyOf('lane-a').orbitPhase
    expect(phase).toBeGreaterThan(0)
    expect(phase).toBeLessThan(ORBIT_STEP)
  })
})

describe('a fleet with nothing happening', () => {
  it('is still — no events, no light, no drift in the numbers', () => {
    const field = new PulseField()
    field.step(NOW)
    field.step(NOW + 60_000)

    expect(field.pulses()).toHaveLength(0)
    expect(field.surge()).toBe(0)
    expect(field.energyOf('lane-a').heat).toBe(0)
    expect(field.dropped()).toBe(0)
  })

  it('decays a lane back to stillness after its burst', () => {
    const field = new PulseField()
    field.ingest([usage('77-strip', 4_000)], INDEX, NOW)
    const hot = field.energyOf('lane-a').heat
    field.step(NOW)
    field.step(NOW + 60_000)
    expect(field.energyOf('lane-a').heat).toBeLessThan(hot * 0.05)
  })
})
