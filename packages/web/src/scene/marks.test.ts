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
import { RECENCY_SPAN_MS, layoutScene, pointAt, type Point } from './geometry.js'
import { ALARM, EVENT, STRUCTURAL, allowance } from './motion.js'
import {
  brightnessOf,
  breathOf,
  inksOf,
  isLinear,
  motionMode,
  sceneMarks,
  type Mark,
  type MarkRole,
  type SceneFrame,
} from './marks/index.js'
import { ROOT_GROWTH, rootGirth } from './marks/root.js'
import { CUT, SCAR, SCAR_FLOOR, cutAt, type RetireState } from './retire.js'
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
 * is dark, broken and severed" is checkable, and stays checkable after somebody
 * retunes a brightness.
 *
 * Every law below is written in the **semantic** role vocabulary (prd7 ruling 2,
 * `marks/types.ts`): a frozen lane is `severed`, a waiting one carries a
 * `summons`, an expensive one an `expensive-mark`. None of them names a shape,
 * which is the property that lets the picture be redrawn without any of these
 * assertions moving — and, read the other way, the reason a law here can only be
 * broken by the scene meaning something different, never by it looking different.
 *
 * The fleet under test is the staged-pathology fixture, whose faults are found
 * by the real detectors reading real events — nothing here tells the model what
 * is wrong with which lane.
 */

/**
 * The whole pathology vocabulary, as one list: what a lane wears *only* if
 * something is wrong with it. A healthy lane must carry none of these, and the
 * list being complete is what makes that assertion worth making.
 */
const PATHOLOGY_ROLES = [
  'looping-mark',
  'orbit',
  'orbit-wake',
  'severed',
  'held',
  'summons',
  'heat',
  'expensive-mark',
  'off-fence-mark',
  'off-fence-reach',
  'off-fence-grasp',
  'off-fence-victim',
] as const satisfies readonly MarkRole[]

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
  /** For the cord-cut suite: which lanes have left the network, and how far along. */
  retire?: ReadonlyMap<string, RetireState>
  hideFinished?: boolean
}

function frameFor(options: FrameOptions = {}): SceneFrame {
  const fleet = options.fleet ?? fleetFor(pathologySpec())
  const reducedMotion = options.reducedMotion ?? false
  const paused = options.paused ?? false
  const now = options.now ?? NOW
  const mode = motionMode({ reducedMotion, paused })

  return {
    fleet,
    geometry: layoutScene(fleet, {
      ...SIZE,
      now,
      ...(options.retire === undefined ? {} : { retire: options.retire }),
      ...(options.hideFinished === undefined ? {} : { hideFinished: options.hideFinished }),
    }),
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
 * A run of frames a fixed distance apart, for the suites that watch something
 * oscillate.
 *
 * The layout is built **once** and the clock advanced over it. Re-laying the
 * scene out per sample is what these assertions actually cost, and none of them
 * are about the layout: a lane drifts outward over ten minutes, and nothing at
 * this timescale moves it. What does advance is `now`, which is what the throb,
 * the breath and the summons's own age all read.
 */
function sampled(from: number, count: number, stepMs: number, options: FrameOptions = {}): Mark[][] {
  const base = frameFor({ ...options, now: from })
  const mode = motionMode(base)

  return Array.from({ length: count }, (_unused, i) => {
    const now = from + i * stepMs
    return sceneMarks({ ...base, now, breath: breathOf(now, mode) })
  })
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

/**
 * Every point a mark puts in world space, whatever kind it is.
 *
 * A law about *where* something is drawn has no business knowing how it is
 * drawn — that is the whole of prd7 ruling 2, applied to geometry rather than to
 * names. Before this the expensive lane's "the marking rises away from the node"
 * assertion read `mark.points`, which quietly made it a law about strokes; the
 * marking is a ribbon now and the law is unchanged, so the reading is what had
 * to move.
 */
function pointsOf(mark: Mark): Point[] {
  switch (mark.kind) {
    case 'ribbon':
      return [...mark.path]
    case 'stroke':
      return [...mark.points]
    case 'glow':
    case 'arc':
    case 'path':
    case 'text':
    case 'chip':
      return [mark.at]
  }
}

/** How close a mark comes to a point — the unit "rises away from the node" is in. */
function reachOf(mark: Mark, from: Point): number {
  return Math.min(...pointsOf(mark).map((point) => Math.hypot(point.x - from.x, point.y - from.y)))
}

/**
 * How wide a ribbon is drawn at `t`, measured off the polygon that is actually
 * filled rather than off the width fields that asked for it.
 *
 * The nearest outline vertex to a point on the spine sits one half-width away,
 * so twice that is the drawn width. This is the reading that makes prd7 ruling
 * 4's promise checkable: a lane's encoded facts must be recoverable *from its
 * geometry*, however much bounded variation has been spent on it.
 */
/** How far a point is from a polyline — segments, not just vertices. */
function nearestOn(path: readonly Point[], point: Point): number {
  let best = Infinity
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1] as Point
    const b = path[i] as Point
    const dx = b.x - a.x
    const dy = b.y - a.y
    const span = dx * dx + dy * dy
    const t =
      span === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / span))
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)))
  }
  return best
}

function nearestDrawn(mark: Mark, t: number): number {
  if (mark.kind !== 'ribbon') return NaN
  const on = pointAt(mark.path, t)
  const vertices = mark.outline.flat()
  if (vertices.length === 0) return Infinity
  return Math.min(...vertices.map((v) => Math.hypot(v.x - on.x, v.y - on.y)))
}

function widthNear(mark: Mark, t: number): number {
  return 2 * nearestDrawn(mark, t)
}

/** The brightest thing a lane puts on screen — the salience comparison's unit. */
function brightest(marks: readonly Mark[], laneId: string): number {
  const mine = marks.filter((mark) => mark.laneId === laneId)
  expect(mine.length, `${laneId} drew nothing`).toBeGreaterThan(0)
  return Math.max(...mine.map(brightnessOf))
}

describe('the five pathologies, found and rendered', () => {
  const marks = marksFor()

  it('LOOPING — a closed circuit in the thread, with light going round it', () => {
    expect(of(marks, LANE.looping, 'looping-mark').length).toBeGreaterThan(0)
    expect(of(marks, LANE.looping, 'orbit').length).toBeGreaterThan(0)
    // A *closed* circuit is the encoding, not a decoration on the thread: the
    // light comes back to where it started, and never home.
    const circuit = of(marks, LANE.looping, 'looping-mark').find((mark) => mark.kind === 'arc')
    expect(circuit, 'the looping lane drew no circuit').toBeDefined()
    expect(circuit?.kind === 'arc' ? circuit.to - circuit.from : 0).toBeCloseTo(Math.PI * 2, 9)
  })

  it('FROZEN — severed twice, across a broken thread, at a node no longer filling', () => {
    const thread = of(marks, LANE.frozen, 'thread')[0]
    expect(thread?.kind).toBe('ribbon')
    expect(thread?.kind === 'ribbon' && thread.dashed).toBe(true)

    // Two, and the count is the reading: one stroke is an accident of drawing,
    // two is unmistakably a severing. Held at exactly two so a redraw cannot
    // quietly reduce it to a single hairline.
    expect(of(marks, LANE.frozen, 'severed')).toHaveLength(2)
    const node = of(marks, LANE.frozen, 'node')[0]
    expect(node?.kind === 'path' && node.stroke !== undefined).toBe(true)
  })

  it('WAITING — a summons and light that has stopped, on a thread that is still lit', () => {
    expect(of(marks, LANE.waiting, 'held').length).toBeGreaterThan(0)
    expect(of(marks, LANE.waiting, 'summons').length).toBeGreaterThan(0)

    const thread = of(marks, LANE.waiting, 'thread')[0]
    expect(thread?.kind === 'ribbon' && thread.dashed).toBeUndefined()
  })

  it('EXPENSIVE — a white-hot thread, and heat leaving the tip', () => {
    expect(of(marks, LANE.expensive, 'heat').length).toBeGreaterThan(0)

    // Three, as the old drawing had — but the count was never the law. What the
    // law is: the marking *rises away* from the node and fades as it goes, which
    // is what makes it read as heat leaving rather than as a fixed ladder. The
    // marking is a tapered lick now rather than a chevron (prd7 ruling 3), and
    // the law did not move an inch: `reachOf` reads whatever geometry a mark has.
    const rising = of(marks, LANE.expensive, 'expensive-mark')
    expect(rising).toHaveLength(3)
    const node = of(marks, LANE.expensive, 'node')[0]
    expect(node?.kind).toBe('path')
    const from = node?.kind === 'path' ? node.at : { x: 0, y: 0 }
    const reach = rising.map((mark) => reachOf(mark, from))
    for (let i = 1; i < rising.length; i += 1) {
      expect(reach[i] as number).toBeGreaterThan(reach[i - 1] as number)
      expect(brightnessOf(rising[i] as Mark)).toBeLessThan(brightnessOf(rising[i - 1] as Mark))
    }

    // …and the thread it leaves is needled rather than blunt: direction as a
    // width gradient, which is the substitution the chevrons paid for.
    const thread = of(marks, LANE.expensive, 'thread')[0]
    expect(thread?.kind).toBe('ribbon')
    if (thread?.kind === 'ribbon') expect(widthNear(thread, 1)).toBeLessThan(widthNear(thread, 0.5))
  })

  it('OFF-FENCE — the offender marked, the reach taking hold, the victim fenced', () => {
    // Four marks for a two-party fact, and the test names both parties: without
    // the offender's own marking an off-fence lane would be the only summons in
    // the scene you cannot find by looking at the lane that caused it.
    expect(of(marks, LANE.offFence, 'off-fence-mark').length).toBeGreaterThan(0)
    expect(of(marks, LANE.offFence, 'off-fence-reach')).toHaveLength(1)
    expect(of(marks, LANE.offFence, 'off-fence-grasp').length).toBeGreaterThan(0)

    const breached = of(marks, LANE.offFence, 'off-fence-victim')
    expect(breached.length).toBeGreaterThan(0)
    // Drawn around the *victim's* node: off-fence is a two-party fact and the
    // picture names both.
    const victim = frameFor().geometry.byLane.get(LANE.victim)
    const arc = breached.find((mark) => mark.kind === 'arc')
    expect(arc?.kind === 'arc' && arc.at).toEqual(victim?.node)
  })

  it('leaves a healthy lane with none of them', () => {
    // The whole pathology vocabulary, not a hand-picked seven: a lane with
    // nothing wrong with it carries nothing from the list, whatever is on it.
    expect(of(marks, LANE.healthy, ...PATHOLOGY_ROLES)).toHaveLength(0)
    expect(of(marks, LANE.healthy, 'thread').length).toBeGreaterThan(0)
  })

  it('declares OFF-FENCE unavailable without a manifest, rather than guessing', () => {
    // Ruling 19: no `.swarm/lanes.json` means there is no fence to cross, so the
    // scene says so in the gap voice instead of inferring one from a lane name.
    // Not one of the four marks, at either end of the fact — a guess about the
    // victim would be as wrong as a guess about the offender.
    const unfenced = marksFor({ fleet: fleetFor(pathologySpec(), false) })
    const offFence: MarkRole[] = [
      'off-fence-mark',
      'off-fence-reach',
      'off-fence-grasp',
      'off-fence-victim',
    ]
    expect(unfenced.filter((mark) => offFence.includes(mark.role))).toHaveLength(0)

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

  it('severed vs summoning: one line is cut through, the other is asking for a human', () => {
    // The axis is the pair of meanings, and each lane must carry its own and not
    // the other's — which is what makes the two unconfusable however they are
    // drawn. A future summons that looked nothing like a hand still passes; a
    // frozen lane that started summoning does not.
    expect(of(marks, LANE.frozen, 'severed').length).toBeGreaterThan(0)
    expect(of(marks, LANE.frozen, 'summons')).toHaveLength(0)
    expect(of(marks, LANE.waiting, 'summons').length).toBeGreaterThan(0)
    expect(of(marks, LANE.waiting, 'severed')).toHaveLength(0)
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
    const summons = of(marks, LANE.waiting, 'summons')
    expect(summons.length).toBeGreaterThan(0)

    // The exemption, stated as what it actually is: the same marks, at the same
    // brightness, whether this lane holds the light or another one does. Every
    // one of them — not just whichever happens to be drawn as a line.
    const unfaded = of(marksFor({ fleet, selectedId: LANE.waiting }), LANE.waiting, 'summons')
    expect(unfaded).toHaveLength(summons.length)
    summons.forEach((mark, i) => {
      expect(mark.alarm).toBe(true)
      expect(brightnessOf(mark)).toBe(brightnessOf(unfaded[i] as Mark))
    })
    // …and it is in the band above the calm world, not merely at the top of it.
    expect(Math.max(...summons.map(brightnessOf))).toBeGreaterThan(CALM_CEILING)
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
    expect(of(marks, LANE.frozen, 'rank-enclosure').length).toBeGreaterThan(0)
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
    expect(of(marks, LANE.waiting, 'summons').length).toBeGreaterThan(0)
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
      sampled(NOW, 24, 60, { paused }).map(heldSpread)

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
      const window = sampled(from, 31, 200).map(heldSpread)
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
    const mine = of(marks, LANE.healthy, 'pulse')
    const packets = mine.filter((mark) => mark.kind !== 'text')
    const counts = mine.filter((mark) => mark.kind === 'text')

    // One mark per journey now that a commit is a swell in the thread rather
    // than a dot with a halo (prd7 ruling 3), so five journeys is five — and the
    // assertion is counted over every kind, so a future packet drawn as
    // something else again still has to obey the cap.
    expect(packets.length).toBeGreaterThan(0)
    expect(packets.length).toBeLessThanOrEqual(EVENT.maxConcurrent)
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

  /**
   * IT THICKENS WITH THE SESSION'S LANDED WORK (prd6 ruling 2).
   *
   * The other end of the homeward flow. A merge means the work is part of main
   * now, so the mass it went into is bigger for having taken it — on the same
   * absolute-scale-with-a-hard-cap discipline as ruling 1's seeds, because a mass
   * that could grow without limit would eat the picture it is the centre of.
   */
  describe('thickening with the session work', () => {
    const fleet = fleetFor(fleet20Spec())

    /** The mass's own girth, as the radius of its widest curl. */
    function girthOf(retire?: ReadonlyMap<string, RetireState>): number {
      const marks = marksFor({
        fleet,
        ...(retire === undefined ? {} : { retire }),
      }).filter((mark) => mark.role === 'root-mass')
      expect(marks.length).toBeGreaterThan(0)
      return Math.max(
        ...marks.flatMap((mark) =>
          mark.kind === 'stroke'
            ? mark.points.map((point) => Math.hypot(point.x - 450, point.y - 130))
            : [0],
        ),
      )
    }

    /** The first `count` lanes, landed. */
    function landed(count: number, state = cutAt(CUT.totalMs)): Map<string, RetireState> {
      return new Map(fleet.lanes.slice(0, count).map((lane) => [lane.id, state]))
    }

    it('grows as landed work accumulates, mass and halo together', () => {
      const bare = girthOf()
      let previous = bare
      for (const count of [1, 4, 10, 20]) {
        const grown = girthOf(landed(count))
        expect(grown, `${count} landings did not thicken the mass`).toBeGreaterThan(previous)
        previous = grown
      }
      expect(previous).toBeGreaterThan(bare * 1.05)

      // The halo reaches further with it: a session that has taken a lot of work
      // home has a wider footprint, not just a fatter middle.
      const halo = (retire?: ReadonlyMap<string, RetireState>): number => {
        const mark = marksFor({ fleet, ...(retire === undefined ? {} : { retire }) }).find(
          (m) => m.role === 'root-halo',
        )
        return mark?.kind === 'glow' ? mark.radius : 0
      }
      expect(halo(landed(20))).toBeGreaterThan(halo())
    })

    it('caps, however much lands on it', () => {
      const whales = {
        ...fleet,
        lanes: fleet.lanes.map((lane) => ({ ...lane, outputTokens: 10_000_000 })),
      }
      const at = (of: Fleet): number => {
        const marks = marksFor({ fleet: of, retire: landed(20) }).filter(
          (mark) => mark.role === 'root-mass',
        )
        return Math.max(
          ...marks.flatMap((mark) =>
            mark.kind === 'stroke'
              ? mark.points.map((point) => Math.hypot(point.x - 450, point.y - 130))
              : [0],
          ),
        )
      }

      expect(rootGirth(ROOT_GROWTH.fullTokens)).toBe(ROOT_GROWTH.maxGirth)
      expect(rootGirth(ROOT_GROWTH.fullTokens * 10)).toBe(ROOT_GROWTH.maxGirth)
      expect(rootGirth(0)).toBe(0)
      // …and the picture obeys it: a session of whales is no bigger than the cap.
      expect(at(whales) / girthOf()).toBeLessThanOrEqual(1 + ROOT_GROWTH.maxGirth + 1e-9)
    })

    it('takes the work home as each cord parts, not when it is queued', () => {
      // The mass grows on `homecoming`, which is the retract — so a landing still
      // queued behind the structural cap has not arrived here either, and a wave
      // of them reads as arrivals one at a time rather than as one lurch.
      const queued = girthOf(new Map())
      const parting = girthOf(landed(6, cutAt(CUT.tensionMs)))
      const arrived = girthOf(landed(6))

      expect(parting).toBe(queued)
      expect(arrived).toBeGreaterThan(parting)
    })

    it('does not un-land work the operator asked not to look at', () => {
      // Hiding finished lanes is a request about clutter, not a claim that the
      // work was undone.
      const shown = marksFor({ fleet, retire: landed(20) })
      const hidden = marksFor({ fleet, retire: landed(20), hideFinished: true })
      const widest = (marks: Mark[]): number =>
        Math.max(
          ...marks
            .filter((mark) => mark.role === 'root-mass')
            .flatMap((mark) =>
              mark.kind === 'stroke'
                ? mark.points.map((point) => Math.hypot(point.x - 450, point.y - 130))
                : [0],
            ),
        )

      expect(widest(hidden)).toBe(widest(shown))
    })

    it('is a size, not a movement — it holds still between frames', () => {
      // Ambient motion is the breath and nothing else (law 10). The girth changes
      // only when a cut advances or a snapshot brings new landed work.
      const at = (now: number): number =>
        Math.max(
          ...marksFor({ fleet, retire: landed(8), now, paused: true })
            .filter((mark) => mark.role === 'root-mass')
            .flatMap((mark) =>
              mark.kind === 'stroke'
                ? mark.points.map((point) => Math.hypot(point.x - 450, point.y - 130))
                : [0],
            ),
        )
      expect(at(NOW + 2_700)).toBe(at(NOW))
    })
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

  it('seals a lane that has landed — done, and not a fault', () => {
    // DONE is the one state that is not a pathology, and the display list has to
    // say so in both directions: it carries its own marking, and it carries none
    // of the fault vocabulary and no enclosure. Until now nothing asserted the
    // seal at all, because neither fixture has a landed lane in it.
    const fleet = fleetFor(fleet20Spec())
    const landed = {
      ...fleet,
      lanes: fleet.lanes.map((lane, i) =>
        i === 0 ? { ...lane, activity: 'done' as const } : lane,
      ),
    }
    const id = (fleet.lanes[0] as { id: string }).id
    const sealed = marksFor({ fleet: landed })

    expect(of(sealed, id, 'done-mark')).toHaveLength(1)
    expect(of(sealed, id, ...PATHOLOGY_ROLES)).toHaveLength(0)
    expect(of(sealed, id, 'rank-enclosure')).toHaveLength(0)
    // Hollow, not filled: an outline is "no longer filling with work".
    const node = of(sealed, id, 'node')[0]
    expect(node?.kind === 'path' && node.stroke).toBeDefined()
    // …and the lane beside it, still working, is neither sealed nor hollow.
    const working = (fleet.lanes[1] as { id: string }).id
    expect(of(sealed, working, 'done-mark')).toHaveLength(0)
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

/**
 * THE SUBSTITUTION TABLE (prd7 ruling 3) — meaning moved into form.
 *
 * Every row of the table replaces a discrete glyph with a modulation of a
 * channel the mark already had, and every row spends **zero new objects**. The
 * laws about what those marks *mean* are elsewhere in this file and did not
 * move; what is held here is the substitution itself, so a later hand cannot
 * quietly put the chevrons back and still be green.
 *
 * The one row with nothing to test is "progress → ribbon length": the scene
 * never had a progress arc, because grow-in has always been drawn by truncating
 * the thread (graft g3) and distance from the mass has meant the lifecycle since
 * prd6 ruling 4. The row was already satisfied.
 */
describe('the substitution table — meaning as form', () => {
  const marks = marksFor()

  it('severed: the thread is in pieces, not ticked', () => {
    // The point of the substitution. A stroke across a line is a *claim* about
    // the line; a line that stops is the fact, and it survives being looked at
    // closely — which is what the prd5 camera made possible and prd7 is paying
    // off. So the frozen lane's ribbon is genuinely in more than one polygon,
    // and the waiting lane's — the state it must never be confused with — is in
    // exactly one.
    const frozen = of(marks, LANE.frozen, 'thread')[0]
    const waiting = of(marks, LANE.waiting, 'thread')[0]
    expect(frozen?.kind === 'ribbon' && frozen.outline.length).toBeGreaterThan(1)
    expect(waiting?.kind === 'ribbon' && waiting.outline.length).toBe(1)

    // …and each closure is drawn: two marks, each one a lip of the parting that
    // closes to nothing in the middle of itself.
    const cuts = of(marks, LANE.frozen, 'severed')
    expect(cuts).toHaveLength(2)
    for (const cut of cuts) {
      expect(cut.kind).toBe('ribbon')
      expect(cut.kind === 'ribbon' && cut.outline.length, 'a lip that did not part').toBe(2)
      // Nothing is drawn at the closure at all: the nearest ink to the middle of
      // a cut is further away than the mark's own width, which is what "closes
      // to nothing" means as arithmetic rather than as a description.
      const width = cut.kind === 'ribbon' ? cut.widthRoot : 0
      expect(nearestDrawn(cut, 0.5), 'the cut did not close').toBeGreaterThan(width)
      // On the thread it severs, not floating beside it.
      const on = cut.kind === 'ribbon' ? cut.path : []
      for (const point of on) {
        expect(nearestOn(frozen?.kind === 'ribbon' ? frozen.path : [], point)).toBeLessThan(1)
      }
    }
  })

  it('expensive: the thread is needled, and nothing is a chevron', () => {
    const licks = of(marks, LANE.expensive, 'expensive-mark')
    expect(licks.every((mark) => mark.kind === 'ribbon')).toBe(true)
    // Each one drawn to a point: heat leaving, rather than three of the same
    // arrowhead stacked up.
    for (const lick of licks) expect(widthNear(lick, 0.95)).toBeLessThan(widthNear(lick, 0.1))
  })

  it('done: the seal is a knot — the cord carries past the tip and ties off', () => {
    const fleet = fleetFor(fleet20Spec())
    const landed = {
      ...fleet,
      lanes: fleet.lanes.map((lane, i) => (i === 0 ? { ...lane, activity: 'done' as const } : lane)),
    }
    const id = (fleet.lanes[0] as { id: string }).id
    const seal = of(marksFor({ fleet: landed }), id, 'done-mark')[0]

    expect(seal?.kind).toBe('ribbon')
    if (seal?.kind !== 'ribbon') return
    // A bar has two ends and no turning. A knot goes round: more than a full
    // turn, and it comes back to where it started.
    let turned = 0
    for (let i = 1; i < seal.path.length - 1; i += 1) {
      const a = seal.path[i - 1] as Point
      const b = seal.path[i] as Point
      const c = seal.path[i + 1] as Point
      let delta = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)
      while (delta > Math.PI) delta -= 2 * Math.PI
      while (delta < -Math.PI) delta += 2 * Math.PI
      turned += delta
    }
    expect(Math.abs(turned)).toBeGreaterThan(Math.PI * 2)
  })

  it('rank enclosure: an organic region behind the name, and never a circle', () => {
    const blob = of(marks, LANE.frozen, 'rank-enclosure')[0]
    expect(blob?.kind).toBe('ribbon')
    if (blob?.kind !== 'ribbon') return

    // It encloses the lane's *name*, which is the thing an operator needs
    // bracketed at a glance — not the node, where it used to compete with the
    // state mark it was supposed to frame.
    const thread = frameFor().geometry.byLane.get(LANE.frozen) as { label: { anchor: Point } }
    const centre = blob.path.reduce(
      (sum, point) => ({ x: sum.x + point.x / blob.path.length, y: sum.y + point.y / blob.path.length }),
      { x: 0, y: 0 },
    )
    expect(Math.abs(centre.y - thread.label.anchor.y)).toBeLessThan(12)

    // Displaced, not struck: the radii around it are not all the same.
    const radii = blob.path.map((point) => Math.hypot(point.x - centre.x, point.y - centre.y))
    expect(Math.max(...radii) / Math.min(...radii)).toBeGreaterThan(1.15)
    // …and it is one filled region rather than a stroked ring.
    expect(blob.outline).toHaveLength(1)
    expect(blob.widthRoot).toBe(0)
  })

  it('a commit: a swell in the thread, not a bead riding on it', () => {
    const fleet = fleetFor(pathologySpec())
    const field = new PulseField()
    field.ingest(
      [
        createEvent(
          'commit.landed',
          {
            sha: 'swell-1',
            branch: LANE.healthy,
            message: 'feat: a step',
            author: { name: 'agent', email: 'agent@observatory' },
            files: [{ path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 }],
          },
          { id: 'swell-1', ts: NOW },
        ),
      ],
      indexFor(fleet),
      NOW - 500,
    )

    const marks = marksFor({ fleet, field })
    const packet = of(marks, LANE.healthy, 'pulse')[0]
    expect(packet?.kind).toBe('ribbon')
    if (packet?.kind !== 'ribbon') return

    // On the lane's own thread, and wider there than the thread's own encoding:
    // the hypha bulging as the substance passes, which is a channel the thread
    // already owned rather than an object laid over it.
    const thread = of(marks, LANE.healthy, 'thread')[0]
    const spine = thread?.kind === 'ribbon' ? thread.path : []
    for (const point of packet.path) expect(nearestOn(spine, point)).toBeLessThan(1)
    expect(widthNear(packet, 0.5)).toBeGreaterThan(packet.widthRoot * 1.5)

    // Direction still reads, and it reads off the width: the wake behind it is
    // longer than the head, which is what the seven fading glows used to buy.
    const wake = of(marks, LANE.healthy, 'pulse-wake')[0]
    expect(wake?.kind).toBe('ribbon')
    const arc = (mark: Mark): number => {
      const path = mark.kind === 'ribbon' ? mark.path : []
      let total = 0
      for (let i = 1; i < path.length; i += 1) {
        total += Math.hypot(
          (path[i] as Point).x - (path[i - 1] as Point).x,
          (path[i] as Point).y - (path[i - 1] as Point).y,
        )
      }
      return total
    }
    expect(arc(wake as Mark)).toBeGreaterThan(arc(packet))
  })

  it('spends no new objects doing any of it', () => {
    // The budget claim, counted. A form change that quietly doubled the display
    // list would be a different prd — and at twenty calm lanes the whole picture
    // has to stay something a canvas can draw sixty times a second.
    const calm = marksFor({ fleet: fleetFor(fleet20Spec()) })
    expect(calm.length / 20).toBeLessThan(12)
  })
})

/**
 * SIXTY FRAMES A SECOND, STILL (prd7 ruling 1's standing condition).
 *
 * The research measured the live scene locked at 60 fps before any of this, and
 * the ruling is explicit that prd7 is a form change rather than a renderer
 * change — so the one thing it is not allowed to do is buy the form with the
 * frame budget. Thirty lanes is the number the brief names.
 *
 * The bound here is deliberately generous rather than tight. A wall-clock
 * assertion inside a suite that also runs four-way concurrent under
 * `--maxWorkers=5` is a flake waiting to happen, and a flaky perf test gets
 * deleted rather than fixed. What it is for is catching the *order of magnitude*
 * regression — somebody rebuilding outlines per mark per frame, or uncapping the
 * sample count — while the real number goes in the issue report.
 */
describe('the frame budget at thirty lanes', () => {
  it('builds the whole display list in a fraction of a frame', () => {
    const base = fleetFor(fleet20Spec())
    const fleet = {
      ...base,
      lanes: Array.from({ length: 30 }, (_unused, i) => ({
        ...(base.lanes[i % base.lanes.length] as (typeof base.lanes)[number]),
        id: `lane-${i}`,
        handles: [`lane-${i}`],
        slot: i,
      })),
    }

    const frame = frameFor({ fleet })
    expect(frame.geometry.threads).toHaveLength(30)

    // Everything the loop does per frame except the canvas calls themselves,
    // which jsdom has no context for: lay the scene out, then build the display
    // list. `SceneView` runs both on every `requestAnimationFrame`.
    const once = (): number => {
      const geometry = layoutScene(fleet, { ...SIZE, now: NOW })
      return sceneMarks({ ...frame, geometry }).length
    }

    // Warm the JIT, so the number below is the steady state a running loop sees
    // rather than the first-call cost nobody experiences twice.
    for (let i = 0; i < 20; i += 1) once()

    const runs = 60
    const started = performance.now()
    for (let i = 0; i < runs; i += 1) once()
    const perFrame = (performance.now() - started) / runs

    // eslint-disable-next-line no-console -- the measurement is the point
    console.log(`layout + sceneMarks at 30 lanes: ${perFrame.toFixed(3)} ms/frame`)
    expect(perFrame).toBeLessThan(16.7)
  })

  it('caps the geometry it hands the painter, whatever the clock says', () => {
    // The non-flaky half, and the one that would actually catch the regression
    // the timing above is a proxy for. Vertices are deterministic: uncap the
    // sample count, subdivide an outline one more time, or stop reusing a spine,
    // and this moves — on a loaded CI box exactly as much as on a quiet laptop.
    const base = fleetFor(fleet20Spec())
    const fleet = {
      ...base,
      lanes: Array.from({ length: 30 }, (_unused, i) => ({
        ...(base.lanes[i % base.lanes.length] as (typeof base.lanes)[number]),
        id: `lane-${i}`,
        handles: [`lane-${i}`],
        slot: i,
      })),
    }

    const marks = marksFor({ fleet })
    const ribbons = marks.filter((mark) => mark.kind === 'ribbon')
    const vertices = ribbons.reduce(
      (total, mark) => total + (mark.kind === 'ribbon' ? mark.outline.flat().length : 0),
      0,
    )

    expect(ribbons.length).toBeGreaterThan(60)
    // Research §"what to avoid": subdivision explosion is 2ⁿ, so the thing worth
    // bounding is the absolute point count per frame rather than the recursion
    // depth of whatever produced it.
    expect(vertices / ribbons.length, 'a ribbon grew unbounded').toBeLessThan(140)
    expect(vertices, 'the display list outgrew a frame').toBeLessThan(40_000)
  })
})

/**
 * THE DISPLAY LIST IS DATA (prd7 ruling 1) — and this is the guard that keeps it
 * that way.
 *
 * The seam only pays if a mark is *inert*: a value that can be written down,
 * posted to a worker, replayed from a log or handed to a painter that has never
 * heard of this scene. The moment one mark closes over a lane object, arrives as
 * a class instance with a `draw()` on it, or points back at the frame that built
 * it, the picture stops being data and the painter stops being swappable — and
 * nothing else in this file would notice, because every other law reads fields
 * that a live object has too.
 *
 * `structuredClone` is exactly that boundary, made executable: it is what
 * `postMessage` does. What it refuses is what a painter in another thread could
 * not have been given. The JSON round-trip is the second half — it refuses the
 * things `structuredClone` would happily carry (a cycle, a `Map`) but a log or a
 * wire could not.
 */
describe('the display list is data, not objects (prd7 ruling 1)', () => {
  /**
   * A corpus wide enough that the guard means something: every mark kind, and
   * every optional field a mark can carry. A conformance test that only ever saw
   * plain ribbons would pass for ever without proving anything.
   */
  function corpus(): Mark[] {
    const fleet = fleetFor(pathologySpec())
    const flowing = new PulseField()
    flowing.ingest(
      fixtureHistory(pathologySpec(), NOW).filter((event) => event.type === 'llm.usage').slice(-6),
      indexFor(fleet),
      NOW - 500,
    )
    const storm = new PulseField()
    storm.ingest(
      [
        createEvent(
          'commit.landed',
          {
            sha: 'clone-1',
            branch: LANE.healthy,
            message: 'feat: a step',
            author: { name: 'agent', email: 'agent@observatory' },
            files: [{ path: 'src/a.ts', status: 'modified', insertions: 2, deletions: 1 }],
          },
          { id: 'clone-1', ts: NOW },
        ),
      ],
      indexFor(fleet),
      NOW - 500,
    )

    return [
      ...marksFor({ fleet }),
      // The chip behind a spotlit name, and the spotlight's own rings.
      ...marksFor({ fleet, selectedId: LANE.healthy }),
      // The standing gradient — the one mark that paints with a `linear`.
      ...marksFor({ fleet, field: flowing, reducedMotion: true }),
      // Light in flight, and the count an aggregate carries.
      ...marksFor({ fleet, field: storm }),
      // A cut mid-flight: the scar family and the homeward ribbon.
      ...marksFor({ fleet, retire: new Map([[LANE.healthy, cutAt(CUT.tensionMs + 120)]]) }),
      // The gap voice, which is chrome rather than a lane's.
      ...marksFor({ fleet: fleetFor(pathologySpec(), false) }),
    ]
  }

  const marks = corpus()

  it('covers every kind and every optional field, so the guard is worth having', () => {
    const kinds = new Set(marks.map((mark) => mark.kind))
    expect([...kinds].sort()).toEqual(['arc', 'chip', 'glow', 'path', 'ribbon', 'stroke', 'text'])

    const has = (predicate: (mark: Mark) => boolean): boolean => marks.some(predicate)
    expect(has((m) => m.kind === 'ribbon' && m.dashed === true), 'no dashed ribbon').toBe(true)
    expect(has((m) => m.kind === 'ribbon' && isLinear(m.paint)), 'no linear paint').toBe(true)
    expect(has((m) => m.kind === 'stroke' && m.dash !== undefined), 'no dashed stroke').toBe(true)
    expect(has((m) => m.kind === 'arc' && m.dash !== undefined), 'no dashed arc').toBe(true)
    expect(has((m) => m.kind === 'path' && m.stroke !== undefined), 'no hollow glyph').toBe(true)
    expect(has((m) => m.kind === 'path' && m.squash !== undefined), 'no squashed glyph').toBe(true)
    expect(has((m) => m.laneId === null), 'nothing that belongs to no lane').toBe(true)
  })

  it('survives structuredClone — the boundary a worker or a replay would cross', () => {
    const copy = structuredClone(marks)
    expect(copy).toEqual(marks)
    // Not the same objects: a clone that handed back the originals would prove
    // nothing about what is in them.
    expect(copy[0]).not.toBe(marks[0])
  })

  it('survives a JSON round-trip — no cycle, and nothing that only lives in memory', () => {
    expect(JSON.parse(JSON.stringify(marks))).toEqual(marks)
  })

  it('carries no function and no class instance, anywhere in the tree', () => {
    // Walked by hand rather than inferred from the clone: `structuredClone`
    // happily carries a `Map` and a cycle, and both would mean the painter is
    // being handed a live object rather than a picture.
    const wrong: string[] = []
    const walk = (value: unknown, at: string, ancestors: readonly object[]): void => {
      if (value === null) return
      const type = typeof value
      if (type === 'function' || type === 'symbol' || type === 'bigint') {
        wrong.push(`${at} is a ${type}`)
        return
      }
      if (type !== 'object') return

      const node = value as object
      if (ancestors.includes(node)) {
        wrong.push(`${at} closes a cycle`)
        return
      }
      const proto = Object.getPrototypeOf(node) as object | null
      if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
        wrong.push(`${at} is a ${node.constructor?.name ?? 'exotic'}`)
        return
      }
      const deeper = [...ancestors, node]
      for (const [key, child] of Object.entries(node)) walk(child, `${at}.${key}`, deeper)
    }

    marks.forEach((mark, i) => walk(mark, `${mark.role}[${i}]`, []))
    expect(wrong).toEqual([])
  })
})

/**
 * THE CORD-CUT, on the display list (prd5 ruling 3).
 *
 * The whole reason the cut is worth building is that it answers "is this fleet
 * still working?" *structurally* rather than by shade — so these assertions are
 * about what the list **contains**, not about what is bright. "The lane left the
 * living network" is `role === 'thread'` returning nothing for it, which is a fact
 * no future retune of a brightness can quietly undo.
 */
describe('the cord-cut — a finished lane leaves the network', () => {
  const LEAVING = LANE.healthy

  function cut(ms: number, options: FrameOptions = {}): Mark[] {
    return marksFor({ ...options, retire: new Map([[LEAVING, cutAt(ms)]]) })
  }

  /**
   * The same cut on the **calm** twenty-lane fleet.
   *
   * The brightness laws below are pinned here rather than on the staged fixture
   * for the same reason `CALM_FLOOR` is: the staged fleet has a broken lane
   * holding the spotlight, so every other lane in it is correctly receded to
   * `RECEDE` and no floor can be asserted about any of them. Getting out of a
   * summons's way outranks being seen — that is the point of the budget — so the
   * floor is a claim about the *quiet* reading, and the recession is its own test.
   */
  const CALM_LANE = '101-thread-rollup'
  function calmCut(ms: number, options: FrameOptions = {}): Mark[] {
    return marksFor({
      ...options,
      fleet: fleetFor(fleet20Spec()),
      retire: new Map([[CALM_LANE, cutAt(ms)]]),
    })
  }

  const mine = (marks: readonly Mark[]): Mark[] =>
    marks.filter((mark) => mark.laneId === LEAVING)
  const rolesOf = (marks: readonly Mark[]): Set<MarkRole> =>
    new Set(mine(marks).map((mark) => mark.role))

  it('is not part of the living network at any stage of the cut', () => {
    for (const ms of [0, CUT.tensionMs, CUT.tensionMs + 400, CUT.totalMs]) {
      const roles = rolesOf(cut(ms))
      // No thread, and no second growth either: a scar is a mark, not a network.
      for (const gone of ['thread', 'thread-bloom', 'thread-flow', 'filament', 'filament-tip']) {
        expect(roles.has(gone as MarkRole), `${gone} survived the cut at ${ms} ms`).toBe(false)
      }
      expect(roles.has('scar'), `no scar at ${ms} ms`).toBe(true)
    }
    // …while the fleet around it is still threaded, obviously.
    expect(cut(CUT.totalMs).filter((mark) => mark.role === 'thread').length).toBeGreaterThan(0)
  })

  it('never lights again — no glow, no pulse, no heat', () => {
    // Law 10 says states glow and events travel. A retired lane has no more
    // events and is no longer a state anybody can act on, so it gets neither.
    const marks = mine(cut(CUT.totalMs))
    expect(marks.filter((mark) => mark.kind === 'glow')).toHaveLength(0)
    for (const role of ['heat', 'pulse', 'pulse-wake', 'tick', 'orbit'] as MarkRole[]) {
      expect(marks.some((mark) => mark.role === role), `${role} on a scar`).toBe(false)
    }
  })

  it('drops the faults it was carrying — a scar cannot be summoned for', () => {
    // The looping lane, retired: the knot goes with the thread it was tied into.
    const marks = marksFor({ retire: new Map([[LANE.looping, cutAt(CUT.totalMs)]]) })
    expect(of(marks, LANE.looping, 'looping-mark')).toHaveLength(0)
    expect(of(marks, LANE.looping, 'rank-enclosure')).toHaveLength(0)
    // Not the whole pathology vocabulary, deliberately: a retired looping lane
    // still emits `orbit`, because `lightMarks` never asks whether the lane it
    // is lighting has retired. That is a fact about the scene as it stands, and
    // this rename is not allowed to change a pixel of it — recorded here so the
    // next hand sees it rather than discovering it.
    expect(of(marks, LANE.looping, 'scar').length).toBeGreaterThan(0)
  })

  describe('the three stages, in order', () => {
    it('stage 1 keeps the thread attached and still lit', () => {
      const roles = rolesOf(cut(CUT.tensionMs * 0.5))
      // The bloom is still there — the light has not gone out yet — and there is
      // no freed end to curl, because nothing has parted.
      expect(roles.has('scar-bloom')).toBe(true)
      expect(mine(cut(CUT.tensionMs * 0.5)).filter((m) => m.role === 'scar-mark')).toHaveLength(3)
    })

    it('stage 2 puts a curl on the freed end and starts putting the light out', () => {
      const early = mine(cut(CUT.tensionMs + 40))
      const late = mine(cut(CUT.tensionMs + CUT.retractMs * 0.9))

      const bloom = (marks: readonly Mark[]): number => {
        const found = marks.find((mark) => mark.role === 'scar-bloom')
        return found === undefined ? 0 : brightnessOf(found)
      }
      // Light leaves before colour does, which is the right order: it was the
      // light that was the lane working.
      expect(bloom(early)).toBeGreaterThan(bloom(late))

      // Four glyph marks now, not three: the released end has curled back.
      expect(early.filter((mark) => mark.role === 'scar-mark')).toHaveLength(4)
    })

    it('stage 3 desaturates, and only then', () => {
      const inkOf = (ms: number): number[] => {
        const scar = mine(cut(ms)).find((mark) => mark.role === 'scar')
        return [...(inksOf(scar as Mark)[0]?.rgb ?? [])]
      }

      // Colour is untouched until the settle: stages 1 and 2 move curvature and
      // position, and nothing else.
      expect(inkOf(0)).toEqual(inkOf(CUT.tensionMs + CUT.retractMs * 0.5))
      expect(inkOf(CUT.totalMs)).not.toEqual(inkOf(0))
      expect(inkOf(CUT.totalMs)).toEqual([...SCAR.thread.rgb])
    })

    it('has no bloom left once it has settled — a scar is flat', () => {
      expect(rolesOf(cut(CUT.totalMs)).has('scar-bloom')).toBe(false)
    })
  })

  /**
   * SEVERED SUBSTANCE RETURNS HOME (prd6 ruling 2).
   *
   * The display-list half. What makes the claim checkable rather than a matter of
   * taste is that the flow is a `homeward` **ribbon** and not a `pulse`: it is the
   * hypha's own matter being reabsorbed, which is the honest reading of a merge,
   * and it is one of the two things a cut has that a replay of one does not.
   */
  describe('the way home', () => {
    const during = mine(cut(CUT.tensionMs + 120))

    it('flows down the severing thread while the cut runs', () => {
      const flow = during.filter((mark) => mark.role === 'homeward')
      expect(flow).toHaveLength(1)
      const parcel = flow[0] as Mark
      expect(parcel.kind).toBe('ribbon')
      // Matter, not light: no glow anywhere on a retiring lane, still.
      expect(during.filter((mark) => mark.kind === 'glow')).toHaveLength(0)
    })

    it('is the thread own matter — its colour, and narrower than the thread', () => {
      const parcel = during.find((mark) => mark.role === 'homeward') as Mark
      const living = of(marksFor(), LEAVING, 'thread')[0] as Mark
      expect(parcel.kind === 'ribbon' && living.kind === 'ribbon').toBe(true)
      if (parcel.kind !== 'ribbon' || living.kind !== 'ribbon') return

      expect(parcel.widthRoot).toBeLessThan(living.widthRoot)
      // Warmed, because it is moving — and still under the calm ceiling, because
      // work coming home is not a summons (graft g6).
      expect(brightnessOf(parcel)).toBeGreaterThan(brightnessOf(living))
      expect(brightnessOf(parcel)).toBeLessThanOrEqual(CALM_CEILING)
    })

    it('is absent from history and from a replay', () => {
      // Law 2 of the cut, extended: a lane that was already retired when we first
      // saw it is scarred outright and never animates. Sending its substance home
      // again would be re-landing work the log is only telling us about.
      for (const marks of [mine(cut(CUT.totalMs)), mine(cut(0))]) {
        expect(marks.filter((mark) => mark.role === 'homeward')).toHaveLength(0)
      }
      expect(marksFor().filter((mark) => mark.role === 'homeward')).toHaveLength(0)
    })

    it('has no journey to make under reduced motion', () => {
      const still = marksFor({
        reducedMotion: true,
        retire: new Map([[LEAVING, cutAt(0, allowance('structural', 'reduced').travel)]]),
      })
      expect(still.filter((mark) => mark.role === 'homeward')).toHaveLength(0)
    })
  })

  describe('the scar that is left', () => {
    const marks = calmCut(CUT.totalMs)
    const scarred = (role: MarkRole): Mark => of(marks, CALM_LANE, role)[0] as Mark
    const living = (role: MarkRole): Mark =>
      of(marksFor({ fleet: fleetFor(fleet20Spec()) }), CALM_LANE, role)[0] as Mark

    it('keeps the name and the figure', () => {
      const name = scarred('label')
      const figure = scarred('label-figure')
      expect(name?.kind === 'text' && name.text).toBe(
        (fleetFor(fleet20Spec()).lanes.find((lane) => lane.id === CALM_LANE) as { label: string })
          .label,
      )
      expect(figure?.kind === 'text' && figure.text.length).toBeGreaterThan(0)
    })

    it('keeps the figure at full label brightness — the work is not diminished', () => {
      expect(brightnessOf(scarred('label-figure'))).toBe(brightnessOf(living('label-figure')))
    })

    it('reduces the name without making it unreadable', () => {
      expect(brightnessOf(scarred('label'))).toBeLessThan(brightnessOf(living('label')))
      // A scar exists to be identified. Its name is held to the same body-copy
      // footing every other name in the scene is.
      expect(brightnessOf(scarred('label'))).toBeGreaterThan(CALM_FLOOR)
    })

    it('never fades to nothing — SCAR_FLOOR, on every mark it draws', () => {
      // The research law: invisible completion is indistinguishable from a render
      // bug, and the operator cannot tell which of the two they are looking at.
      const drawn = marks.filter((mark) => mark.laneId === CALM_LANE)
      expect(drawn.length).toBeGreaterThan(0)
      for (const mark of drawn) {
        expect(brightnessOf(mark), `${mark.role} faded out`).toBeGreaterThan(SCAR_FLOOR)
      }
    })

    it('sits under the living fleet without joining it', () => {
      const remnant = scarred('scar')
      const threads = marks.filter((mark) => mark.role === 'thread')
      expect(threads.length).toBeGreaterThan(0)
      for (const thread of threads) {
        expect(brightnessOf(remnant)).toBeLessThan(brightnessOf(thread))
      }
    })

    it('recedes with the rest of the calm world when something needs a human', () => {
      // Not an exception to the contrast budget. A scar is calm by construction —
      // there is nothing to act on — so when a summons arrives it gets out of the
      // way exactly as every other non-alarm mark does (graft g6).
      const quiet = brightnessOf(of(cut(CUT.totalMs), LEAVING, 'scar')[0] as Mark)
      const alone = brightnessOf(
        of(cut(CUT.totalMs, { selectedId: LEAVING }), LEAVING, 'scar')[0] as Mark,
      )
      expect(quiet).toBeLessThan(alone)
      expect(quiet / alone).toBeCloseTo(RECEDE, 6)
    })

    it('is still hollow and still sealed — landed, and not a fault', () => {
      const glyphs = of(marks, CALM_LANE, 'scar-mark')
      const lens = glyphs.find((mark) => mark.kind === 'path' && mark.d.startsWith('M0.04'))
      expect(lens?.kind === 'path' && lens.stroke).toBeDefined()
      // The seal, which is the knot now (prd7 ruling 3) rather than a bar struck
      // across the tip. Exactly as discriminating as the reading it replaces: the
      // lens and the thorn are glyphs, so the one mark of the three that is not a
      // glyph is the seal, and a scar that had stopped carrying one would fail
      // here as loudly as it did before.
      expect(glyphs.some((mark) => mark.kind === 'ribbon')).toBe(true)
    })

    it('does not breathe', () => {
      // The ambient layer is the scene being alive, and this lane is not. Two
      // frames half a breath apart draw the scar at exactly the same size.
      const at = (now: number): number => {
        const glyph = of(calmCut(CUT.totalMs, { now }), CALM_LANE, 'scar-mark').find(
          (mark) => mark.kind === 'path' && mark.d.startsWith('M0.04'),
        )
        return glyph?.kind === 'path' ? glyph.size : 0
      }
      expect(at(NOW)).toBeGreaterThan(0)
      expect(at(NOW + 1_350)).toBe(at(NOW))
    })
  })

  describe('the hide-finished toggle', () => {
    it('draws nothing at all for a hidden scar', () => {
      const hidden = marksFor({
        retire: new Map([[LEAVING, cutAt(CUT.totalMs)]]),
        hideFinished: true,
      })
      expect(hidden.filter((mark) => mark.laneId === LEAVING)).toHaveLength(0)
      // Everyone else is untouched — this hides scars, not lanes.
      expect(hidden.filter((mark) => mark.role === 'thread').length).toBeGreaterThan(0)
    })

    it('still shows a cut in progress', () => {
      const mid = marksFor({
        retire: new Map([[LEAVING, cutAt(CUT.tensionMs + 300)]]),
        hideFinished: true,
      })
      expect(mid.filter((mark) => mark.laneId === LEAVING).length).toBeGreaterThan(0)
    })
  })

  describe('reduced motion — severed in place', () => {
    const still = marksFor({
      reducedMotion: true,
      fleet: fleetFor(fleet20Spec()),
      retire: new Map([[CALM_LANE, cutAt(0, allowance('structural', 'reduced').travel)]]),
    })

    it('shows the settled scar rather than a stage of a journey', () => {
      const roles = new Set(still.filter((m) => m.laneId === CALM_LANE).map((m) => m.role))
      expect(roles.has('scar')).toBe(true)
      expect(roles.has('scar-bloom')).toBe(false)
      expect(roles.has('thread')).toBe(false)
    })

    it('keeps the colour, which is what the success criterion excludes', () => {
      // WCAG 2.3.3's "motion animation" is travel and scale; colour and opacity
      // are explicitly out of scope, so they are exactly what survives.
      const remnant = of(still, CALM_LANE, 'scar')[0] as Mark
      expect(inksOf(remnant)[0]?.rgb).toEqual(SCAR.thread.rgb)
      expect(brightnessOf(remnant)).toBeGreaterThan(SCAR_FLOOR)
    })
  })

  it('lets a whole fleet retire without ever drawing more than the cap mid-cut', () => {
    // A wave of landings queues, so at any instant at most two lanes are showing
    // a cut that has not finished — the rest are either still threaded or already
    // scarred. This is the display-list reading of ruling 4's structural cap.
    const fleet = fleetFor(fleet20Spec())
    const retire = new Map<string, RetireState>(
      fleet.lanes.map((lane, i) => [lane.id, cutAt(i < 2 ? CUT.tensionMs + 100 : CUT.totalMs)]),
    )
    const marks = marksFor({ fleet, retire })

    const midCut = fleet.lanes.filter(
      (lane) => of(marks, lane.id, 'scar-bloom').length > 0,
    )
    expect(midCut.length).toBeLessThanOrEqual(STRUCTURAL.maxConcurrent)
    expect(marks.filter((mark) => mark.role === 'scar')).toHaveLength(20)
  })
})

