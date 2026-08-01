import { reduceAll } from '@observatory/core'
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
import { layoutScene } from './geometry.js'
import {
  brightnessOf,
  breathOf,
  inksOf,
  sceneMarks,
  type Mark,
  type MarkRole,
  type SceneFrame,
} from './marks/index.js'
import { CALM_CEILING, RECEDE, salienceOf } from './salience.js'
import { BROKEN, NEEDS_YOU, NOTICE } from './palette.js'
import { PulseField } from './pulses.js'

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
  selectedId?: string | null
  hoverId?: string | null
}

function frameFor(options: FrameOptions = {}): SceneFrame {
  const fleet = options.fleet ?? fleetFor(pathologySpec())
  const reducedMotion = options.reducedMotion ?? false

  return {
    fleet,
    geometry: layoutScene(fleet, { ...SIZE, now: NOW }),
    field: options.field ?? new PulseField(),
    salience: salienceOf({
      fleet,
      hoverId: options.hoverId ?? null,
      selectedId: options.selectedId ?? null,
    }),
    now: NOW,
    reducedMotion,
    breath: breathOf(NOW, reducedMotion),
  }
}

function marksFor(options: FrameOptions = {}): Mark[] {
  return sceneMarks(frameFor(options))
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
    const marks = marksFor()
    const spotlit = of(marks, LANE.frozen, 'thread')[0] as Mark
    const other = of(marks, LANE.healthy, 'thread')[0] as Mark

    // Same role, same lane state apart from the spotlight: the ratio is the
    // whole mechanism. Salience is a ratio, not an amount of amber.
    expect(brightnessOf(other)).toBeLessThan(brightnessOf(spotlit))
    const healthyFull = of(
      marksFor({ selectedId: LANE.healthy }),
      LANE.healthy,
      'thread',
    )[0] as Mark
    expect(brightnessOf(other) / brightnessOf(healthyFull)).toBeCloseTo(RECEDE, 2)
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
        {
          byBranch: new Map(fleet.lanes.map((lane) => [lane.branch ?? lane.id, lane.id])),
          byWorktree: new Map(),
          byHandle: new Map(fleet.lanes.flatMap((lane) => lane.handles.map((h) => [h, lane.id]))),
          mainBranch: fleet.root.mainBranch,
          mainWorktree: fleet.root.worktreePath,
        },
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
    expect(breathOf(NOW, true)).toBe(1)
    expect(breathOf(NOW + 1_350, false)).not.toBe(1)
  })

  it('still draws every lane, every node and every name', () => {
    const marks = marksFor({ reducedMotion: true, field })
    expect(marks.filter((mark) => mark.role === 'thread')).toHaveLength(9)
    expect(marks.filter((mark) => mark.role === 'node')).toHaveLength(9)
    expect(marks.filter((mark) => mark.role === 'label')).toHaveLength(9)
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

  it('wears no ladder hue at all, because nothing is wrong (law 9)', () => {
    // Status owns hue. A calm fleet has no status to report, so not one mark in
    // it may reach for cyan, amber or magenta-red — identity differentiates by
    // lightness, shape and position, and by nothing else.
    const rungs = [NOTICE, NEEDS_YOU, BROKEN].map(String)
    for (const mark of marks) {
      for (const value of inksOf(mark)) {
        expect(rungs, `${mark.role} wore a ladder hue on a calm fleet`).not.toContain(
          String(value.rgb),
        )
      }
    }
  })
})
