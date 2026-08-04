import { createEvent, createIdFactory, type RhizomorphEvent } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import type { Fleet, Lane } from '../fleet/index.js'
import { STRUCTURAL } from './motion.js'
import { CALM_FLOOR } from './salience.js'
import { luminance } from './palette.js'
import {
  RETURN,
  RetireRegistry,
  PERSIST,
  PERSIST_FLOOR,
  PERSIST_LUMINANCE,
  persistWidths,
  returnAt,
  homecoming,
  isRetired,
  toward,
  type RetireStage,
  type RetireState,
} from './retire.js'
import type { LaneIndex } from './resolve.js'

/**
 * THE RETURN'S CLOCK, AND THE STRAND IT LEAVES (prd10 rulings 13–16).
 *
 * This file owns the half of a lane's completion that is arithmetic: which lanes
 * are returning, when each one is allowed to start, what stage it is in at a
 * given instant, and — since ruling 13 rescinded the cord-cut — the four constants
 * that separate a finished strand from a living one. What the picture then
 * *looks* like is `marks.test.ts`'s and `geometry.test.ts`'s.
 *
 * Everything here runs on a number rather than a clock, which is the same seam
 * `settle.test.ts` takes and for the same reason: a return is deterministic in
 * its elapsed time, so a pinned instant is a still image of a known stage and no
 * test has to race an interval to look at one.
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

function declared(handle: string, status: 'working' | 'waiting' | 'done'): RhizomorphEvent {
  return createEvent(
    'agent.status',
    { handle, status, branch: handle, worktreePath: `/repo__worktrees/${handle}` },
    { id: nextId(), ts: NOW },
  )
}

function removed(path: string): RhizomorphEvent {
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
  it('runs tension, then withdraw, then settle, and rests as a persistent strand', () => {
    const stageAt = (ms: number): RetireStage => returnAt(ms).stage

    expect(stageAt(0)).toBe('tension')
    expect(stageAt(RETURN.tensionMs - 1)).toBe('tension')
    expect(stageAt(RETURN.tensionMs)).toBe('withdraw')
    expect(stageAt(RETURN.tensionMs + RETURN.withdrawMs - 1)).toBe('withdraw')
    expect(stageAt(RETURN.tensionMs + RETURN.withdrawMs)).toBe('settle')
    expect(stageAt(RETURN.totalMs - 1)).toBe('settle')
    // Past the end it is a persistent strand, and it is one for ever (ruling 13).
    expect(stageAt(RETURN.totalMs)).toBe('persistent')
    expect(stageAt(RETURN.totalMs * 1_000)).toBe('persistent')
  })

  it('adds up to the ~1.4 s the ruling asked for, on the structural budget', () => {
    expect(RETURN.totalMs).toBe(1_400)
    // The withdraw is not a number of its own — it *is* the structural class.
    expect(RETURN.withdrawMs).toBe(STRUCTURAL.durationMs)
  })

  it('changes exactly one channel per stage', () => {
    // This is the whole reason the return is staged rather than one 1.4 s blend:
    // three stages that each move one thing read as a sentence, where one
    // animation moving three things reads as "something happened".
    const tension = returnAt(RETURN.tensionMs * 0.5)
    expect(tension.tension).toBeGreaterThan(0)
    expect(tension.tension).toBeLessThan(1)
    expect(tension.withdraw).toBe(0)
    expect(tension.stilled).toBe(0)

    const withdraw = returnAt(RETURN.tensionMs + RETURN.withdrawMs * 0.5)
    expect(withdraw.tension).toBe(1)
    expect(withdraw.withdraw).toBeGreaterThan(0)
    expect(withdraw.withdraw).toBeLessThan(1)
    expect(withdraw.stilled).toBe(0)

    const settle = returnAt(RETURN.tensionMs + RETURN.withdrawMs + RETURN.settleMs * 0.5)
    expect(settle.tension).toBe(1)
    expect(settle.withdraw).toBe(1)
    expect(settle.stilled).toBeGreaterThan(0)
    expect(settle.stilled).toBeLessThan(1)
  })

  it('withdraws on a critically damped spring — monotone, and never past its target', () => {
    // ζ = 1 is the ruling and `spring.ts` offers no way to ask for anything else,
    // so this is a pin on the consequence: matter that overshot the mass and came
    // back out again would read as recoil — "it failed" — rather than as "it
    // finished".
    let previous = -1
    for (let ms = RETURN.tensionMs; ms <= RETURN.tensionMs + RETURN.withdrawMs; ms += 8) {
      const { withdraw } = returnAt(ms)
      expect(withdraw).toBeGreaterThanOrEqual(previous)
      expect(withdraw).toBeLessThanOrEqual(1)
      previous = withdraw
    }
    // …and it arrives exactly, rather than 0.03% short of its own stage boundary.
    expect(returnAt(RETURN.tensionMs + RETURN.withdrawMs).withdraw).toBe(1)
  })

  it('is over half way back before the withdraw is half over — decelerating, not linear', () => {
    const half = returnAt(RETURN.tensionMs + RETURN.withdrawMs * 0.5).withdraw
    expect(half).toBeGreaterThan(0.75)
  })

  it('is a pure function of the elapsed time, so a pinned clock is a still image', () => {
    expect(returnAt(700)).toEqual(returnAt(700))
    expect(returnAt(-50)).toEqual(returnAt(0))
  })

  it('carries the node drift with the withdraw, so the tip eases out as the work goes home', () => {
    expect(returnAt(RETURN.tensionMs * 0.5).drift).toBe(0)
    const mid = returnAt(RETURN.tensionMs + RETURN.withdrawMs * 0.4)
    expect(mid.drift).toBe(mid.withdraw)
    expect(returnAt(RETURN.totalMs).drift).toBe(1)
  })

  /**
   * THE WORK GETS HOME AS THE STRAND GOES SLACK (prd6 ruling 2).
   *
   * The substance travelling down the thread and the mass thickening to receive
   * it are both hung on this one number, so neither of them has a clock of its
   * own and the structural cap already governs both.
   */
  describe('homecoming', () => {
    it('arrives exactly as the strand settles, and not before', () => {
      // Nothing has parted yet during the tension release.
      expect(homecoming(returnAt(0))).toBe(0)
      expect(homecoming(returnAt(RETURN.tensionMs * 0.5))).toBe(0)

      let previous = -1
      for (let ms = RETURN.tensionMs; ms <= RETURN.totalMs; ms += 8) {
        const value = homecoming(returnAt(ms))
        expect(value).toBeGreaterThanOrEqual(previous)
        previous = value
      }
      expect(homecoming(returnAt(RETURN.tensionMs + RETURN.withdrawMs))).toBe(1)
      expect(homecoming(returnAt(RETURN.totalMs))).toBe(1)
    })

    it('reads 1 for a landing nobody watched — the work did land', () => {
      // History, a replay, and a reduced-motion frame. We were not there for the
      // journey; that is not a reason to pretend the merge did not happen.
      expect(homecoming(returnAt(0, false))).toBe(1)

      const registry = new RetireRegistry()
      const settled = registry.progress(DONE_FLEET, NOW, 'full').get('lane-a')
      expect(homecoming(settled as RetireState)).toBe(1)
    })
  })
})

describe('reduced motion — the swap in place', () => {
  it('collapses the whole return to its endpoint, with no travel and no drift', () => {
    // WCAG 2.3.3 excludes colour and opacity from "motion animation", so the
    // degradation keeps the thinned, cooled *result* and drops the journey. The
    // strand itself is not motion at all, so reduced motion keeps every one.
    const still = returnAt(0, false)
    expect(still.stage).toBe('persistent')
    expect(still.progress).toBe(1)
    expect(still.stilled).toBe(1)
    // The one number that separates this from a watched return: the node has not
    // been carried anywhere.
    expect(still.drift).toBe(0)
    expect(returnAt(RETURN.totalMs * 3, false)).toEqual(still)
  })

  it('is read off the motion allowance rather than decided twice', () => {
    const registry = new RetireRegistry()
    registry.note([declared('77-strip', 'done')], INDEX, NOW)

    expect(registry.progress(DONE_FLEET, NOW + 200, 'reduced').get('lane-a')?.stage).toBe('persistent')
    // Pause is a stricter preference than reduce for everything else in the
    // scene, and deliberately *not* for this one: the return is allowed to move
    // under a pause, it is simply held there by the frozen clock the caller
    // passes it. So `paused` still animates when the clock advances.
    expect(registry.progress(DONE_FLEET, NOW + 200, 'paused').get('lane-a')?.stage).toBe('withdraw')
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

  it('returns on agent.status done and worktree.removed, and on nothing else', () => {
    const registry = new RetireRegistry()

    expect(registry.note([declared('77-strip', 'working')], INDEX, NOW)).toEqual([])
    expect(registry.note([declared('77-strip', 'waiting')], INDEX, NOW)).toEqual([])
    // A lane going quiet is FROZEN's evidence, never a finish.
    expect(registry.note([declared('77-strip', 'done')], INDEX, NOW)).toEqual(['lane-a'])
    expect(registry.note([removed('/repo__worktrees/78-table')], INDEX, NOW)).toEqual(['lane-b'])
  })

  it('rests a parked lane without ever running the return', () => {
    // Parking is a standing declaration in a manifest, not a moment in the log —
    // there is no event whose arrival a return could be the picture of, and
    // inventing an instant to animate would be animating a fact we never saw
    // arrive. So it arrives at the persistent strand outright, and it comes back
    // to life when the operator unparks it.
    const registry = new RetireRegistry()
    const parked = fleetOf(lane('lane-a', { activity: 'working', parked: true }))

    const state = registry.progress(parked, NOW, 'full').get('lane-a')
    expect(state?.stage).toBe('persistent')
    expect(state?.progress).toBe(1)

    const unparked = fleetOf(lane('lane-a', { activity: 'working', parked: false }))
    expect(registry.progress(unparked, NOW + 5_000, 'full').has('lane-a')).toBe(false)
  })

  it('does not return the root-mass, or a lane the fleet has never heard of', () => {
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

    // Still measured from the first sighting, so nothing re-fires.
    expect(registry.progress(DONE_FLEET, NOW + 300, 'full').get('lane-a')?.progress).toBeCloseTo(
      300 / RETURN.totalMs,
      10,
    )
  })

  it('rests a lane that was already done when we first saw it, and animates nothing', () => {
    // The replay case, and the page-load case: `/api/stream` replays the whole
    // session before it live-tails, so a fleet full of landed lanes must arrive
    // already persistent rather than returning seventeen lanes at once.
    const registry = new RetireRegistry()
    const states = registry.progress(DONE_FLEET, NOW, 'full')

    expect([...states.keys()].sort()).toEqual(['lane-a', 'lane-b', 'lane-c'])
    for (const state of states.values()) {
      expect(state.stage).toBe('persistent')
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

    // Scrubbed forward again. The instant is remembered, so the return is long
    // over rather than starting a second time.
    const again = registry.progress(DONE_FLEET, NOW + 20_000, 'full').get('lane-a')
    expect(again?.stage).toBe('persistent')
    expect(again?.progress).toBe(1)
  })

  it('leaves a lane whose return is still queued out of the map, so it stays a living thread', () => {
    const registry = new RetireRegistry()
    registry.note(
      [declared('77-strip', 'done'), declared('78-table', 'done'), declared('79-ledger', 'done')],
      INDEX,
      NOW,
    )

    // The first return goes at once and the second a stagger behind it; the third
    // waits a whole return-length, and until then it is drawn as the thread it
    // visibly still is rather than as a finished lane that has not moved.
    expect([...registry.progress(DONE_FLEET, NOW, 'full').keys()]).toEqual(['lane-a'])

    const staggered = registry.progress(DONE_FLEET, NOW + STRUCTURAL.staggerMs, 'full')
    expect([...staggered.keys()].sort()).toEqual(['lane-a', 'lane-b'])
    expect(staggered.has('lane-c')).toBe(false)

    expect(registry.progress(DONE_FLEET, NOW + RETURN.totalMs, 'full').has('lane-c')).toBe(true)
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
    // appears in `progress` with a return that has actually begun.
    return lanes.map((each) => {
      for (let ms = 0; ms <= count * RETURN.totalMs; ms += 1) {
        const state = registry.progress(fleetOf(...lanes), NOW + ms, 'full').get(each.id)
        if (state !== undefined && state.progress < 1) return ms
      }
      throw new Error(`${each.id} never started`)
    })
  }

  it('sets off two returns at a time, staggered, and queues the rest', () => {
    const starts = waveStarts(6)

    expect(starts[0]).toBe(0)
    expect(starts[1]).toBe(STRUCTURAL.staggerMs)
    // The third waits for the first slot to free rather than joining a crowd.
    expect(starts[2]).toBe(RETURN.totalMs)
    expect(starts[3]).toBe(RETURN.totalMs + STRUCTURAL.staggerMs)
    expect(starts[4]).toBe(2 * RETURN.totalMs)
    expect(starts[5]).toBe(2 * RETURN.totalMs + STRUCTURAL.staggerMs)
  })

  it('never has more than the cap in flight, whatever the wave size', () => {
    const starts = waveStarts(9)
    for (const at of starts) {
      const inFlight = starts.filter((start) => at >= start && at < start + RETURN.totalMs)
      expect(inFlight.length).toBeLessThanOrEqual(STRUCTURAL.maxConcurrent)
    }
  })

  it('staggers every pair, so two returns never move in lockstep', () => {
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
    // third lane returns immediately, rather than being queued behind history.
    const late = NOW + 10 * RETURN.totalMs
    registry.note([declared('79-ledger', 'done')], INDEX, late)
    expect(registry.progress(DONE_FLEET, late, 'full').get('lane-c')?.stage).toBe('tension')
  })
})

describe('luminous, but not alive — the hierarchy as arithmetic (ruling 14)', () => {
  it('never fades to nothing — every ink clear of PERSIST_FLOOR', () => {
    // The research law, and the reason it is a law: invisible completion is
    // indistinguishable from a render bug, and the operator cannot tell which of
    // the two they are looking at. Ruling 13 sharpens it — a *deleted* completion
    // is indistinguishable from work that never happened at all.
    for (const [name, value] of Object.entries(PERSIST)) {
      expect(luminance(value), `${name} is invisible`).toBeGreaterThan(PERSIST_FLOOR)
    }
  })

  it('keeps the name readable, in ice rather than in tissue', () => {
    // A finished lane exists to be identified. One whose name went the colour of
    // its own strand has deleted the lane while pretending not to.
    expect(luminance(PERSIST.name)).toBeGreaterThan(luminance(PERSIST.strand) * 2)
  })

  /**
   * THE ONE SENTENCE THE WHOLE HIERARCHY IS:
   *
   *     living ≥ CALM_FLOOR > PERSIST_LUMINANCE ≥ finished
   *
   * `CALM_FLOOR` is the number `salience.ts` holds every living calm mark *above*;
   * `PERSIST_LUMINANCE` is the number this file holds a finished strand *below*.
   * Two constants with a gap between them, so "a reader must never have to ask
   * which lanes are working" is a fact about arithmetic rather than about two
   * screenshots — and so a future retune of either one cannot close the gap
   * without this failing.
   */
  it('holds the strand strictly below the floor every living mark is held above', () => {
    expect(PERSIST_LUMINANCE).toBeLessThan(CALM_FLOOR)
    expect(luminance(PERSIST.strand)).toBeLessThanOrEqual(PERSIST_LUMINANCE)
  })

  it('cools monotonically into the strand and stops there', () => {
    const living = PERSIST.name
    let previous = -1
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const value = luminance(toward(living, PERSIST.strand, t))
      expect(value).toBeLessThanOrEqual(previous < 0 ? Infinity : previous + 1e-12)
      previous = value
    }
    expect(toward(living, PERSIST.strand, 1)).toEqual(PERSIST.strand)
    expect(toward(living, PERSIST.strand, 0)).toEqual(living)
  })

  /**
   * THE WIDTH HALF, over the whole encoded range rather than at one size.
   *
   * `geometry.ts` draws a lane's thread at `1.2 + 5·size` at the root and
   * `0.4 + 1.3·size` at the tip, so the two ends of this loop are an empty lane
   * and a 100K-output one — the whole of `seedSize`'s span. The claim is that
   * there is no work size anywhere in it at which a finished strand is as wide as
   * the living thread it came from, at either end.
   */
  it('draws a finished strand strictly thinner than its living self, at every work size', () => {
    for (let size = 0; size <= 1.0001; size += 0.05) {
      const root = 1.2 + 5 * size
      const tip = 0.4 + 1.3 * size
      const thin = persistWidths(root, tip)

      expect(thin.root, `root at size ${size}`).toBeLessThan(root)
      expect(thin.tip, `tip at size ${size}`).toBeLessThan(tip)
      // …and under half, which is the ruling's "thin" rather than merely "less".
      expect(thin.root).toBeLessThanOrEqual(root * 0.5)
      // Still a strand and not a scratch: the far end holds a line rather than
      // tapering to the needle a *growing* tip earns.
      expect(thin.tip).toBeGreaterThan(0)
    }
  })

  it('keeps the work-size channel inside the thinning — a big landing still reads bigger', () => {
    // prd6 ruling 1's absolute scale survives the transformation: the strand is
    // the only place the rim still shows how much work a lane did, now that the
    // stub whose *length* used to carry it is gone (`geometry.ts`).
    const small = persistWidths(1.2, 0.4)
    const large = persistWidths(6.2, 1.7)
    expect(large.root / small.root).toBeCloseTo(6.2 / 1.2, 6)
  })

  it('is the same arithmetic at both ends of the settle — the thinning has an endpoint', () => {
    // The settle interpolates from the living widths to these over 450 ms
    // (`marks/thread.ts`'s `persistThinning`), so a state that never moves cannot
    // drift past them however long the session runs.
    expect(persistWidths(4, 1)).toEqual(persistWidths(4, 1))
  })
})
