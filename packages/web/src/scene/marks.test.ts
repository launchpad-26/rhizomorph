import { createEvent, reduceAll } from '@observatory/core'
import { describe, expect, it } from 'vitest'
import {
  buildFleet,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type Fleet,
  type FixtureSpec,
} from '../fleet/index.js'
import { RECENCY_SPAN_MS, layoutScene } from './geometry.js'
import { ALARM, EVENT, allowance } from './motion.js'
import {
  brightnessOf,
  breathOf,
  inksOf,
  motionMode,
  sceneMarks,
  type Mark,
  type MarkRole,
  type SceneFrame,
} from './marks/index.js'
import { ALARM_FLOOR, CALM_CEILING, CALM_FLOOR, RECEDE, salienceOf } from './salience.js'
import { BROKEN, NEEDS_YOU, NOTICE } from './palette.js'
import { PulseField } from './pulses.js'
import type { LaneIndex } from './resolve.js'

/**
 * WHAT THE PICTURE CONTAINS.
 *
 * The scene draws through a display list, so every claim the prd makes about
 * the encodings is a query over data rather than an interpretation of a
 * screenshot. That is the whole reason for the `marks/` seam: "the frozen lane
 * is dark, dashed and cut" is checkable, and stays checkable after somebody
 * retunes a brightness.
 *
 * The fleet under test is the staged-pathology fixture, whose faults are found
 * by the real detectors reading real events — nothing here tells the model what
 * is wrong with which lane.
 */

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0)
const SIZE = { width: 900, height: 260 }

const LANE = {
  looping: '41-retry-parser',
  frozen: '42-otel-receiver',
  waiting: '43-drawer-attach',
  expensive: '44-scene-pulses',
  offFence: '45-ledger-subrows',
  victim: '46-spend-selectors',
  healthy: '47-format-module',
} as const

function fleetFor(spec: FixtureSpec, manifest = true): Fleet {
  const state = reduceAll(fixtureHistory(spec, NOW))
  return buildFleet(state, { now: NOW, ...(manifest ? { manifest: manifestFor(spec) } : {}) })
}

interface FrameOptions {
  fleet?: Fleet
  field?: PulseField
  reducedMotion?: boolean
  paused?: boolean
  selectedId?: string | null
  hoverId?: string | null
  /** For the aging and motion suites: a clock other than the fleet's own. */
  now?: number
}

function frameFor(options: FrameOptions = {}): SceneFrame {
  const fleet = options.fleet ?? fleetFor(pathologySpec())
  const reducedMotion = options.reducedMotion ?? false
  const paused = options.paused ?? false
  const now = options.now ?? NOW
  const mode = motionMode({ reducedMotion, paused })

  return {
    fleet,
    geometry: layoutScene(fleet, { ...SIZE, now }),
    field: options.field ?? new PulseField(),
    salience: salienceOf({
      fleet,
      hoverId: options.hoverId ?? null,
      selectedId: options.selectedId ?? null,
    }),
    now,
    reducedMotion,
    paused,
    breath: breathOf(now, mode),
  }
}

function marksFor(options: FrameOptions = {}): Mark[] {
  return sceneMarks(frameFor(options))
}

/** The lane lookup the pulse field resolves events through, for a real fleet. */
function indexFor(fleet: Fleet): LaneIndex {
  return {
    byBranch: new Map(fleet.lanes.map((lane) => [lane.branch ?? lane.id, lane.id])),
    byWorktree: new Map(),
    byHandle: new Map(fleet.lanes.flatMap((lane) => lane.handles.map((h) => [h, lane.id]))),
    mainBranch: fleet.root.mainBranch,
    mainWorktree: fleet.root.worktreePath,
  }
}

/**
 * How much room the waiting lane's held light takes up — the throb, as one
 * number. Summed rather than maxed because the throb is spent across several
 * glows at once and one of them (the hand's halo) is a fixed size.
 */
function heldSpread(marks: readonly Mark[]): number {
  return of(marks, LANE.waiting, 'held').reduce(
    (total, mark) => total + (mark.kind === 'glow' ? mark.radius : 0),
    0,
  )
}

function of(marks: readonly Mark[], laneId: string, ...roles: MarkRole[]): Mark[] {
  return marks.filter((mark) => mark.laneId === laneId && roles.includes(mark.role))
}

/** The brightest thing a lane puts on screen — the salience comparison's unit. */
function brightest(marks: readonly Mark[], laneId: string): number {
  const mine = marks.filter((mark) => mark.laneId === laneId)
  expect(mine.length, `${laneId} drew nothing`).toBeGreaterThan(0)
  return Math.max(...mine.map(brightnessOf))
}

describe('the five pathologies, found and rendered', () => {
  const marks = marksFor()

  it('LOOPING — a knot in the thread with a pulse orbiting it', () => {
    expect(of(marks, LANE.looping, 'knot').length).toBeGreaterThan(0)
    expect(of(marks, LANE.looping, 'orbit').length).toBeGreaterThan(0)
    // A closed circuit: the light comes back to where it started, never home.
    const ring = of(marks, LANE.looping, 'knot').find((mark) => mark.kind === 'arc')
    expect(ring).toBeDefined()
  })

  it('FROZEN — a dark dashed thread with two cut strokes and a hollow node', () => {
    const thread = of(marks, LANE.frozen, 'thread')[0]
    expect(thread?.kind).toBe('ribbon')
    expect(thread?.kind === 'ribbon' && thread.dashed).toBe(true)

    expect(of(marks, LANE.frozen, 'cut')).toHaveLength(2)
    const node = of(marks, LANE.frozen, 'node')[0]
    expect(node?.kind === 'path' && node.stroke !== undefined).toBe(true)
  })

  it('WAITING — a held pulse and a raised hand, on a thread that is still lit', () => {
    expect(of(marks, LANE.waiting, 'held').length).toBeGreaterThan(0)
    expect(of(marks, LANE.waiting, 'raised-hand').length).toBeGreaterThan(0)

    const thread = of(marks, LANE.waiting, 'thread')[0]
    expect(thread?.kind === 'ribbon' && thread.dashed).toBeUndefined()
  })

  it('EXPENSIVE — a white-hot thread with rising chevrons', () => {
    expect(of(marks, LANE.expensive, 'heat').length).toBeGreaterThan(0)
    expect(of(marks, LANE.expensive, 'chevron')).toHaveLength(3)
  })

  it('OFF-FENCE — a barbed rogue filament through a fence at the victim', () => {
    expect(of(marks, LANE.offFence, 'rogue')).toHaveLength(1)
    expect(of(marks, LANE.offFence, 'rogue-barb').length).toBeGreaterThan(0)

    const fence = of(marks, LANE.offFence, 'fence')
    expect(fence.length).toBeGreaterThan(0)
    // Drawn around the *victim's* node: off-fence is a two-party fact and the
    // picture names both.
    const victim = frameFor().geometry.byLane.get(LANE.victim)
    const arc = fence.find((mark) => mark.kind === 'arc')
    expect(arc?.kind === 'arc' && arc.at).toEqual(victim?.node)
  })

  it('leaves a healthy lane with none of them', () => {
    expect(
      of(marks, LANE.healthy, 'knot', 'cut', 'held', 'raised-hand', 'chevron', 'rogue', 'heat'),
    ).toHaveLength(0)
    expect(of(marks, LANE.healthy, 'thread').length).toBeGreaterThan(0)
  })

  it('declares OFF-FENCE unavailable without a manifest, rather than guessing', () => {
    // Ruling 19: no `.swarm/lanes.json` means there is no fence to cross, so the
    // scene says so in the gap voice instead of inferring one from a lane name.
    const unfenced = marksFor({ fleet: fleetFor(pathologySpec(), false) })
    expect(unfenced.filter((mark) => mark.role === 'rogue')).toHaveLength(0)

    const gap = unfenced.filter((mark) => mark.role === 'gap')
    expect(gap).toHaveLength(1)
    expect(gap[0]?.kind === 'text' && gap[0].text).toMatch(/off-fence unavailable/i)
  })
})

describe('FROZEN and WAITING, separated on three axes', () => {
  const marks = marksFor()

  it('dark vs light: the frozen thread is dimmer than the waiting one', () => {
    // Compared with each lane hovered in turn, so both are at full emphasis.
    // Otherwise the frozen lane's own spotlight — it is the worst rung, so it
    // has one — would be doing the arguing instead of the encoding.
    const lit = (laneId: string): number =>
      brightnessOf(of(marksFor({ hoverId: laneId }), laneId, 'thread')[0] as Mark)
    expect(lit(LANE.frozen)).toBeLessThan(lit(LANE.waiting))
  })

  it('broken vs continuous: one thread is dashed and the other is whole', () => {
    const dashed = (laneId: string): boolean => {
      const thread = of(marks, laneId, 'thread')[0]
      return thread?.kind === 'ribbon' && thread.dashed === true
    }
    expect(dashed(LANE.frozen)).toBe(true)
    expect(dashed(LANE.waiting)).toBe(false)
  })

  it('cut vs raised: one is severed across, the other stands up off its node', () => {
    expect(of(marks, LANE.frozen, 'cut').length).toBeGreaterThan(0)
    expect(of(marks, LANE.frozen, 'raised-hand')).toHaveLength(0)
    expect(of(marks, LANE.waiting, 'raised-hand').length).toBeGreaterThan(0)
    expect(of(marks, LANE.waiting, 'cut')).toHaveLength(0)
  })
})

describe('the contrast budget — spotlight, not shouting', () => {
  it('never lets a white-hot lane outshine a summons (graft g6)', () => {
    // The scar A recorded, asserted on the staged fixture. EXPENSIVE is lawful
    // luminance rather than a fifth hue, so nothing stops it being the brightest
    // thing on the page except this.
    const marks = marksFor()
    expect(brightest(marks, LANE.expensive)).toBeLessThan(brightest(marks, LANE.waiting))
    expect(brightest(marks, LANE.expensive)).toBeLessThan(brightest(marks, LANE.looping))
  })

  it('holds every calm mark under the ceiling the ladder owns', () => {
    const marks = marksFor()
    const calm = marks.filter((mark) => !mark.alarm)
    for (const mark of calm) {
      expect(brightnessOf(mark), `${mark.role} broke the calm ceiling`).toBeLessThanOrEqual(
        CALM_CEILING + 1e-9,
      )
    }
  })

  it('exempts alarm marks from every fade (graft g2)', () => {
    // The frozen lane holds the spotlight (it is the worst rung), so the waiting
    // lane is *not* spotlit — and must still be at full strength.
    const fleet = fleetFor(pathologySpec())
    const spotlit = salienceOf({ fleet, hoverId: null, selectedId: null }).spotlightId
    expect(spotlit).toBe(LANE.frozen)

    const marks = marksFor({ fleet })
    const hand = of(marks, LANE.waiting, 'raised-hand').filter((mark) => mark.kind === 'stroke')
    expect(hand.length).toBeGreaterThan(0)
    for (const mark of hand) {
      expect(mark.alarm).toBe(true)
      expect(brightnessOf(mark)).toBeGreaterThan(CALM_CEILING)
    }
  })

  it('recedes the rest of the fleet once something needs a human', () => {
    const other = of(marksFor(), LANE.healthy, 'thread')[0] as Mark
    const healthyFull = of(
      marksFor({ selectedId: LANE.healthy }),
      LANE.healthy,
      'thread',
    )[0] as Mark

    // One thread, two frames, nothing changed but who holds the light: the
    // ratio is the whole mechanism. Salience is a ratio, not an amount of amber
    // — which is exactly why it survived prd4 handing the calm world hue.
    expect(brightnessOf(other)).toBeLessThan(brightnessOf(healthyFull))
    expect(brightnessOf(other) / brightnessOf(healthyFull)).toBeCloseTo(RECEDE, 2)
  })

  it('puts every needs-you lane inside the band the alarms own (ALARM_FLOOR)', () => {
    // Law 9b's other half. Now that a calm fleet carries hue, "the summons is
    // the loudest thing here" can no longer be argued from colour alone — it is
    // argued from the band, so every amber lane owes it at least one mark.
    const marks = marksFor()
    for (const laneId of [LANE.looping, LANE.waiting, LANE.offFence]) {
      expect(brightest(marks, laneId), `${laneId} never reached the alarm band`).toBeGreaterThanOrEqual(
        ALARM_FLOOR,
      )
    }
  })

  it('lets FROZEN dominate by recession and enclosure, not by brightness', () => {
    // BROKEN is exempt from ALARM_FLOOR: `#ff3d68` only reaches 0.84 by being
    // mixed two-thirds of the way to white, at which point it is pink and has
    // stopped meaning "dead". So a frozen lane's supremacy is bought the three
    // other ways the grammar allows, and all three are asserted here.
    const marks = marksFor()
    const alarms = marks.filter((mark) => mark.laneId === LANE.frozen && mark.alarm)
    const loudest = Math.max(...alarms.map(brightnessOf))

    expect(loudest).toBeLessThan(ALARM_FLOOR)
    // 1. The calm world around it has receded, and it clears what is left of it.
    expect(loudest).toBeGreaterThan(CALM_CEILING * RECEDE)
    const elsewhere = marks.filter(
      (mark) => !mark.alarm && mark.laneId !== null && mark.laneId !== LANE.frozen,
    )
    expect(loudest).toBeGreaterThan(Math.max(...elsewhere.map(brightnessOf)))
    // 2. It holds the spotlight — the ladder's own pick. 3. It is enclosed, and
    //    an enclosure is the one thing nothing calm is ever allowed to wear.
    expect(of(marks, LANE.frozen, 'spotlight').length).toBeGreaterThan(0)
    expect(of(marks, LANE.frozen, 'cartouche').length).toBeGreaterThan(0)
  })

  it('dims nothing at all when the fleet is calm', () => {
    // A calm fleet is not a fleet with a winner. Picking one anyway would teach
    // the operator that the spotlight means nothing.
    const fleet = fleetFor(fleet20Spec())
    expect(fleet.rank).toBe('calm')
    expect(salienceOf({ fleet, hoverId: null, selectedId: null }).spotlightId).toBeNull()

    const marks = marksFor({ fleet })
    const threads = marks.filter((mark) => mark.role === 'thread')
    expect(threads).toHaveLength(20)
    expect(Math.min(...threads.map(brightnessOf))).toBeGreaterThan(0)
  })

  it('gives a clicked lane the spotlight the ladder would have kept', () => {
    const marks = marksFor({ selectedId: LANE.healthy })
    expect(of(marks, LANE.healthy, 'spotlight').length).toBeGreaterThan(0)
    expect(of(marks, LANE.frozen, 'spotlight')).toHaveLength(0)
  })
})

describe('prefers-reduced-motion', () => {
  const field = new PulseField()

  it('swaps travelling light for a standing brightness gradient', () => {
    // Same facts, same directions, no movement.
    const fleet = fleetFor(pathologySpec())
    const moving = new PulseField()
    const still = new PulseField()
    for (const target of [moving, still]) {
      target.ingest(
        fixtureHistory(pathologySpec(), NOW).filter((event) => event.type === 'llm.usage').slice(-6),
        indexFor(fleet),
        // Half a second ago, so at the frame's clock they are mid-journey. A
        // pulse born exactly now has not travelled and is not yet drawn.
        NOW - 500,
      )
    }

    const withMotion = sceneMarks(frameFor({ fleet, field: moving }))
    const without = sceneMarks(frameFor({ fleet, field: still, reducedMotion: true }))

    expect(withMotion.filter((mark) => mark.role === 'pulse').length).toBeGreaterThan(0)
    expect(without.filter((mark) => mark.role === 'pulse')).toHaveLength(0)

    const gradient = without.filter((mark) => mark.role === 'thread-flow')
    expect(gradient.length).toBeGreaterThan(0)
    expect(gradient[0]?.kind === 'ribbon' && gradient[0].paint).toHaveProperty('type', 'linear')
  })

  it('keeps the waiting lane a static bright dot and a raised hand', () => {
    const marks = marksFor({ reducedMotion: true, field })
    expect(of(marks, LANE.waiting, 'held').length).toBeGreaterThan(0)
    expect(of(marks, LANE.waiting, 'raised-hand').length).toBeGreaterThan(0)
  })

  it('holds the breath at rest', () => {
    expect(breathOf(NOW, 'reduced')).toBe(1)
    expect(breathOf(NOW + 1_350, 'full')).not.toBe(1)
  })

  it('still draws every lane, every node and every name', () => {
    const marks = marksFor({ reducedMotion: true, field })
    expect(marks.filter((mark) => mark.role === 'thread')).toHaveLength(9)
    expect(marks.filter((mark) => mark.role === 'node')).toHaveLength(9)
    expect(marks.filter((mark) => mark.role === 'label')).toHaveLength(9)
  })

  it('jump-cuts the looping wheel to the notch instead of easing it round', () => {
    // The sanctioned degradation for a position that would otherwise animate its
    // way to a solved value: show the solved value. The circuit is still drawn,
    // the light is still on it, and nothing travels.
    const fleet = fleetFor(pathologySpec())
    const halfway = new PulseField()
    halfway.ingest(
      [
        createEvent(
          'tool.activity',
          { lane: LANE.looping, tool: 'Read', role: 'worker', branch: LANE.looping, thread: 'main' },
          { id: 'reduced-orbit', ts: NOW },
        ),
      ],
      indexFor(fleet),
      NOW,
    )
    // One frame of easing: the drawn phase is between zero and the notch.
    halfway.step(NOW)
    halfway.step(NOW + 60)

    const eased = orbitAngle(marksFor({ fleet, field: halfway }))
    const cut = orbitAngle(marksFor({ fleet, field: halfway, reducedMotion: true }))
    expect(eased).not.toBeCloseTo(cut, 6)
  })

  it('keeps the whole table: colour and opacity survive, travel and scale do not', () => {
    for (const motionClass of ['ambient', 'event', 'structural'] as const) {
      const table = allowance(motionClass, 'reduced')
      expect(table.travel).toBe(false)
      expect(table.scale).toBe(false)
      expect(table.colour).toBe(true)
      expect(table.opacity).toBe(true)
    }
  })
})

/** Where the looping lane's orbiting light is, as an angle about its knot. */
function orbitAngle(marks: readonly Mark[]): number {
  const geometry = frameFor().geometry.byLane.get(LANE.looping)
  const knot = geometry?.knot as { centre: { x: number; y: number } }
  const light = of(marks, LANE.looping, 'orbit').find(
    (mark) => mark.kind === 'glow' && mark.radius < 5,
  )
  const at = light?.kind === 'glow' ? light.at : { x: 0, y: 0 }
  return Math.atan2(at.y - knot.centre.y, at.x - knot.centre.x)
}

/**
 * PAUSE (WCAG 2.2.2) — the scene's own half of it.
 *
 * The component implements the pause by holding its clock still, which is what
 * actually stops travelling light. These are the marks that must hold still
 * *even if the clock does not*: everything a future frame loop could keep
 * advancing without noticing it had been asked to stop.
 */
describe('paused', () => {
  it('stops the root-mass breathing', () => {
    expect(breathOf(NOW, 'paused')).toBe(1)
    expect(breathOf(NOW + 1_350, 'paused')).toBe(1)
    // Which reaches the picture: the node lens is scaled by the breath.
    const lens = (now: number): number => {
      const mark = of(marksFor({ paused: true, now }), LANE.healthy, 'node')[0]
      return mark?.kind === 'path' ? mark.size : NaN
    }
    expect(lens(NOW)).toBe(lens(NOW + 1_350))
  })

  it('stops the summons throbbing, and stops it bright', () => {
    // Sampled across more than a full cycle, with the clock advancing — which is
    // *not* what the component does (it holds the clock still), and that is the
    // point: the throb must be off even if something later forgets to freeze it.
    const window = (paused: boolean): number[] =>
      Array.from({ length: 24 }, (_unused, i) => heldSpread(marksFor({ paused, now: NOW + i * 60 })))

    const held = window(true)
    const moving = window(false)
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values)

    expect(spread(held)).toBeLessThan(0.1)
    expect(spread(moving)).toBeGreaterThan(3)

    // Bright, not wherever the wave happened to be: an alarm frozen at the dim
    // end of its own throb would be a summons the pause had quietened.
    expect(Math.min(...held)).toBeGreaterThan(Math.min(...moving))
  })
})

/**
 * RULING 5, THE SCENE HALF — an unanswered summons ages.
 *
 * The rate law is pinned as arithmetic in `motion.test.ts`; what this suite
 * holds is that it reaches the picture, that it stops where the ruling said it
 * stops, and that it never buys its intensity out of the alarm band's floor.
 */
describe('the alarm ages', () => {
  /**
   * Every alpha the waiting lane's held light is drawn with. Alphas rather than
   * radii on purpose: the throb spends *size*, the aging spends *brightness*, so
   * this reads the aging with the oscillation filtered out.
   */
  const heldAlpha = (now: number): number =>
    of(marksFor({ now }), LANE.waiting, 'held').reduce(
      (total, mark) => total + inksOf(mark).reduce((sum, tint) => sum + tint.alpha, 0),
      0,
    )

  it('brightens the longer nobody comes', () => {
    const fresh = heldAlpha(NOW)
    const stale = heldAlpha(NOW + RECENCY_SPAN_MS / 2)
    const old = heldAlpha(NOW + RECENCY_SPAN_MS)

    expect(stale).toBeGreaterThan(fresh)
    expect(old).toBeGreaterThan(stale)
  })

  it('stops brightening at the cap rather than climbing for ever', () => {
    expect(heldAlpha(NOW + RECENCY_SPAN_MS * 3)).toBeCloseTo(heldAlpha(NOW + RECENCY_SPAN_MS), 9)
  })

  it('never spends the alarm band to do it', () => {
    // The palm and the held core are the marks that owe `ALARM_FLOOR` its floor.
    // A young summons must clear it exactly as an old one does — the aging is a
    // gradient inside the band, never a way in and out of it.
    for (const now of [NOW, NOW + RECENCY_SPAN_MS]) {
      const marks = marksFor({ now })
      expect(brightest(marks, LANE.waiting)).toBeGreaterThanOrEqual(ALARM_FLOOR)
    }
  })

  it('throbs, and throbs slower than it did when it was fresh', () => {
    // Sampled across a window longer than either period: the fresh summons runs
    // more complete cycles through it than the old one. Slower, never faster.
    const peaks = (from: number): number => {
      const window = Array.from({ length: 61 }, (_unused, i) =>
        heldSpread(marksFor({ now: from + i * 100 })),
      )
      let count = 0
      for (let i = 1; i < window.length - 1; i += 1) {
        const before = window[i - 1] as number
        const here = window[i] as number
        if (here > before && here >= (window[i + 1] as number)) count += 1
      }
      return count
    }

    const fresh = peaks(NOW)
    expect(fresh).toBeGreaterThan(1)
    expect(peaks(NOW + RECENCY_SPAN_MS)).toBeLessThan(fresh)
  })

  it('pulses inside the event class, never faster than its own floor', () => {
    expect(ALARM.freshPeriodMs).toBe(2 * EVENT.maxPulseMs)
    expect(ALARM.agedPeriodMs).toBeGreaterThan(ALARM.freshPeriodMs)
  })
})

/**
 * THE MOTION CAP, IN THE PICTURE (ruling 4).
 *
 * `pulses.test.ts` holds the field's side — five animations, the rest folded
 * into counts. This is the half that matters to somebody looking at the screen:
 * that the count is *drawn*, so the coalescing is legible rather than merely
 * honest in a data structure nobody can see.
 */
describe('a storm of arrivals', () => {
  const fleet = fleetFor(pathologySpec())

  function stormField(count: number): PulseField {
    const field = new PulseField()
    for (let i = 0; i < count; i += 1) {
      field.ingest(
        [
          createEvent(
            'commit.landed',
            {
              sha: `storm-${i}`,
              branch: LANE.healthy,
              message: 'feat: another step',
              author: { name: 'agent', email: 'agent@observatory' },
              files: [{ path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 }],
            },
            { id: `storm-${i}`, ts: NOW },
          ),
        ],
        indexFor(fleet),
        // Half a second ago, so they are mid-journey at the frame's clock.
        NOW - 500,
      )
    }
    return field
  }

  it('draws five packets and a count, not twenty packets', () => {
    const marks = marksFor({ fleet, field: stormField(20) })
    const packets = of(marks, LANE.healthy, 'pulse').filter((mark) => mark.kind === 'glow')
    const counts = of(marks, LANE.healthy, 'pulse').filter((mark) => mark.kind === 'text')

    // Two glows per packet — the halo and the head — so five journeys is ten.
    expect(packets.length).toBeLessThanOrEqual(EVENT.maxConcurrent * 2)
    expect(counts).toHaveLength(1)
    expect(counts[0]?.kind === 'text' && counts[0].text).toBe(`×${20 - (EVENT.maxConcurrent - 1)}`)
  })

  it('says the count in mono, because a count is a figure (law 11)', () => {
    const count = of(marksFor({ fleet, field: stormField(8) }), LANE.healthy, 'pulse').find(
      (mark) => mark.kind === 'text',
    )
    expect(count?.kind === 'text' && count.font).toBe('mono')
  })

  it('counts nothing on a quiet lane — one event is one packet', () => {
    const marks = marksFor({ fleet, field: stormField(1) })
    expect(of(marks, LANE.healthy, 'pulse').filter((mark) => mark.kind === 'text')).toHaveLength(0)
  })
})

describe('the root-mass', () => {
  it('sits at its floor when nobody instrumented the conductor', () => {
    // The words belong to the gap voice (law 12); the scene's job is not to fake
    // the light. An un-instrumented conductor reads as dim, not as calm.
    const fleet = fleetFor(pathologySpec())
    const dark = { ...fleet, root: { ...fleet.root, conductorOutputTokens: 0 } }

    const glow = (of: Fleet): number => {
      const marks = marksFor({ fleet: of }).filter(
        (mark) => mark.role === 'root-core' || mark.role === 'root-halo',
      )
      expect(marks.length).toBeGreaterThan(0)
      return Math.max(...marks.map(brightnessOf))
    }

    expect(glow(dark)).toBeLessThan(glow(fleet))
    // Dim, not absent: the mass is still the thing every thread is threaded to.
    expect(glow(dark)).toBeGreaterThan(0)
  })

  it('names the branch it is, in mono (law 11)', () => {
    const label = marksFor().find((mark) => mark.role === 'root-label')
    expect(label?.kind === 'text' && label.text).toBe('MAIN')
    expect(label?.kind === 'text' && label.font).toBe('mono')
  })
})

describe('render everything — ruling 22, at twenty lanes', () => {
  const marks = marksFor({ fleet: fleetFor(fleet20Spec()) })

  it('threads, nodes and names all twenty', () => {
    expect(marks.filter((mark) => mark.role === 'thread')).toHaveLength(20)
    expect(marks.filter((mark) => mark.role === 'node')).toHaveLength(20)
    expect(marks.filter((mark) => mark.role === 'label')).toHaveLength(20)
  })

  it('files every figure as mono and every name as sans (law 11)', () => {
    const text = marks.filter((mark) => mark.kind === 'text')
    for (const mark of text) {
      if (mark.kind !== 'text') continue
      const expected = mark.role === 'label' ? 'sans' : 'mono'
      expect(mark.font, `${mark.role} used the wrong family`).toBe(expected)
    }
  })

  it('wears no alarm ink, because nothing is wrong (law 9b)', () => {
    // Prd3's version of this law said a calm fleet wears no hue at all, which is
    // what ruling 3 overturned: a working fleet may be green. What it may not do
    // is wear *alarm* ink — the full-strength rung colours, or the band above
    // the calm ceiling. Attention is bought by the band and the grammar now, so
    // the band is what the law defends.
    const alarmInk = [NOTICE, NEEDS_YOU, BROKEN].map(String)
    for (const mark of marks) {
      expect(mark.alarm, `${mark.role} claimed alarm on a calm fleet`).toBe(false)
      expect(brightnessOf(mark), `${mark.role} broke into the alarm band`).toBeLessThanOrEqual(
        CALM_CEILING + 1e-9,
      )
      for (const value of inksOf(mark)) {
        expect(alarmInk, `${mark.role} wore alarm ink on a calm fleet`).not.toContain(
          String(value.rgb),
        )
      }
    }
  })

  it('renders every thread bright enough to actually read (CALM_FLOOR)', () => {
    // Prd4's opening complaint, pinned. Ruling 22 says render everything, and a
    // thread rendered at a brightness nobody can trace back to the mass has not
    // really been rendered — so "twenty lanes are all drawn" and "twenty lanes
    // are all legible" are now the same assertion.
    const threads = marks.filter((mark) => mark.role === 'thread')
    expect(threads).toHaveLength(20)
    for (const thread of threads) {
      expect(brightnessOf(thread)).toBeGreaterThanOrEqual(CALM_FLOOR)
    }
  })

  it('says what the fleet is doing in a colour a stranger can guess (law 9a)', () => {
    // The layman bar (ruling 1) as arithmetic: somebody who has never seen the
    // instrument should read a working lane as working. Green is the guess they
    // will make, so the display list has to be green — dominantly, at the node
    // where they are already looking, without a legend.
    const working = fleetFor(fleet20Spec()).lanes.filter((lane) => lane.activity === 'working')
    expect(working.length).toBeGreaterThan(0)

    for (const lane of working) {
      const node = of(marks, lane.id, 'node')[0]
      expect(node, `${lane.id} drew no node`).toBeDefined()
      const [r, g, b] = (node as Mark).kind === 'path' ? inksOf(node as Mark)[0]!.rgb : [0, 0, 0]
      expect(g, `${lane.id}'s node was not green-dominant`).toBeGreaterThan(Math.max(r, b))
    }
  })
})
