import { createEvent, createIdFactory, type ObservatoryEvent } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import type { Fleet, Lane } from '../fleet/index.js'
import { STRUCTURAL } from './motion.js'
import { luminance } from './palette.js'
import {
  CUT,
  RetireRegistry,
  SCAR,
  SCAR_FLOOR,
  cutAt,
  isRetired,
  toward,
  type RetireStage,
} from './retire.js'
import type { LaneIndex } from './resolve.js'

/**
 * THE CORD-CUT'S CLOCK (prd5 ruling 3).
 *
 * This file owns the half of the cut that is arithmetic: which lanes are
 * retiring, when each one is allowed to start, and what stage it is in at a given
 * instant. What the picture then *looks* like is `marks.test.ts`'s and
 * `geometry.test.ts`'s.
 *
 * Everything here runs on a number rather than a clock, which is the same seam
 * `settle.test.ts` takes and for the same reason: a cut is deterministic in its
 * elapsed time, so a pinned instant is a still image of a known stage and no test
 * has to race an interval to look at one.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const nextId = createIdFactory('cut')

const INDEX: LaneIndex = {
  byBranch: new Map([
    ['77-strip', 'lane-a'],
    ['78-table', 'lane-b'],
    ['79-ledger', 'lane-c'],
  ]),
  byWorktree: new Map([
    ['/repo__worktrees/77-strip', 'lane-a'],
    ['/repo__worktrees/78-table', 'lane-b'],
  ]),
  byHandle: new Map([['79-ledger', 'lane-c']]),
  mainBranch: 'main',
  mainWorktree: '/repo',
}

function declared(handle: string, status: 'working' | 'waiting' | 'done'): ObservatoryEvent {
  return createEvent(
    'agent.status',
    { handle, status, branch: handle, worktreePath: `/repo__worktrees/${handle}` },
    { id: nextId(), ts: NOW },
  )
}

function removed(path: string): ObservatoryEvent {
  return createEvent('worktree.removed', { path }, { id: nextId(), ts: NOW })
}

/** Just enough of a lane for `isRetired` and `progress` — both read two fields. */
function lane(id: string, changes: Partial<Lane> = {}): Lane {
  return { id, activity: 'done', parked: false, ...changes } as Lane
}

function fleetOf(...lanes: Lane[]): Pick<Fleet, 'lanes'> {
  return { lanes }
}

const DONE_FLEET = fleetOf(lane('lane-a'), lane('lane-b'), lane('lane-c'))

describe('the three stages', () => {
  it('runs tension, then retract, then settle, and stops at a scar', () => {
    const stageAt = (ms: number): RetireStage => cutAt(ms).stage

    expect(stageAt(0)).toBe('tension')
    expect(stageAt(CUT.tensionMs - 1)).toBe('tension')
    expect(stageAt(CUT.tensionMs)).toBe('retract')
    expect(stageAt(CUT.tensionMs + CUT.retractMs - 1)).toBe('retract')
    expect(stageAt(CUT.tensionMs + CUT.retractMs)).toBe('settle')
    expect(stageAt(CUT.totalMs - 1)).toBe('settle')
    // Past the end it is a scar, and it is a scar for ever.
    expect(stageAt(CUT.totalMs)).toBe('scar')
    expect(stageAt(CUT.totalMs * 1_000)).toBe('scar')
  })

  it('adds up to the ~1.4 s the ruling asked for, on the structural budget', () => {
    expect(CUT.totalMs).toBe(1_400)
    // The retract is not a number of its own — it *is* the structural class.
    expect(CUT.retractMs).toBe(STRUCTURAL.durationMs)
  })

  it('changes exactly one channel per stage', () => {
    // This is the whole reason the cut is staged rather than one 1.4 s blend:
    // three stages that each move one thing read as a sentence, where one
    // animation moving three things reads as "something happened".
    const tension = cutAt(CUT.tensionMs * 0.5)
    expect(tension.tension).toBeGreaterThan(0)
    expect(tension.tension).toBeLessThan(1)
    expect(tension.retract).toBe(0)
    expect(tension.scar).toBe(0)

    const retract = cutAt(CUT.tensionMs + CUT.retractMs * 0.5)
    expect(retract.tension).toBe(1)
    expect(retract.retract).toBeGreaterThan(0)
    expect(retract.retract).toBeLessThan(1)
    expect(retract.scar).toBe(0)

    const settle = cutAt(CUT.tensionMs + CUT.retractMs + CUT.settleMs * 0.5)
    expect(settle.tension).toBe(1)
    expect(settle.retract).toBe(1)
    expect(settle.scar).toBeGreaterThan(0)
    expect(settle.scar).toBeLessThan(1)
  })

  it('retracts on a critically damped spring — monotone, and never past its target', () => {
    // ζ = 1 is the ruling and `spring.ts` offers no way to ask for anything else,
    // so this is a pin on the consequence: a cord that sprang back *past* the
    // node and came forward again would read as recoil — "it failed" — rather
    // than as "it finished".
    let previous = -1
    for (let ms = CUT.tensionMs; ms <= CUT.tensionMs + CUT.retractMs; ms += 8) {
      const { retract } = cutAt(ms)
      expect(retract).toBeGreaterThanOrEqual(previous)
      expect(retract).toBeLessThanOrEqual(1)
      previous = retract
    }
    // …and it arrives exactly, rather than 0.03% short of its own stage boundary.
    expect(cutAt(CUT.tensionMs + CUT.retractMs).retract).toBe(1)
  })

  it('is over half way back before the retract is half over — decelerating, not linear', () => {
    const half = cutAt(CUT.tensionMs + CUT.retractMs * 0.5).retract
    expect(half).toBeGreaterThan(0.75)
  })

  it('is a pure function of the elapsed time, so a pinned clock is a still image', () => {
    expect(cutAt(700)).toEqual(cutAt(700))
    expect(cutAt(-50)).toEqual(cutAt(0))
  })

  it('carries the node drift with the retract, so the tip eases out as the cord lets go', () => {
    expect(cutAt(CUT.tensionMs * 0.5).drift).toBe(0)
    const mid = cutAt(CUT.tensionMs + CUT.retractMs * 0.4)
    expect(mid.drift).toBe(mid.retract)
    expect(cutAt(CUT.totalMs).drift).toBe(1)
  })
})

describe('reduced motion — the swap in place', () => {
  it('collapses the whole cut to its endpoint, with no travel and no drift', () => {
    // WCAG 2.3.3 excludes colour and opacity from "motion animation", so the
    // degradation keeps the severed, desaturated *result* and drops the journey.
    const still = cutAt(0, false)
    expect(still.stage).toBe('scar')
    expect(still.progress).toBe(1)
    expect(still.scar).toBe(1)
    // The one number that separates this from a finished cut: the node has not
    // been carried anywhere.
    expect(still.drift).toBe(0)
    expect(cutAt(CUT.totalMs * 3, false)).toEqual(still)
  })

  it('is read off the motion allowance rather than decided twice', () => {
    const registry = new RetireRegistry()
    registry.note([declared('77-strip', 'done')], INDEX, NOW)

    expect(registry.progress(DONE_FLEET, NOW + 200, 'reduced').get('lane-a')?.stage).toBe('scar')
    // Pause is a stricter preference than reduce for everything else in the
    // scene, and deliberately *not* for this one: the cut is allowed to move
    // under a pause, it is simply held there by the frozen clock the caller
    // passes it. So `paused` still animates when the clock advances.
    expect(registry.progress(DONE_FLEET, NOW + 200, 'paused').get('lane-a')?.stage).toBe('retract')
  })
})

describe('what counts as leaving the network', () => {
  it('retires a lane workmux declared done, and a worktree that folded away', () => {
    expect(isRetired(lane('x', { activity: 'done' }))).toBe(true)
    expect(isRetired(lane('x', { activity: 'working' }))).toBe(false)
    expect(isRetired(lane('x', { activity: 'idle' }))).toBe(false)
  })

  it('retires a parked lane — the operator said so (prd4 ruling 5)', () => {
    expect(isRetired(lane('x', { activity: 'working', parked: true }))).toBe(true)
  })

  it('cuts on agent.status done and worktree.removed, and on nothing else', () => {
    const registry = new RetireRegistry()

    expect(registry.note([declared('77-strip', 'working')], INDEX, NOW)).toEqual([])
    expect(registry.note([declared('77-strip', 'waiting')], INDEX, NOW)).toEqual([])
    // A lane going quiet is FROZEN's evidence, never a finish.
    expect(registry.note([declared('77-strip', 'done')], INDEX, NOW)).toEqual(['lane-a'])
    expect(registry.note([removed('/repo__worktrees/78-table')], INDEX, NOW)).toEqual(['lane-b'])
  })

  it('scars a parked lane without ever cutting it', () => {
    // Parking is a standing declaration in a manifest, not a moment in the log —
    // there is no event whose arrival a cut could be the picture of, and
    // inventing an instant to animate would be animating a fact we never saw
    // arrive. So it scars outright, and it un-scars when the operator unparks it.
    const registry = new RetireRegistry()
    const parked = fleetOf(lane('lane-a', { activity: 'working', parked: true }))

    const state = registry.progress(parked, NOW, 'full').get('lane-a')
    expect(state?.stage).toBe('scar')
    expect(state?.progress).toBe(1)

    const unparked = fleetOf(lane('lane-a', { activity: 'working', parked: false }))
    expect(registry.progress(unparked, NOW + 5_000, 'full').has('lane-a')).toBe(false)
  })

  it('does not cut the root-mass, or a lane the fleet has never heard of', () => {
    const registry = new RetireRegistry()
    expect(registry.note([declared('main', 'done')], INDEX, NOW)).toEqual([])
    expect(registry.note([declared('99-ghost', 'done')], INDEX, NOW)).toEqual([])
  })
})

describe('once per lane, and never on history — law 2', () => {
  it('keeps its original instant however often the collector re-reports', () => {
    const registry = new RetireRegistry()
    const event = declared('77-strip', 'done')

    expect(registry.note([event], INDEX, NOW)).toEqual(['lane-a'])
    expect(registry.note([event], INDEX, NOW + 300)).toEqual([])
    expect(registry.note([event], INDEX, NOW + 90_000)).toEqual([])

    // Still measured from the first sighting, so nothing re-cuts.
    expect(registry.progress(DONE_FLEET, NOW + 300, 'full').get('lane-a')?.progress).toBeCloseTo(
      300 / CUT.totalMs,
      10,
    )
  })

  it('scars a lane that was already done when we first saw it, and animates nothing', () => {
    // The replay case, and the page-load case: `/api/stream` replays the whole
    // session before it live-tails, so a fleet full of landed lanes must arrive
    // already scarred rather than cutting seventeen cords at once.
    const registry = new RetireRegistry()
    const states = registry.progress(DONE_FLEET, NOW, 'full')

    expect([...states.keys()].sort()).toEqual(['lane-a', 'lane-b', 'lane-c'])
    for (const state of states.values()) {
      expect(state.stage).toBe('scar')
      expect(state.progress).toBe(1)
    }
  })

  it('does not re-fire when a scrub takes a lane out of done and back into it', () => {
    const registry = new RetireRegistry()
    registry.note([declared('77-strip', 'done')], INDEX, NOW)

    const living = fleetOf(lane('lane-a', { activity: 'working' }))
    // Scrubbed back before the landing: the lane is threaded again, and its
    // thread is drawn whole (absent from the map entirely).
    expect(registry.progress(living, NOW + 10_000, 'full').has('lane-a')).toBe(false)

    // Scrubbed forward again. The instant is remembered, so the cut is long over
    // rather than starting a second time.
    const again = registry.progress(DONE_FLEET, NOW + 20_000, 'full').get('lane-a')
    expect(again?.stage).toBe('scar')
    expect(again?.progress).toBe(1)
  })

  it('leaves a lane whose cut is still queued out of the map, so it stays a living thread', () => {
    const registry = new RetireRegistry()
    registry.note(
      [declared('77-strip', 'done'), declared('78-table', 'done'), declared('79-ledger', 'done')],
      INDEX,
      NOW,
    )

    // The first cord goes at once and the second a stagger behind it; the third
    // waits a whole cut-length, and until then it is drawn as the thread it
    // visibly still is rather than as a scar that has not moved.
    expect([...registry.progress(DONE_FLEET, NOW, 'full').keys()]).toEqual(['lane-a'])

    const staggered = registry.progress(DONE_FLEET, NOW + STRUCTURAL.staggerMs, 'full')
    expect([...staggered.keys()].sort()).toEqual(['lane-a', 'lane-b'])
    expect(staggered.has('lane-c')).toBe(false)

    expect(registry.progress(DONE_FLEET, NOW + CUT.totalMs, 'full').has('lane-c')).toBe(true)
  })
})

describe('the structural concurrency cap, as a queue — ruling 4', () => {
  /** When each of `count` simultaneous landings actually begins, relative to NOW. */
  function waveStarts(count: number): number[] {
    const registry = new RetireRegistry()
    const index: LaneIndex = {
      byBranch: new Map(Array.from({ length: count }, (_u, i) => [`lane-${i}`, `lane-${i}`])),
      byWorktree: new Map(),
      byHandle: new Map(),
      mainBranch: 'main',
      mainWorktree: '/repo',
    }
    const lanes = Array.from({ length: count }, (_u, i) => lane(`lane-${i}`))
    registry.note(
      lanes.map((each) => declared(each.id, 'done')),
      index,
      NOW,
    )

    // Read the schedule back off the only surface there is: when each lane first
    // appears in `progress` with a cut that has actually begun.
    return lanes.map((each) => {
      for (let ms = 0; ms <= count * CUT.totalMs; ms += 1) {
        const state = registry.progress(fleetOf(...lanes), NOW + ms, 'full').get(each.id)
        if (state !== undefined && state.progress < 1) return ms
      }
      throw new Error(`${each.id} never started`)
    })
  }

  it('sets off two cords at a time, staggered, and queues the rest', () => {
    const starts = waveStarts(6)

    expect(starts[0]).toBe(0)
    expect(starts[1]).toBe(STRUCTURAL.staggerMs)
    // The third waits for the first slot to free rather than joining a crowd.
    expect(starts[2]).toBe(CUT.totalMs)
    expect(starts[3]).toBe(CUT.totalMs + STRUCTURAL.staggerMs)
    expect(starts[4]).toBe(2 * CUT.totalMs)
    expect(starts[5]).toBe(2 * CUT.totalMs + STRUCTURAL.staggerMs)
  })

  it('never has more than the cap in flight, whatever the wave size', () => {
    const starts = waveStarts(9)
    for (const at of starts) {
      const inFlight = starts.filter((start) => at >= start && at < start + CUT.totalMs)
      expect(inFlight.length).toBeLessThanOrEqual(STRUCTURAL.maxConcurrent)
    }
  })

  it('staggers every pair, so two cords never move in lockstep', () => {
    const starts = waveStarts(8)
    const sorted = [...starts].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i += 1) {
      expect((sorted[i] as number) - (sorted[i - 1] as number)).toBeGreaterThanOrEqual(
        STRUCTURAL.staggerMs,
      )
    }
  })

  it('does not make a later landing wait for a wave that has already passed', () => {
    const registry = new RetireRegistry()
    registry.note([declared('77-strip', 'done'), declared('78-table', 'done')], INDEX, NOW)

    // Long after the first pair has finished: the ledger has been pruned and the
    // third lane cuts immediately, rather than being queued behind history.
    const late = NOW + 10 * CUT.totalMs
    registry.note([declared('79-ledger', 'done')], INDEX, late)
    expect(registry.progress(DONE_FLEET, late, 'full').get('lane-c')?.stage).toBe('tension')
  })
})

describe('the scar never fades to nothing', () => {
  it('holds every one of its inks clear of the floor', () => {
    // The research law, and the reason it is a law: invisible completion is
    // indistinguishable from a render bug, and the operator cannot tell which of
    // the two they are looking at.
    for (const [name, value] of Object.entries(SCAR)) {
      expect(luminance(value), `${name} is invisible`).toBeGreaterThan(SCAR_FLOOR)
    }
  })

  it('keeps the name readable, in ice rather than in scar tissue', () => {
    // A scar exists to be identified. One whose name went the colour of the
    // remnant has deleted the lane while pretending not to.
    expect(luminance(SCAR.name)).toBeGreaterThan(luminance(SCAR.thread) * 2)
  })

  it('holds the remnant under the living fleet — a retired lane cannot out-read a working one', () => {
    expect(luminance(SCAR.thread)).toBeLessThan(0.15)
  })

  it('desaturates monotonically into the scar and stops there', () => {
    const living = SCAR.name
    let previous = -1
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = luminance(toward(living, SCAR.thread, t))
      expect(value).toBeLessThanOrEqual(previous < 0 ? Infinity : previous + 1e-12)
      previous = value
    }
    expect(toward(living, SCAR.thread, 1)).toEqual(SCAR.thread)
    expect(toward(living, SCAR.thread, 0)).toEqual(living)
  })
})
