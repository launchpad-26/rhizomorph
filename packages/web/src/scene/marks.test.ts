import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SUBAGENT_RECENCY_MS, createEvent, reduceAll } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import {
  buildFleet,
  finishedSpec,
  fixtureHistory,
  fleet20Spec,
  manifestFor,
  pathologySpec,
  type Fleet,
  type FixtureSpec,
} from '../fleet/index.js'
import {
  RECENCY_SPAN_MS,
  ROOT_GROWTH,
  layoutScene,
  pointAt,
  rootFullness,
  rootRadiusFor,
  seedSize,
  tangentAt,
  type Point,
} from './geometry.js'
import { ALARM, AMBIENT, DISSOLUTION, EVENT, STRUCTURAL, allowance } from './motion.js'
import {
  BREATH_PERIOD_MS,
  brightnessOf,
  breathOf,
  inksOf,
  isLinear,
  motionMode,
  sceneMarks,
  vibrancyOf,
  type Mark,
  type MarkRole,
  type SceneFrame,
} from './marks/index.js'
import { ribbonMark } from './marks/index.js'
import { arrivalSwell } from './marks/root.js'
import { RIM_VEIL } from './marks/ambient.js'
import { paint } from './paint.js'
import {
  RETURN,
  RetireRegistry,
  PERSIST,
  PERSIST_FLOOR,
  PERSIST_WIDTH_SCALE,
  returnAt,
  isRetired,
  type RetireState,
} from './retire.js'
import {
  ALARM_FLOOR,
  CALM_CEILING,
  CALM_FLOOR,
  RECEDE,
  TIP_CEILING,
  TIP_GLOW_RADIUS,
  salienceOf,
} from './salience.js'
import { BROKEN, NEEDS_YOU, NOTICE, REPLAY_VIBRANCY, type Ink } from './palette.js'
import { PulseField } from './pulses.js'
import type { LaneIndex } from './resolve.js'

// @gate-timing — carries a wall-clock frame/measurement suite ("the frame
// budget at thirty lanes", below) (#209). scripts/gate.sh greps for this
// exact marker to route the whole file into its serial, alone timing pass
// instead of the 4x load batches — the file is the unit gate.sh excludes at,
// same as before this issue. Carry this comment with the file if you rename
// or move it; a file without it is invisible to that pass.

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

/**
 * How long the few genuinely heavy cases below may take, wall-clock.
 *
 * Every one of them is deterministic — this file carries no wall-clock
 * *assertion* anywhere, and never widening a timeout is a law about those, not
 * about this. What is true instead is that a handful of cases sample the
 * display list a couple of dozen times over (a fleet, a layout and a full mark
 * pass per sample), and vitest's 5 s default is a load-bearing assumption these
 * cases can break purely from contention: the same case measured 693 ms on a
 * quiet box and 5517–7242 ms while three sibling lanes' gates ran alongside it
 * (#172, #189) — a gate HELD each time, on a diff that never touched this file.
 * 20 s is comfortably past the worst of those, on the same "generous enough
 * that only a genuine hang trips it" standard #161 set for `perf.test.ts`'s
 * `BENCH_TIMEOUT_MS`.
 */
const HEAVY_CASE_TIMEOUT_MS = 20_000

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
  /**
   * Draw this frame as a replay rather than as a live instrument (#157). The only
   * thing it changes is `frame.vibrancy`, which the ambient layer alone reads.
   */
  replaying?: boolean
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
    // The two clocks are the same number in every fixture here, which is exactly
    // what they are live — the suites that care about the split say so explicitly.
    asOf: now,
    vibrancy: vibrancyOf(options.replaying ?? false),
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
 * this timescale moves it. What does advance is the clock, which is what the
 * throb, the breath and the summons's own age all read.
 *
 * **Both** clocks advance together, because that is what a live scene is (#157):
 * `SceneView` falls back to one number for the pair and only a replay ever pulls
 * them apart. The suites that are *about* the split move them separately and say
 * so — see "the scene's two clocks".
 */
function sampled(from: number, count: number, stepMs: number, options: FrameOptions = {}): Mark[][] {
  const base = frameFor({ ...options, now: from })
  const mode = motionMode(base)

  return Array.from({ length: count }, (_unused, i) => {
    const now = from + i * stepMs
    return sceneMarks({ ...base, now, asOf: now, breath: breathOf(now, mode) })
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
    case 'contour':
      return mark.rings.flatMap((ring) => [...ring])
    case 'stroke':
      return [...mark.points]
    case 'motes':
      return mark.items.map((mote) => mote.at)
    // Unit-space geometry placed by a transform (prd10 ruling 3): the points a law
    // about *where* would want are the placed ones, so they are mapped here rather
    // than left in the space they were baked in.
    case 'baked':
      return mark.paths.flatMap((path) =>
        path.map((point) => ({
          x: mark.at.x + point.x * mark.scale,
          y: mark.at.y + point.y * (mark.scaleY ?? mark.scale),
        })),
      )
    // Screen-space washes over the whole panel. They are not *at* anywhere.
    case 'wash':
    case 'grain':
      return []
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
              author: { name: 'agent', email: 'agent@rhizomorph' },
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

    // Every lit part of the mass, the surface included: prd7 ruling 5 moved most
    // of the mass's ink onto one contour, so a floor asserted over the two glows
    // alone would now be a floor over the chrome around the thing.
    const glow = (of: Fleet): number => {
      const marks = marksFor({ fleet: of }).filter(
        (mark) =>
          mark.role === 'root-core' || mark.role === 'root-halo' || mark.role === 'root-mass',
      )
      expect(marks.length).toBeGreaterThan(0)
      return Math.max(...marks.map(brightnessOf))
    }

    expect(glow(dark)).toBeLessThan(glow(fleet))
    // Dim, not absent: the mass is still the thing every thread is threaded to.
    expect(glow(dark)).toBeGreaterThan(0)

    // …and the surface on its own, which is what an operator actually looks at.
    const surface = (of: Fleet): number =>
      brightnessOf(marksFor({ fleet: of }).find((mark) => mark.role === 'root-mass') as Mark)
    expect(surface(dark)).toBeLessThan(surface(fleet))
    expect(surface(dark)).toBeGreaterThan(0)
  })

  /**
   * IT IS ONE SURFACE (prd7 ruling 5) — a contour, not an arrangement of marks.
   *
   * The ruling's own words: the centre was the most obviously drawn thing on
   * screen. So the shape of the claim is a count as much as a kind. Fifty-four
   * curls and an expanding ring are gone; what is left is one mark carrying one
   * closed ring, and nothing in the root-mass's family is a stroke or an arc any
   * more.
   */
  describe('one organic contour', () => {
    const mass = (options: FrameOptions = {}): Mark =>
      marksFor(options).find((mark) => mark.role === 'root-mass') as Mark

    it('is a single contour mark, and the only thing the mass is drawn as', () => {
      const marks = marksFor()
      const root = marks.filter((mark) => mark.role.startsWith('root-'))
      expect(root.filter((mark) => mark.role === 'root-mass')).toHaveLength(1)
      // The rest of the family is light and a name — nothing that draws a shape.
      expect([...new Set(root.map((mark) => mark.role))].sort()).toEqual([
        'root-core',
        'root-halo',
        'root-label',
        'root-mass',
      ])
      expect(root.map((mark) => mark.kind).sort()).toEqual(['contour', 'glow', 'glow', 'text'])
    })

    it('carries one closed ring, with no step in it a grid could show through', () => {
      const mark = mass()
      expect(mark.kind === 'contour' && mark.rings).toHaveLength(1)
      const ring = (mark.kind === 'contour' ? mark.rings[0] : []) as readonly Point[]
      expect(ring.length).toBeGreaterThan(64)

      // Closed: the wrap from the last vertex to the first is an edge like any
      // other, which is what says the walk came back to where it started.
      let longest = 0
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i] as Point
        const b = ring[(i + 1) % ring.length] as Point
        longest = Math.max(longest, Math.hypot(b.x - a.x, b.y - a.y))
      }
      expect(longest).toBeLessThan(1.5)
    })

    it('is grown, not turned — the silhouette is nobody\'s circle', () => {
      // The failure this catches is the quiet one: melt the falloffs together
      // hard enough and the field collapses back into exactly the disc ruling 5
      // is removing, with every test above still green.
      const { centre } = frameFor().geometry
      const reach = pointsOf(mass()).map((p) => Math.hypot(p.x - centre.x, p.y - centre.y))
      expect(Math.min(...reach) / Math.max(...reach)).toBeLessThan(0.9)
      // …and still one mass rather than a scatter of lumps.
      expect(Math.min(...reach) / Math.max(...reach)).toBeGreaterThan(0.6)
    })

    /**
     * THE BREATH MOVES THE CONTOUR (law 10, prd5's AMBIENT class).
     *
     * It used to move a tangle of curls and two glows. There is nothing else left
     * for it to move, so this is now the whole of the scene's ambient motion
     * reaching the picture — and both degradations are asserted against the same
     * reading, because a breath that survived a pause would be a WCAG 2.2.2
     * failure and one that survived reduced motion would be a ruling 4 failure.
     */
    it('breathes, and holds still for a pause and for reduced motion', () => {
      const { centre } = frameFor().geometry
      const size = (options: FrameOptions): number =>
        Math.max(...pointsOf(mass(options)).map((p) => Math.hypot(p.x - centre.x, p.y - centre.y)))

      // A quarter of the 5.4 s period apart: peak inhale against the resting size.
      const resting = size({ now: NOW })
      const inhaled = size({ now: NOW + BREATH_PERIOD_MS / 4 })
      expect(inhaled).not.toBeCloseTo(resting, 3)
      // Inside ruling 4's 3% ceiling, which is the half that makes it ambient.
      expect(Math.abs(inhaled / resting - 1)).toBeLessThan(0.03)

      for (const stopped of [{ paused: true }, { reducedMotion: true }]) {
        expect(size({ ...stopped, now: NOW + BREATH_PERIOD_MS / 4 })).toBe(
          size({ ...stopped, now: NOW }),
        )
      }
    })

    /**
     * IT MELTS WHERE THE WORK IS ARRIVING (prd7 ruling 5, prd6 ruling 2's other
     * half).
     *
     * The fact the deleted `root-arrival` ring used to carry, told properly: a
     * ring expanding out of the centre said *something* landed, and a surface
     * bulging at four o'clock says something landed **from four o'clock**. So the
     * law is directional, and it has to settle back — a swell that stayed would
     * be the girth, and the girth is a different channel.
     */
    describe('melting with the arrivals', () => {
      const fleet = fleetFor(fleet20Spec())
      const lane = fleet.lanes[0] as (typeof fleet.lanes)[number]

      /** How far the surface reaches on this lane's bearing, and on the far side. */
      function reach(retire?: ReadonlyMap<string, RetireState>): { toward: number; away: number } {
        const frame = frameFor({ fleet, ...(retire === undefined ? {} : { retire }) })
        const { centre } = frame.geometry
        const angle = frame.geometry.byLane.get(lane.id)?.angle ?? 0
        const points = pointsOf(
          sceneMarks(frame).find((mark) => mark.role === 'root-mass') as Mark,
        )
        const along = (bearing: number): number =>
          Math.max(
            ...points
              .map((p) => ({
                r: Math.hypot(p.x - centre.x, p.y - centre.y),
                a: Math.atan2(p.y - centre.y, p.x - centre.x),
              }))
              .filter((p) => Math.abs(Math.atan2(Math.sin(p.a - bearing), Math.cos(p.a - bearing))) < 0.3)
              .map((p) => p.r),
          )
        return { toward: along(angle), away: along(angle + Math.PI) }
      }

      const cutting = (state: RetireState): Map<string, RetireState> =>
        new Map([[lane.id, state]])

      it('bulges toward the lane the substance is coming from, and only there', () => {
        const still = reach()
        const arriving = reach(cutting(returnAt(RETURN.tensionMs + RETURN.withdrawMs)))

        // Both sides grew a little — one lane's work has landed, so the whole mass
        // is thicker (ruling 2). The arriving bearing grew *more*, and that
        // difference is the swell.
        const towardGrowth = arriving.toward / still.toward
        const awayGrowth = arriving.away / still.away
        expect(towardGrowth).toBeGreaterThan(awayGrowth * 1.05)
      })

      it('settles back as the scar cools, leaving only the thickening behind', () => {
        const peak = reach(cutting(returnAt(RETURN.tensionMs + RETURN.withdrawMs)))
        const cooling = reach(cutting(returnAt(RETURN.tensionMs + RETURN.withdrawMs + 200)))
        const settled = reach(cutting(returnAt(RETURN.totalMs)))

        expect(cooling.toward).toBeLessThan(peak.toward)
        expect(settled.toward).toBeLessThan(cooling.toward)
        // …and what is left is symmetric: the swell is gone, the girth is not.
        expect(settled.toward / settled.away).toBeCloseTo(reach().toward / reach().away, 6)
        expect(settled.toward).toBeGreaterThan(reach().toward)
      })

      it('does not bulge for a cut that has not parted yet, or one nobody watched', () => {
        // Nothing is in transit during the tension release, so there is nothing to
        // arrive; and a reduced-motion frame collapses the cut to its endpoint, so
        // a journey the scene never watched never lands on the mass either. Same
        // arithmetic, same reason the homeward ribbon is absent in both.
        expect(arrivalSwell(0, 0)).toBe(0)
        expect(arrivalSwell(1, 1)).toBe(0)
        expect(arrivalSwell(1, 0)).toBe(1)
        expect(reach(cutting(returnAt(RETURN.tensionMs))).toward).toBe(reach().toward)
        expect(reach(cutting(returnAt(RETURN.totalMs, false))).toward).toBe(
          reach(cutting(returnAt(RETURN.totalMs))).toward,
        )
      })
    })
  })

  it('names the branch it is, in mono (law 11)', () => {
    const label = marksFor().find((mark) => mark.role === 'root-label')
    expect(label?.kind === 'text' && label.text).toBe('MAIN')
    expect(label?.kind === 'text' && label.font).toBe('mono')
  })

  /**
   * IT GROWS WITH THE SESSION'S LANDED WORK (prd6 ruling 2, #118).
   *
   * The other end of the homeward flow. A merge means the work is part of main
   * now, so the mass it went into is bigger for having taken it — on the same
   * absolute-scale-with-a-hard-cap discipline as ruling 1's seeds, because a mass
   * that could grow without limit would eat the picture it is the centre of.
   *
   * **The cap is a fraction of the scene, not of the mass** (#118), and that is
   * the one thing here that is new. It used to be +30% of the mass's own resting
   * size, and the operator's finding against that was the whole picture rather
   * than any single number: after thirty-eight landings the scene still read as a
   * *wreath* — a ring of retired lanes around a large empty middle with a small
   * blob in it — so a law that was already in the code was invisible in the thing
   * the code draws. A ceiling expressed against the mass can only ever say "a bit
   * bigger than it was"; one expressed against the distance to the retirement
   * band says how much of the picture the centre has taken, which is what an
   * operator can actually see, and it is also the only form of the cap that can
   * promise the mass will never crowd the rim or the lane labels — on a letterbox
   * panel, on a square one, or at any zoom, since the camera magnifies the mass
   * and the rim by the same factor.
   */
  describe('growing with the session work', () => {
    const fleet = fleetFor(fleet20Spec())

    /**
     * The mass's own girth, as how far its surface reaches from the centre.
     *
     * Read through `pointsOf` rather than off a mark kind, which is the same move
     * `reachOf` already makes and for the same reason (prd7 ruling 2, applied to
     * geometry): before ruling 5 this said `mark.kind === 'stroke' ? mark.points`,
     * which quietly made "the mass thickens" a law about **strokes**. The mass is
     * one contour now and the law is word for word unchanged, so the reading is
     * what had to move.
     */
    function widestOf(marks: readonly Mark[]): number {
      const mass = marks.filter((mark) => mark.role === 'root-mass')
      expect(mass.length).toBeGreaterThan(0)
      return Math.max(
        ...mass.flatMap((mark) =>
          pointsOf(mark).map((point) => Math.hypot(point.x - 450, point.y - 130)),
        ),
      )
    }

    function girthOf(retire?: ReadonlyMap<string, RetireState>): number {
      return widestOf(marksFor({ fleet, ...(retire === undefined ? {} : { retire }) }))
    }

    /** The first `count` lanes, landed. */
    function landed(count: number, state = returnAt(RETURN.totalMs)): Map<string, RetireState> {
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
      // Half again as big, on a fixture whose twenty lanes are nowhere near the
      // reference — the growth has to be *visible*, which is the whole of #118,
      // and 5% was what it was worth before.
      expect(previous).toBeGreaterThan(bare * 1.5)

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

    it('is a fact about this session alone — a sibling cannot move it', () => {
      // Ruling 1's discipline, on the mass instead of on a seed: absolute, so the
      // same landed work draws the same size whatever else is in the fleet, and
      // monotone, so nothing about the reading can go backwards.
      expect(rootFullness(0)).toBe(0)
      expect(rootFullness(ROOT_GROWTH.seedTokens)).toBe(0)
      expect(rootFullness(ROOT_GROWTH.fullTokens)).toBe(1)
      expect(rootFullness(ROOT_GROWTH.fullTokens * 10)).toBe(1)
      let previous = -1
      for (const tokens of [0, 25_000, 120_000, 400_000, 1_200_000, 2_000_000]) {
        const now = rootFullness(tokens)
        expect(now, `${tokens} went backwards`).toBeGreaterThanOrEqual(previous)
        previous = now
      }

      // …and the picture obeys it. One lane landing 200K draws exactly the same
      // mass whether its neighbours have landed nothing or ten million between
      // them — the *other* lanes' work is not in this lane's reading, and a fleet
      // whose whales have not landed cannot inflate the centre.
      const one = new Map([[(fleet.lanes[0] as { id: string }).id, returnAt(RETURN.totalMs)]])
      const alone = { ...fleet, lanes: fleet.lanes.map((lane, i) => (i === 0 ? lane : { ...lane, outputTokens: 0 })) }
      const beside = {
        ...fleet,
        lanes: fleet.lanes.map((lane, i) => (i === 0 ? lane : { ...lane, outputTokens: 10_000_000 })),
      }
      expect(widestOf(marksFor({ fleet: beside, retire: one }))).toBe(
        widestOf(marksFor({ fleet: alone, retire: one })),
      )
    })

    /**
     * THE CAP, AND WHAT IT IS MEASURED AGAINST (#118).
     *
     * The claim with teeth: the ceiling is not a number of pixels and not a
     * multiple of the mass — it is {@link ROOT_GROWTH.maxReach} of the scene's own
     * distance to the retirement band, so it holds its meaning on any panel. The
     * assertion is made on **two different panel shapes** for exactly that reason:
     * a cap that had quietly become a pixel count would pass on one of them.
     */
    it('caps against the scene, however much lands on it', () => {
      const whales = {
        ...fleet,
        lanes: fleet.lanes.map((lane) => ({ ...lane, outputTokens: 10_000_000 })),
      }

      for (const panel of [SIZE, { width: 760, height: 640 }]) {
        const geometry = layoutScene(whales, { ...panel, now: NOW, retire: landed(20) })
        const centre = geometry.centre
        const full = Math.max(
          ...sceneMarks({
            ...frameFor({ fleet: whales, retire: landed(20) }),
            geometry,
          })
            .filter((mark) => mark.role === 'root-mass')
            .flatMap((mark) => pointsOf(mark).map((p) => Math.hypot(p.x - centre.x, p.y - centre.y))),
        )
        const ceiling = ROOT_GROWTH.maxReach * Math.min(geometry.rx, geometry.ry)

        // Never past it — the mass may touch the ceiling and may not cross it.
        expect(full, `${panel.width}×${panel.height} crossed the cap`).toBeLessThanOrEqual(ceiling)
        // …and it reaches it, so the cap is a ceiling the picture actually
        // touches rather than a number nothing ever gets near. The 1% is the
        // silhouette's own: the body's furthest lobe sits just inside its radius.
        expect(full, `${panel.width}×${panel.height} never reached the cap`).toBeGreaterThan(
          ceiling * 0.98,
        )
        // The radius the geometry hands out and the ring the painter draws are
        // the same fact, which is what makes the hit target and the newborn
        // clearance trustworthy.
        expect(geometry.rootRadius).toBeCloseTo(ceiling, 9)
        expect(geometry.rootFullness).toBe(1)
      }

      // The cap survives the contour exactly, not approximately, and that is a
      // claim about the sampling rather than about the arithmetic above it: the
      // lattice is a fraction of the mass's own radius, so a mass that grew is
      // sampled at the same *relative* points and comes out scaled to floating
      // point. A fixed pixel grid would re-quantise the surface at every size and
      // this could only ever have been asserted to within half a cell.
      const grown = layoutScene(whales, { ...SIZE, now: NOW, retire: landed(20) })
      const rest = layoutScene(fleet, { ...SIZE, now: NOW })
      expect(widestOf(marksFor({ fleet: whales, retire: landed(20) })) / girthOf()).toBeCloseTo(
        grown.rootRadius / rest.rootRadius,
        9,
      )
    })

    it('never grows past its resting size on a panel with no room for it', () => {
      // The floor is a floor. On a panel so cramped that the ceiling would land
      // below the mass's own resting size, a night's work draws the resting mass
      // rather than a shrunken one — "unknown, not zero" applies to a scene with
      // nowhere to put the answer just as it does to a fleet with no answer.
      expect(rootRadiusFor(60, 40, 40, 1)).toBe(60)
      expect(rootRadiusFor(60, 40, 40, 0)).toBe(60)
      expect(rootRadiusFor(60, 400, 400, 1)).toBe(200)
    })

    it('takes the work home as each cord parts, not when it is queued', () => {
      // The mass grows on `homecoming`, which is the withdraw — so a landing still
      // queued behind the structural cap has not arrived here either, and a wave
      // of them reads as arrivals one at a time rather than as one lurch.
      const queued = girthOf(new Map())
      const parting = girthOf(landed(6, returnAt(RETURN.tensionMs)))
      const arrived = girthOf(landed(6))

      expect(parting).toBe(queued)
      expect(arrived).toBeGreaterThan(parting)
    })

    it('does not un-land work the operator asked not to look at', () => {
      // Hiding finished lanes is a request about clutter, not a claim that the
      // work was undone.
      const shown = marksFor({ fleet, retire: landed(20) })
      const hidden = marksFor({ fleet, retire: landed(20), hideFinished: true })

      expect(widestOf(hidden)).toBe(widestOf(shown))
    })

    /**
     * IT GROWS A BODY, NOT A BALLOON (#118).
     *
     * The silhouette is a similarity transform of the radius by construction, and
     * has to be — the cap's law is exact because of it. On its own that makes a
     * night's work read as the same creature held closer to the eye. What a body
     * actually does when it grows is gain *interior*, so the depth stack is what
     * moves with the fullness: more shells, reaching further in, and a skin that
     * stays a skin instead of becoming a stripe painted round a fill.
     */
    it('gains interior as it fills, rather than being scaled up whole', () => {
      const stack = (retire?: ReadonlyMap<string, RetireState>) => {
        const mark = marksFor({ fleet, ...(retire === undefined ? {} : { retire }) }).find(
          (m) => m.role === 'root-mass',
        )
        if (mark?.kind !== 'contour') throw new Error('the mass is not a contour')
        const shells = mark.shells ?? []
        const rings = shells.map((shell) => shell.rings.length)
        return {
          shells: rings.length,
          // The shells that actually enclose something. A level asked for deeper
          // than the field's own minimum draws nothing, so this is what says the
          // extra layers are material rather than empty walks.
          drawn: rings.filter((count) => count > 0).length,
          // The deepest interior's component count. A multi-octave field comes
          // apart into two, three and four islands as you go in, and resolving
          // more of them is what "gains detail" means here.
          islands: Math.max(...rings),
          // Every surface the interior is drawn as, over the whole stack.
          surfaces: rings.reduce((total, count) => total + count, 0),
          alpha: shells[shells.length - 1]?.ink.alpha ?? 0,
          surface: mark.rings.length,
        }
      }

      const rest = stack()
      const full = stack(landed(20))

      // More layers between the skin and the core, and every one of them is
      // drawing: the alpha step per level stays under the eye over a body with
      // four times the pixels in it.
      expect(full.shells).toBeGreaterThan(rest.shells)
      expect(full.drawn).toBeGreaterThan(rest.drawn)
      expect(full.shells - full.drawn).toBeLessThanOrEqual(rest.shells - rest.drawn + 1)

      // …and the finer stack lands between the interior's own components, so a
      // full mass has an inside where a resting one has a middle. The deepest
      // island count is the same or better — it is bounded by what the field
      // actually contains, not by how finely it is sliced — while the number of
      // surfaces the interior is drawn as goes up with the resolution.
      expect(full.islands).toBeGreaterThanOrEqual(rest.islands)
      expect(full.surfaces).toBeGreaterThan(rest.surfaces)

      // Structure, not opacity. Each level is thinner in proportion, so the mass
      // gained gradations rather than turning into a solid disc — and it is still
      // one surface, which is what keeps it one object.
      expect(full.alpha).toBeLessThan(rest.alpha)
      expect(full.surface).toBe(1)
      expect(rest.surface).toBe(1)
    })

    it('is a size, not a movement — it holds still between frames', () => {
      // Ambient motion is the breath and nothing else (law 10). The girth changes
      // only when a cut advances or a snapshot brings new landed work.
      const at = (now: number): number =>
        widestOf(marksFor({ fleet, retire: landed(8), now, paused: true }))
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
    //
    // prd10 ruling 4 amends the band clause for exactly one mark — a working lane's
    // apex — and *only* that clause: a tip glow is still not an alarm, still wears
    // no alarm ink, still recedes, and is still capped, at `TIP_CEILING`. Its four
    // bounds are asserted in "law 9b, amended within reason" below; what this test
    // keeps is everything the amendment did not touch.
    const alarmInk = [NOTICE, NEEDS_YOU, BROKEN].map(String)
    for (const mark of marks) {
      expect(mark.alarm, `${mark.role} claimed alarm on a calm fleet`).toBe(false)
      const ceiling = mark.role === 'tuft-glow' ? TIP_CEILING : CALM_CEILING
      expect(brightnessOf(mark), `${mark.role} broke into the alarm band`).toBeLessThanOrEqual(
        ceiling + 1e-9,
      )
      expect(brightnessOf(mark)).toBeLessThan(ALARM_FLOOR)
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

  /**
   * DONE: THE SEAL, RESTATED (#117).
   *
   * This law has had three forms and one meaning: **a landed lane is closed off
   * by its own substance, not marked with a badge.** It was a bar struck across
   * the tip; prd7 ruling 3 made it a knot; it is a fold now. The meaning has not
   * moved an inch and the assertions have got stricter, which is the only way a
   * form is allowed to change under ruling 2.
   *
   * What the knot's law actually said was one number — `turning > 2π` — plus a
   * sentence in a comment that was never asserted ("it comes back to where it
   * started"). A full turn is definitionally a ring with an eye in it, so that
   * one number *forced* every landed lane in the fleet to wear the same small
   * pretzel; at thirty-eight of them on one rim the badge became the loudest
   * repeated motif in the picture, which is the exact failure ruling 3 exists to
   * prevent. The number was the bug.
   *
   * Four clauses replace it, and three are new:
   *
   * 1. **it turns back on itself** — total turning ≥ π. The surviving half of
   *    the old claim, at the amount a fold needs. A bar has none.
   * 2. **it comes home** — the spine ends *inside* the node's own lens while
   *    reaching outside it on the way. This is the half the old test only said,
   *    and it is what tells a seal from the tail beside it, which reaches away
   *    and ends outside.
   * 3. **it is the cord, not a mark laid on it** — a ribbon, drawn to nothing
   *    at the end, so it closes rather than stopping.
   * 4. **no two lanes wear the same one** — over a fleet whose lanes have done
   *    *identical work*, every seal is a different shape in its own node's
   *    frame. Nothing in the old law forbade thirty-eight identical stamps.
   *    This forbids two.
   */
  describe('done: the seal is the cord folding home, and no two fold alike', () => {
    const fleet = fleetFor(fleet20Spec())

    /** The whole fleet landed, so there are twenty seals to compare. */
    function allLanded(sizes?: number) {
      return {
        ...fleet,
        lanes: fleet.lanes.map((lane) => ({
          ...lane,
          activity: 'done' as const,
          ...(sizes === undefined ? {} : { outputTokens: sizes }),
        })),
      }
    }

    /** Total signed turning along a spine, in radians. */
    function turning(path: readonly Point[]): number {
      let turned = 0
      for (let i = 1; i < path.length - 1; i += 1) {
        const a = path[i - 1] as Point
        const b = path[i] as Point
        const c = path[i + 1] as Point
        let delta = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)
        while (delta > Math.PI) delta -= 2 * Math.PI
        while (delta < -Math.PI) delta += 2 * Math.PI
        turned += delta
      }
      return turned
    }

    it('turns back on itself, and is the cord rather than a mark laid on it', () => {
      const id = (fleet.lanes[0] as { id: string }).id
      const seal = of(marksFor({ fleet: allLanded() }), id, 'done-mark')[0]

      expect(seal?.kind).toBe('ribbon')
      if (seal?.kind !== 'ribbon') return
      // Clause 1. A bar has two ends and no turning.
      expect(Math.abs(turning(seal.path))).toBeGreaterThanOrEqual(Math.PI)
      // Clause 3. It closes: the cord is gone by the end of itself, which is
      // what "sealed" means about a growing thing rather than about wax.
      expect(seal.widthTip).toBe(0)
      expect(seal.widthRoot).toBeGreaterThan(0)
      expect(widthNear(seal, 0.95)).toBeLessThan(widthNear(seal, 0.1))
    })

    it('comes home — it ends inside the node it grew out of, having left it', () => {
      // Clause 2, and the one that separates a seal from every other terminal in
      // the scene. A tail, a thorn, a barb and a reach all end *away* from the
      // node. This one goes out and comes back in.
      const geometry = frameFor({ fleet: allLanded() }).geometry
      const marks = marksFor({ fleet: allLanded() })

      for (const lane of fleet.lanes) {
        const seal = of(marks, lane.id, 'done-mark')[0]
        expect(seal?.kind, `${lane.id} drew no seal`).toBe('ribbon')
        if (seal?.kind !== 'ribbon') continue

        const thread = geometry.byLane.get(lane.id) as { node: Point; sizeFrac: number }
        // The lens's own half-length: what counts as "inside the body".
        const body = (5 + 14 * thread.sizeFrac) * 0.46
        const from = (point: Point): number =>
          Math.hypot(point.x - thread.node.x, point.y - thread.node.y)

        const last = seal.path[seal.path.length - 1] as Point
        const furthest = Math.max(...seal.path.map(from))
        expect(from(last), `${lane.id}'s seal did not come home`).toBeLessThan(body)
        expect(furthest, `${lane.id}'s seal never left`).toBeGreaterThan(body)
      }

      // …and the tail beside it does the opposite, which is why the two are
      // different marks rather than one drawn twice.
      const laneId = (fleet.lanes[0] as { id: string }).id
      const cutting = { fleet: allLanded(), retire: new Map([[laneId, returnAt(RETURN.totalMs)]]) }
      const scar = marksFor(cutting)
      // The *cut* geometry: a retiring lane's node has travelled out to the rim,
      // so the node this is measured against has to be the one it was drawn at.
      const thread = frameFor(cutting).geometry.byLane.get(laneId) as {
        node: Point
        sizeFrac: number
      }
      const body = (5 + 14 * thread.sizeFrac) * 0.46
      const ends = of(scar, laneId, 'persist-mark')
        .filter((mark) => mark.kind === 'ribbon')
        .map((mark) => {
          const path = mark.kind === 'ribbon' ? mark.path : []
          const last = path[path.length - 1] as Point
          return Math.hypot(last.x - thread.node.x, last.y - thread.node.y)
        })
      expect(ends.some((distance) => distance < body), 'no seal among the scar marks').toBe(true)
      expect(ends.some((distance) => distance > body), 'no reach among the scar marks').toBe(true)
    })

    it('is a different shape on every lane, even when they did identical work', () => {
      // Clause 4 — the anti-stamp law, and the one this whole iteration exists
      // for. Size is *supposed* to change a seal, so size is held constant here:
      // what is being asserted is that two lanes which produced exactly the same
      // output still do not wear the same badge. Compared in each node's own
      // frame, so two lanes at opposite ends of the ring are compared as shapes
      // rather than as positions.
      const landed = allLanded(40_000)
      const geometry = frameFor({ fleet: landed }).geometry
      const marks = marksFor({ fleet: landed })

      const shapes = fleet.lanes.map((lane) => {
        const seal = of(marks, lane.id, 'done-mark')[0]
        const path = seal?.kind === 'ribbon' ? seal.path : []
        const thread = geometry.byLane.get(lane.id) as { node: Point; angle: number }
        const along = tangentAt(
          (geometry.byLane.get(lane.id) as { path: Point[] }).path,
          1,
        )
        const facing = Math.atan2(along.y, along.x)
        // Node-local: translated to the node and turned to face along the thread.
        return path.map((point) => {
          const dx = point.x - thread.node.x
          const dy = point.y - thread.node.y
          return {
            x: dx * Math.cos(-facing) - dy * Math.sin(-facing),
            y: dx * Math.sin(-facing) + dy * Math.cos(-facing),
          }
        })
      })

      const apart = (a: readonly Point[], b: readonly Point[]): number =>
        Math.max(...a.map((point, i) => {
          const other = b[i] as Point
          return Math.hypot(point.x - other.x, point.y - other.y)
        }))

      const pairs = shapes.flatMap((a, i) => shapes.slice(i + 1).map((b) => apart(a, b)))
      expect(pairs.length).toBeGreaterThan(100)
      const sorted = [...pairs].sort((a, b) => a - b)
      const at = (q: number): number => sorted[Math.floor(sorted.length * q)] as number
      // Everything below is in units of the lens the folds grow out of, so the
      // law is about proportions rather than about this fixture's pixels.
      const lens = 5 + 14 * seedSize(40_000)

      // **THERE IS NO MOULD.** Three readings of the same claim, and every one of
      // them is exactly **zero** under the knot this replaced — where twenty
      // lanes of equal work drew twenty byte-identical stamps.
      //
      //  · the fleet spans real shapes, not one shape jittered;
      //  · the *typical* pair differs by a fifth of the mark, not by a hair;
      //  · near-coincidences are the exception rather than the rule.
      expect(Math.max(...pairs) / lens, 'the fleet folds from a mould').toBeGreaterThan(0.45)
      expect(at(0.5) / lens, 'the fold is one shape with a wobble on it').toBeGreaterThan(0.22)
      expect(at(0.1) / lens, 'the fleet folds in families').toBeGreaterThan(0.05)

      // Not "no two are alike", and the difference is worth being honest about:
      // the fold is a function of two hashes of the lane's own handle, so two
      // lanes *can* draw phases close enough to fold alike, and no
      // identity-seeded mapping can promise otherwise. What is forbidden here is
      // a mould — a shape the fleet shares — which is the thing that was
      // actually wrong, and which these three numbers catch at full strength.
    })
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
            author: { name: 'agent', email: 'agent@rhizomorph' },
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

  it('spends no new objects doing any of it, and adds none that scale', () => {
    // The budget claim, counted — restated for prd10 rather than relaxed, because
    // the two rounds make *different* promises and the old number was measuring
    // prd7's. prd7 ruling 3 was a substitution: chevrons became tapers, a knot
    // became a fold, and the display list was not allowed to grow at all. prd10 is
    // an addition — an apex on every growing tip (ruling 4), a bud where telemetry
    // says there is one (ruling 9), substrate and depth (ruling 6) — so a per-lane
    // ceiling alone can only ever ratchet upward as rulings land, and a ceiling that
    // ratchets is not a law.
    //
    // So the claim is now two, and the second is the one that would actually catch
    // the regression this test exists for:
    const calm = marksFor({ fleet: fleetFor(fleet20Spec()) })
    // 1. the per-lane cost stays inside a frame's worth of objects. The number is
    //    the measured 13.4 with headroom, and `perf.test.ts` is where the frame
    //    budget itself is measured rather than proxied.
    expect(calm.length / 20).toBeLessThan(15)

    // 2. **the ambient layer is O(1) in the fleet.** Ruling 6's spores, flora, fog,
    //    vignette and grain are substrate: the picture may not spend more of them
    //    because more lanes turned up, or "ambient" would be a per-lane cost wearing
    //    the word. Two fleets, three times the lanes, the same overhead — and the
    //    same claim in reverse says a viewer cannot read the substrate as a count.
    const ambient = (fleet: Fleet): number =>
      marksFor({ fleet }).filter((mark) => AMBIENT_ROLES.includes(mark.role)).length
    const small = fleetFor(pathologySpec())
    const large = fleetFor(fleet20Spec())
    expect(large.lanes.length).toBeGreaterThan(small.lanes.length * 2)
    expect(ambient(large)).toBe(ambient(small))
    expect(ambient(large)).toBeGreaterThan(0)
  })
})

/** Ruling 6's whole grant: substrate, depth and texture. Nothing per-lane. */
const AMBIENT_ROLES: readonly MarkRole[] = [
  'spore',
  'rim-flora',
  'depth-fog',
  'vignette',
  'grain',
]

/**
 * SIXTY FRAMES A SECOND, STILL (prd7 ruling 1's standing condition).
 *
 * The research measured the live scene locked at 60 fps before any of this, and
 * the ruling is explicit that prd7 is a form change rather than a renderer
 * change — so the one thing it is not allowed to do is buy the form with the
 * frame budget. Thirty lanes is the number the brief names.
 *
 * **Nothing here asserts anything derived from a clock**, and it took two wrong
 * answers to get there. First a wall-clock bound at four times the measured
 * cost, which failed three times in twelve concurrent runs — a 3.6 ms frame
 * measured 17.1 on a loaded box. Then the ratio of building the list to laying
 * it out, on the theory that load dilates both together. It does not: the
 * layout is short and allocates little, the display list is long and allocates a
 * lot, so under memory pressure the numerator suffers and the denominator does
 * not. That failed too, at 10.6× against a bound of 10.
 *
 * The lesson is worth the two failures. Under `--maxWorkers=5` a timing
 * measurement is a measurement *of the machine*, and no amount of normalising
 * turns it back into a measurement of the code. So the frame cost is **reported
 * and not asserted** — it is the issue's deliverable, not its law — and the law
 * beside it is the one that is deterministic.
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
    // which jsdom has no context for. `SceneView` runs both on every
    // `requestAnimationFrame`.
    const lay = (): unknown => layoutScene(fleet, { ...SIZE, now: NOW })
    const build = (): number => sceneMarks({ ...frame, geometry: lay() as never }).length

    // Warm the JIT, so the numbers below are the steady state a running loop
    // sees rather than the first-call cost nobody experiences twice.
    for (let i = 0; i < 6; i += 1) build()

    const time = (work: () => unknown, runs: number): number => {
      const started = performance.now()
      for (let i = 0; i < runs; i += 1) work()
      return (performance.now() - started) / runs
    }

    const layout = time(lay, 20)
    const whole = time(build, 20)

    // eslint-disable-next-line no-console -- the measurement is the deliverable
    console.log(
      `layout + sceneMarks at 30 lanes: ${whole.toFixed(3)} ms/frame (layout ${layout.toFixed(3)})`,
    )

    // The only claim made about the timing: it produced a number. Everything
    // this test is really for lives in the sibling below.
    expect(whole).toBeGreaterThan(0)
  }, HEAVY_CASE_TIMEOUT_MS)

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
          author: { name: 'agent', email: 'agent@rhizomorph' },
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
    ...marksFor({ fleet, retire: new Map([[LANE.healthy, returnAt(RETURN.tensionMs + 120)]]) }),
    // …and one far enough along that its matter has cooled into the accent (prd10
    // ruling 12): the earliest motes of a cut are still their lane's own green, so a
    // corpus that only ever saw a fresh cut would never contain a tissue-coloured
    // mote at all — and the accent's own law would pass by never being exercised.
    ...marksFor({ fleet, retire: new Map([[LANE.healthy, returnAt(RETURN.tensionMs + 900)]]) }),
    // The gap voice, which is chrome rather than a lane's.
    ...marksFor({ fleet: fleetFor(pathologySpec(), false) }),
  ]
}

/**
 * THE PAINTER ACTUALLY RUNS.
 *
 * A gap this change had to close rather than inherit: nothing in the suite had
 * ever executed `paint.ts`. jsdom returns `null` for a 2D context, so
 * `SceneView` correctly declines to draw under test and the executor was
 * literally never called — which was survivable while a ribbon was a loop over
 * `path` that could not really fail, and is not survivable now that the geometry
 * it fills is built somewhere else. An outline that came out empty, or a fill
 * per ribbon instead of per polygon, would have reached a browser before it
 * reached a test.
 *
 * So the context is recorded rather than rasterised. That is the right depth for
 * this seam: `paint.ts` is defined as the file with no opinion about the
 * picture, so what is worth asserting is that it issues the calls the display
 * list implies and none of its own.
 */
describe('paint executes the display list (prd7 ruling 3)', () => {
  interface Recorder {
    calls: string[]
    fills: number
    closes: number
  }

  function recorder(): { ctx: CanvasRenderingContext2D; log: Recorder } {
    const log: Recorder = { calls: [], fills: 0, closes: 0 }
    const note =
      (name: string) =>
      (...args: unknown[]): unknown => {
        log.calls.push(name)
        if (name === 'fill') log.fills += 1
        if (name === 'closePath') log.closes += 1
        if (name === 'createRadialGradient' || name === 'createLinearGradient') {
          return { addColorStop: () => {} }
        }
        return args.length
      }

    const ctx = {
      save: note('save'),
      restore: note('restore'),
      setTransform: note('setTransform'),
      translate: note('translate'),
      rotate: note('rotate'),
      scale: note('scale'),
      beginPath: note('beginPath'),
      closePath: note('closePath'),
      moveTo: note('moveTo'),
      lineTo: note('lineTo'),
      arc: note('arc'),
      fill: note('fill'),
      stroke: note('stroke'),
      fillRect: note('fillRect'),
      strokeRect: note('strokeRect'),
      fillText: note('fillText'),
      setLineDash: note('setLineDash'),
      createRadialGradient: note('createRadialGradient'),
      createLinearGradient: note('createLinearGradient'),
      // prd10's sprite blit and grain tile — the two calls the mote drift and the
      // texture wash reach for. `createPattern` answering null is the honest
      // jsdom reading (no tile can be rasterised), and the painter skips.
      drawImage: note('drawImage'),
      createPattern: () => null,
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
      putImageData: note('putImageData'),
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, log }
  }

  /** jsdom has no `Path2D`; the glyph painter constructs one per sigil. */
  function withPath2D<T>(work: () => T): T {
    const had = 'Path2D' in globalThis
    if (!had) {
      // A *shape*, not an empty class: the painter builds the heart's baked ring
      // geometry imperatively (prd10 ruling 3) as well as stamping glyphs from SVG
      // data, so a stub with no methods would fail on a call a browser answers.
      ;(globalThis as { Path2D?: unknown }).Path2D = class {
        constructor(public d?: string) {}
        moveTo(): void {}
        lineTo(): void {}
        closePath(): void {}
      }
    }
    try {
      return work()
    } finally {
      if (!had) delete (globalThis as { Path2D?: unknown }).Path2D
    }
  }

  it('fills one closed path per outline polygon, and never per ribbon', () => {
    // The rule the winding order forces: two lobes of a severed thread in one
    // path would interact, and the inner one would punch a hole in the outer.
    const marks = marksFor()
    const ribbons = marks.filter((mark) => mark.kind === 'ribbon')
    const polygons = ribbons.reduce(
      (total, mark) => total + (mark.kind === 'ribbon' ? mark.outline.length : 0),
      0,
    )
    expect(polygons).toBeGreaterThan(ribbons.length)

    const { ctx, log } = recorder()
    withPath2D(() => paint({ ctx, marks: ribbons, width: 900, height: 260 }))

    // Exactly one `fill()` per polygon — the backdrop is a `fillRect`, so it
    // does not enter the count.
    expect(log.fills).toBe(polygons)
    expect(log.closes).toBe(polygons)
  })

  it('draws the whole picture without throwing, every kind of it', () => {
    const marks = corpus()
    const { ctx, log } = recorder()
    withPath2D(() => paint({ ctx, marks, width: 900, height: 260, dpr: 2 }))

    expect(log.calls).toContain('fill')
    expect(log.calls).toContain('stroke')
    expect(log.calls).toContain('fillText')
    expect(log.calls).toContain('createRadialGradient')
    expect(log.calls).toContain('createLinearGradient')
  })

  it('draws nothing at all for a mark with no geometry', () => {
    // A ribbon whose width closed everywhere is absent, not a hairline — and the
    // painter must not invent a path for it.
    const { ctx, log } = recorder()
    const empty = ribbonMark({
      role: 'thread',
      laneId: 'nobody',
      alarm: false,
      path: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      widthRoot: 0,
      widthTip: 0,
      paint: { rgb: [255, 255, 255], alpha: 1 },
    })
    withPath2D(() => paint({ ctx, marks: [empty], width: 100, height: 100 }))
    expect(empty.outline).toEqual([])
    expect(log.fills).toBe(0)
    expect(log.calls).not.toContain('beginPath')
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
  const marks = corpus()

  it('covers every kind and every optional field, so the guard is worth having', () => {
    const kinds = new Set(marks.map((mark) => mark.kind))
    expect([...kinds].sort()).toEqual([
      'arc',
      // prd10's four: the heart's baked geometry, the grain tile, the mote drift and
      // the two cached washes. Every one of them has to be in the corpus for the
      // clone guards below to mean anything — a `motes` mark carrying a live pooled
      // record, or a `baked` one carrying a `Path2D`, would be exactly the kind of
      // "the display list stopped being data" this suite exists to refuse.
      'baked',
      'chip',
      'contour',
      'glow',
      'grain',
      'motes',
      'path',
      'ribbon',
      'stroke',
      'text',
      'wash',
    ])

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
 * THE RETURN, on the display list (prd10 rulings 13–16).
 *
 * The whole reason it is worth building this way is that it answers "is this
 * fleet still working?" *structurally* rather than by shade — so these assertions
 * are about what the list **contains**, not about what is bright. "The lane left
 * the living network" is `role === 'thread'` returning nothing for it, which is a
 * fact no future retune of a brightness can quietly undo.
 *
 * What ruling 13 changed is the other half of that sentence: leaving the living
 * network is no longer leaving the *picture*. A finished lane draws a `persist`
 * strand instead of a `thread`, and it draws it for the rest of the session.
 */
describe('the return — a finished lane leaves the living network and keeps its strand', () => {
  const LEAVING = LANE.healthy

  /**
   * Built once for the whole describe rather than per cut: only `retire` varies
   * across the calls below, and `fleetFor` (`reduceAll` + `buildFleet`) is the
   * expensive half of `marksFor` — measured at ~22ms a call against ~7ms for
   * `layoutScene` + `sceneMarks`, the part that actually depends on `ms`. The
   * stage-3 monotonic law samples the settle at two dozen points, so rebuilding
   * an identical fleet at every one of them was three-quarters of its cost for
   * zero difference in the fleet it built (prd3 r34).
   */
  const FLEET = fleetFor(pathologySpec())

  function cut(ms: number, options: FrameOptions = {}): Mark[] {
    return marksFor({ fleet: FLEET, ...options, retire: new Map([[LEAVING, returnAt(ms)]]) })
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
  /** Same rebuild-per-call cost as {@link FLEET} above, and the same fix. */
  const CALM_FLEET = fleetFor(fleet20Spec())
  function calmCut(ms: number, options: FrameOptions = {}): Mark[] {
    return marksFor({
      ...options,
      fleet: CALM_FLEET,
      retire: new Map([[CALM_LANE, returnAt(ms)]]),
    })
  }

  const mine = (marks: readonly Mark[]): Mark[] =>
    marks.filter((mark) => mark.laneId === LEAVING)
  const rolesOf = (marks: readonly Mark[]): Set<MarkRole> =>
    new Set(mine(marks).map((mark) => mark.role))

  it('is not part of the living network at any stage of the return, and never stops being drawn', () => {
    // Past `dissolvedMs` deliberately, and a long way past it: that is the instant
    // the old code deleted the lane's geometry at, and the one a regression would
    // reappear at (prd10 ruling 13).
    for (const ms of [0, RETURN.tensionMs, RETURN.tensionMs + 400, RETURN.totalMs, RETURN.dissolvedMs, RETURN.dissolvedMs + 60_000]) {
      const roles = rolesOf(cut(ms))
      // No thread, and no second growth either: a finished lane is a different
      // kind of object, not a dimmer version of a living one.
      for (const gone of ['thread', 'thread-bloom', 'thread-flow', 'filament', 'filament-tip']) {
        expect(roles.has(gone as MarkRole), `${gone} survived the return at ${ms} ms`).toBe(false)
      }
      expect(roles.has('persist'), `no strand at ${ms} ms`).toBe(true)
    }
    // …while the fleet around it is still threaded, obviously.
    expect(cut(RETURN.totalMs).filter((mark) => mark.role === 'thread').length).toBeGreaterThan(0)
  })

  it('never lights again — no glow, no pulse, no heat', () => {
    // Law 10 says states glow and events travel. A retired lane has no more
    // events and is no longer a state anybody can act on, so it gets neither.
    const marks = mine(cut(RETURN.totalMs))
    expect(marks.filter((mark) => mark.kind === 'glow')).toHaveLength(0)
    for (const role of ['heat', 'pulse', 'pulse-wake', 'tick', 'orbit'] as MarkRole[]) {
      expect(marks.some((mark) => mark.role === role), `${role} on a finished lane`).toBe(false)
    }
  })

  it('drops the faults it was carrying — a finished lane cannot be summoned for', () => {
    // The looping lane, retired: the knot goes with the thread it was tied into.
    const marks = marksFor({ retire: new Map([[LANE.looping, returnAt(RETURN.totalMs)]]) })
    expect(of(marks, LANE.looping, 'looping-mark')).toHaveLength(0)
    expect(of(marks, LANE.looping, 'rank-enclosure')).toHaveLength(0)
    // Not the whole pathology vocabulary, deliberately: a retired looping lane
    // still emits `orbit`, because `lightMarks` never asks whether the lane it
    // is lighting has retired. That is a fact about the scene as it stands, and
    // this rename is not allowed to change a pixel of it — recorded here so the
    // next hand sees it rather than discovering it.
    expect(of(marks, LANE.looping, 'persist').length).toBeGreaterThan(0)
  })

  describe('the three stages, in order', () => {
    it('stage 1 keeps the strand attached and still lit', () => {
      const roles = rolesOf(cut(RETURN.tensionMs * 0.5))
      // The bloom is still there — the light has not gone out yet — and the node
      // wears the same three marks it wore while the lane was working.
      expect(roles.has('persist-bloom')).toBe(true)
      expect(mine(cut(RETURN.tensionMs * 0.5)).filter((m) => m.role === 'persist-mark')).toHaveLength(3)
    })

    it('stage 2 sends the matter home and starts putting the light out', () => {
      const early = mine(cut(RETURN.tensionMs + 40))
      const late = mine(cut(RETURN.tensionMs + RETURN.withdrawMs * 0.9))

      const bloom = (marks: readonly Mark[]): number => {
        const found = marks.find((mark) => mark.role === 'persist-bloom')
        return found === undefined ? 0 : brightnessOf(found)
      }
      // Light leaves before colour does, which is the right order: it was the
      // light that was the lane working.
      expect(bloom(early)).toBeGreaterThan(bloom(late))

      // Still three glyph marks. The fourth used to be the gathered freed end —
      // the bunching of a cord that had sprung back off the mass — and ruling 13
      // has taken the springing back away, so there is no freed end to gather.
      expect(early.filter((mark) => mark.role === 'persist-mark')).toHaveLength(3)
      // What *is* new is the matter in transit.
      expect(early.some((mark) => mark.role === 'homeward')).toBe(true)
    })

    it('stage 3 cools, and only then', () => {
      const inkOf = (ms: number): number[] => {
        const strand = mine(cut(ms)).find((mark) => mark.role === 'persist')
        return [...(inksOf(strand as Mark)[0]?.rgb ?? [])]
      }

      // Colour is untouched until the settle: stages 1 and 2 move curvature and
      // position, and nothing else.
      expect(inkOf(0)).toEqual(inkOf(RETURN.tensionMs + RETURN.withdrawMs * 0.5))
      expect(inkOf(RETURN.totalMs)).not.toEqual(inkOf(0))
      expect(inkOf(RETURN.totalMs)).toEqual([...PERSIST.strand.rgb])
    })

    /**
     * …AND THINS, ON THE SAME NUMBER (prd10 ruling 14).
     *
     * The settle's one output is spent on two drawn channels, because a lane
     * going quiet is one fact and not two. This is the width half; the ink half
     * is above.
     */
    it('stage 3 thins the strand into its resting gauge, monotonically', () => {
      const widthOf = (ms: number): number => {
        const strand = mine(cut(ms)).find((mark) => mark.role === 'persist')
        return strand?.kind === 'ribbon' ? strand.widthRoot : 0
      }

      // Untouched through the withdraw, exactly as the colour is. (Measured from
      // the end of the tension rather than from zero: stage 1 relaxes the taper's
      // *steepness* as the strain goes out, which is its own long-standing
      // channel and not the thinning.)
      expect(widthOf(RETURN.tensionMs + RETURN.withdrawMs * 0.5)).toBeCloseTo(
        widthOf(RETURN.tensionMs),
        9,
      )

      let previous = Infinity
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const at = widthOf(RETURN.tensionMs + RETURN.withdrawMs + RETURN.settleMs * t)
        expect(at).toBeLessThanOrEqual(previous + 1e-9)
        previous = at
      }
      // …and it stops there rather than thinning away for ever.
      expect(widthOf(RETURN.dissolvedMs + 60_000)).toBeCloseTo(widthOf(RETURN.totalMs), 9)
      expect(widthOf(RETURN.totalMs)).toBeGreaterThan(0)
    }, HEAVY_CASE_TIMEOUT_MS)

    it('has no bloom left once it has settled — luminous, without glow', () => {
      expect(rolesOf(cut(RETURN.totalMs)).has('persist-bloom')).toBe(false)
    })
  })

  /**
   * THE SUBSTANCE RETURNS HOME (prd6 ruling 2) — untouched by ruling 13.
   *
   * The display-list half. What makes the claim checkable rather than a matter of
   * taste is that the flow is a `homeward` **ribbon** and not a `pulse`: it is the
   * hypha's own matter being reabsorbed, which is the honest reading of a merge,
   * and it is one of the two things a watched landing has that a replay of one
   * does not. Ruling 15 keeps the beat exactly as it was built — what changed is
   * only that the strand it runs down is still there afterwards.
   */
  describe('the way home', () => {
    const during = mine(cut(RETURN.tensionMs + 120))

    it('flows down the strand while the return runs', () => {
      const flow = during.filter((mark) => mark.role === 'homeward')
      expect(flow).toHaveLength(1)
      const parcel = flow[0] as Mark
      expect(parcel.kind).toBe('ribbon')
      // Matter, not light: no glow anywhere on a finishing lane, still.
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
      // Law 2 of the return, extended: a lane that was already retired when we
      // first saw it arrives settled and never animates. Sending its substance
      // home again would be re-landing work the log is only telling us about.
      for (const marks of [mine(cut(RETURN.totalMs)), mine(cut(0))]) {
        expect(marks.filter((mark) => mark.role === 'homeward')).toHaveLength(0)
      }
      expect(marksFor().filter((mark) => mark.role === 'homeward')).toHaveLength(0)
    })

    it('has no journey to make under reduced motion', () => {
      const still = marksFor({
        reducedMotion: true,
        retire: new Map([[LEAVING, returnAt(0, allowance('structural', 'reduced').travel)]]),
      })
      expect(still.filter((mark) => mark.role === 'homeward')).toHaveLength(0)
    })
  })

  describe('the strand that stays', () => {
    const marks = calmCut(RETURN.totalMs)
    const finished = (role: MarkRole): Mark => of(marks, CALM_LANE, role)[0] as Mark
    const living = (role: MarkRole): Mark =>
      of(marksFor({ fleet: CALM_FLEET }), CALM_LANE, role)[0] as Mark

    it('keeps the name and the figure', () => {
      const name = finished('label')
      const figure = finished('label-figure')
      expect(name?.kind === 'text' && name.text).toBe(
        (fleetFor(fleet20Spec()).lanes.find((lane) => lane.id === CALM_LANE) as { label: string })
          .label,
      )
      expect(figure?.kind === 'text' && figure.text.length).toBeGreaterThan(0)
    })

    it('keeps the figure at full label brightness — the work is not diminished', () => {
      expect(brightnessOf(finished('label-figure'))).toBe(brightnessOf(living('label-figure')))
    })

    it('reduces the name without making it unreadable', () => {
      expect(brightnessOf(finished('label'))).toBeLessThan(brightnessOf(living('label')))
      // A finished lane exists to be identified. Its name is held to the same
      // body-copy footing every other name in the scene is.
      expect(brightnessOf(finished('label'))).toBeGreaterThan(CALM_FLOOR)
    })

    it('never fades to nothing — PERSIST_FLOOR, on every mark it draws', () => {
      // The research law: invisible completion is indistinguishable from a render
      // bug, and the operator cannot tell which of the two they are looking at.
      const drawn = marks.filter((mark) => mark.laneId === CALM_LANE)
      expect(drawn.length).toBeGreaterThan(0)
      for (const mark of drawn) {
        expect(brightnessOf(mark), `${mark.role} faded out`).toBeGreaterThan(PERSIST_FLOOR)
      }
    })

    /**
     * LIVING STRANDS ARE UNMISTAKABLY DOMINANT (prd10 ruling 14) — at a glance,
     * and here as three numbers rather than as a screenshot.
     *
     * *"Living strands must stay unmistakably dominant at a glance: thicker,
     * brighter, moving."* Each clause is a query over the display list, and the
     * comparison is the **same lane** working versus finished, so nothing about
     * one lane's work size can flatter the answer.
     */
    describe('living versus finished, on the same lane', () => {
      const strand = finished('persist')
      const thread = living('thread')

      it('is thinner — at the root and at the tip', () => {
        expect(strand.kind === 'ribbon' && thread.kind === 'ribbon').toBe(true)
        if (strand.kind !== 'ribbon' || thread.kind !== 'ribbon') return
        expect(strand.widthRoot).toBeLessThan(thread.widthRoot)
        expect(strand.widthTip).toBeLessThan(thread.widthTip)
        // Under half at both ends, which is "thin" rather than merely "less".
        // The exact arithmetic is `retire.ts`'s `persistWidths` and is pinned in
        // `retire.test.ts` over the whole work-size range; what this adds is that
        // the display list really is drawn from it — the ratio here is a shade
        // under {@link PERSIST_WIDTH_SCALE} rather than equal to it, because the
        // tension release has already relaxed the strand's taper by then.
        expect(strand.widthRoot / thread.widthRoot).toBeLessThan(PERSIST_WIDTH_SCALE)
        expect(strand.widthTip / thread.widthTip).toBeLessThan(0.5)
      })

      it('is dimmer — under every living thread on the canvas', () => {
        const threads = marks.filter((mark) => mark.role === 'thread')
        expect(threads.length).toBeGreaterThan(0)
        for (const each of threads) {
          expect(brightnessOf(strand), `out-read ${each.laneId}`).toBeLessThan(brightnessOf(each))
        }
      })

      it('is below the floor every living mark is held above — and still visible', () => {
        expect(brightnessOf(strand)).toBeLessThan(CALM_FLOOR)
        expect(brightnessOf(strand)).toBeGreaterThan(PERSIST_FLOOR)
      })

      it('is still — no shimmer, where a living thread has one', () => {
        // The iridescence (ruling 6) runs on `frame.now`, so two frames a third
        // of a shimmer period apart move a living thread's alpha and must not
        // move a finished one's by so much as a hundredth.
        const at = (now: number, role: MarkRole, target: string): number => {
          const found = of(calmCut(RETURN.totalMs, { now }), target, role)[0]
          return found === undefined ? 0 : brightnessOf(found)
        }
        const other = (CALM_FLEET.lanes.find((lane) => lane.id !== CALM_LANE) as {
          id: string
        }).id

        expect(at(NOW, 'persist', CALM_LANE)).toBe(at(NOW + 1_700, 'persist', CALM_LANE))
        expect(at(NOW, 'thread', other)).not.toBe(at(NOW + 1_700, 'thread', other))
      })

      it('sits behind the living network — byDepth, not brightness', () => {
        // Ruling 16's third channel. The claim is about the *list*: every mark a
        // finished lane draws is issued before the first living `thread`, so the
        // painter puts the living network on top without sorting anything.
        const strandAt = marks.findIndex((mark) => mark.role === 'persist')
        const firstThread = marks.findIndex((mark) => mark.role === 'thread')
        expect(strandAt).toBeGreaterThanOrEqual(0)
        expect(firstThread).toBeGreaterThan(strandAt)
      })
    })

    it('recedes with the rest of the calm world when something needs a human', () => {
      // Not an exception to the contrast budget. A finished lane is calm by
      // construction — there is nothing to act on — so when a summons arrives it
      // gets out of the way exactly as every other non-alarm mark does (graft g6).
      const quiet = brightnessOf(of(cut(RETURN.totalMs), LEAVING, 'persist')[0] as Mark)
      const alone = brightnessOf(
        of(cut(RETURN.totalMs, { selectedId: LEAVING }), LEAVING, 'persist')[0] as Mark,
      )
      expect(quiet).toBeLessThan(alone)
      expect(quiet / alone).toBeCloseTo(RECEDE, 6)
    })

    it('is still hollow and still sealed — landed, and not a fault', () => {
      const glyphs = of(marks, CALM_LANE, 'persist-mark')
      const lens = glyphs.find((mark) => mark.kind === 'path' && mark.d.startsWith('M0.04'))
      expect(lens?.kind === 'path' && lens.stroke).toBeDefined()
      // The seal, which is the knot now (prd7 ruling 3) rather than a bar struck
      // across the tip. Exactly as discriminating as the reading it replaces: the
      // lens and the thorn are glyphs, so the one mark of the three that is not a
      // glyph is the seal, and a finished lane that had stopped carrying one would
      // fail here as loudly as it did before.
      expect(glyphs.some((mark) => mark.kind === 'ribbon')).toBe(true)
    })

    it('does not breathe', () => {
      // The ambient layer is the scene being alive, and this lane is not. Two
      // frames half a breath apart draw the node at exactly the same size.
      const at = (now: number): number => {
        const glyph = of(calmCut(RETURN.totalMs, { now }), CALM_LANE, 'persist-mark').find(
          (mark) => mark.kind === 'path' && mark.d.startsWith('M0.04'),
        )
        return glyph?.kind === 'path' ? glyph.size : 0
      }
      expect(at(NOW)).toBeGreaterThan(0)
      expect(at(NOW + 1_350)).toBe(at(NOW))
    })
  })

  /**
   * THE HIDE-FINISHED TOGGLE (prd10 ruling 16) — load-bearing, and therefore
   * tested as a mechanism rather than as a nicety.
   *
   * With the network persisting it is the only thing that takes a finished lane
   * off the canvas, so "it still works" is a law now: on and everything finished
   * is gone, off and all of it is back, and a return in progress is never hidden
   * either way because a completion the operator never saw is the one failure the
   * toggle must not be able to cause.
   */
  describe('the hide-finished toggle', () => {
    const hiddenFleet = () => fleetFor(fleet20Spec())

    it('draws nothing at all for a hidden lane', () => {
      const hidden = marksFor({
        retire: new Map([[LEAVING, returnAt(RETURN.totalMs)]]),
        hideFinished: true,
      })
      expect(hidden.filter((mark) => mark.laneId === LEAVING)).toHaveLength(0)
      // Everyone else is untouched — this hides finished lanes, not lanes.
      expect(hidden.filter((mark) => mark.role === 'thread').length).toBeGreaterThan(0)
    })

    it('takes a whole field of finished lanes off the canvas and puts it back', () => {
      const fleet = hiddenFleet()
      const retire = new Map<string, RetireState>(
        fleet.lanes.map((lane) => [lane.id, returnAt(RETURN.dissolvedMs)]),
      )

      const shown = marksFor({ fleet, retire })
      const hidden = marksFor({ fleet, retire, hideFinished: true })

      expect(shown.filter((mark) => mark.role === 'persist')).toHaveLength(fleet.lanes.length)
      expect(hidden.filter((mark) => mark.role === 'persist')).toHaveLength(0)
      // Nothing of any lane survives the toggle, and the mass and its memoir do:
      // hiding is a request about clutter, never a claim that the work was undone.
      expect(hidden.filter((mark) => mark.laneId !== null)).toHaveLength(0)
      expect(hidden.filter((mark) => mark.role === 'growth-ring')).toHaveLength(fleet.lanes.length)
    })

    it('still shows a return in progress', () => {
      const mid = marksFor({
        retire: new Map([[LEAVING, returnAt(RETURN.tensionMs + 300)]]),
        hideFinished: true,
      })
      expect(mid.filter((mark) => mark.laneId === LEAVING).length).toBeGreaterThan(0)
    })
  })

  describe('reduced motion — stilled in place', () => {
    const still = marksFor({
      reducedMotion: true,
      fleet: fleetFor(fleet20Spec()),
      retire: new Map([[CALM_LANE, returnAt(0, allowance('structural', 'reduced').travel)]]),
    })

    it('shows the end state rather than a stage of a journey — and keeps the strand', () => {
      // Restated for prd10 ruling 13, and stronger than it was: reduced motion is
      // the **swap without the journey**, and the end state the swap arrives at is
      // now a lane whose strand is still threaded into the mass. The version of
      // this test that ruling 13 rescinded asserted the opposite — no ribbon
      // geometry at all — because the composting had erased it. A still line is
      // not motion, so there was never a WCAG reason to take it away.
      const mine = still.filter((mark) => mark.laneId === CALM_LANE)
      const roles = new Set(mine.map((mark) => mark.role))
      expect(roles.has('thread')).toBe(false)
      // No bloom and no journey: the light is out and nothing travelled.
      expect(roles.has('persist-bloom')).toBe(false)
      expect(roles.has('homeward')).toBe(false)
      expect(roles.has('dissolution')).toBe(false)
      // …and the strand itself, thinned and cooled in place.
      expect(roles.has('persist')).toBe(true)
      expect(mine.filter((mark) => mark.kind === 'ribbon').length).toBeGreaterThan(0)
      // Still identified at the rim.
      expect(roles.has('persist-mark')).toBe(true)
      expect(roles.has('label')).toBe(true)
    })

    it('keeps the colour, which is what the success criterion excludes', () => {
      // WCAG 2.3.3's "motion animation" is travel and scale; colour and opacity
      // are explicitly out of scope, so they are exactly what survives. The
      // cooling still happened, in place, with no journey.
      const lens = of(still, CALM_LANE, 'persist-mark')[0] as Mark
      expect(inksOf(lens)[0]?.rgb).toEqual(PERSIST.glyph.rgb)
      expect(brightnessOf(lens)).toBeGreaterThan(PERSIST_FLOOR)
    })
  })

  it('lets a whole fleet retire without ever drawing more than the cap mid-cut', () => {
    // A wave of landings queues, so at any instant at most two lanes are showing
    // a cut that has not finished — the rest are either still threaded or already
    // scarred. This is the display-list reading of ruling 4's structural cap.
    const fleet = fleetFor(fleet20Spec())
    const retire = new Map<string, RetireState>(
      fleet.lanes.map((lane, i) => [lane.id, returnAt(i < 2 ? RETURN.tensionMs + 100 : RETURN.totalMs)]),
    )
    const marks = marksFor({ fleet, retire })

    const midCut = fleet.lanes.filter(
      (lane) => of(marks, lane.id, 'persist-bloom').length > 0,
    )
    expect(midCut.length).toBeLessThanOrEqual(STRUCTURAL.maxConcurrent)
    expect(marks.filter((mark) => mark.role === 'persist')).toHaveLength(20)
  })
})


/**
 * THE RETURN BEAT (prd10 rulings 2, 12 and 15) — as a query over the picture.
 *
 * Ruling 1 is the judge of everything in this round: a replay has to read as
 * emergence, flourishing and **return**, and a choice that looks good live but
 * makes the replay read as clutter or amputation is wrong. Ruling 2 is that
 * judgement applied to the loudest thing the scene does: a landed lane's matter
 * lifts off its cord and streams home, and the heart takes a ring for it.
 *
 * **Ruling 15 keeps the beat and rescinds only its ending.** It used to finish by
 * erasing the cord — "when the last one lands there is no cord left" — and the
 * suite below used to assert exactly that. What travels home is the lane's
 * vitality, not its existence, so the last assertion inverts: the motes end and
 * the strand stays.
 *
 * The laws below are the ones a future retune could break without noticing.
 */
describe('the return beat, and the strand it leaves standing', () => {
  const LEAVING = LANE.healthy
  const cut = (ms: number, options: FrameOptions = {}): Mark[] =>
    marksFor({ ...options, retire: new Map([[LEAVING, returnAt(ms)]]) })
  const mine = (marks: readonly Mark[]): Mark[] => marks.filter((mark) => mark.laneId === LEAVING)

  it('emits a drift of motes along its own path while the matter lifts', () => {
    const drift = of(cut(RETURN.tensionMs + 300), LEAVING, 'dissolution')
    expect(drift).toHaveLength(1)
    const mark = drift[0] as Mark
    expect(mark.kind).toBe('motes')
    if (mark.kind !== 'motes') return
    expect(mark.items.length).toBeGreaterThan(4)

    // On the strand it came off, not beside it: every mote sits on the lane's own
    // spine, which is what makes this the hypha releasing its substance rather
    // than a spray of particles thrown over the top of it.
    const spine = (of(marksFor(), LEAVING, 'thread')[0] as Mark & { kind: 'ribbon' }).path
    for (const mote of mark.items) expect(nearestOn(spine, mote.at)).toBeLessThan(14)
  })

  it('is matter rather than light — no glow, and never a pulse', () => {
    // prd5's law about a retiring lane survives unweakened: a cut lane has no
    // events left, so it gets no `glow` and nothing from the light-in-flight
    // vocabulary. A mote is neither — it is the cord itself, which is why it is a
    // `motes` mark under its own role and its own motion class.
    const during = mine(cut(RETURN.tensionMs + 300))
    expect(during.filter((mark) => mark.kind === 'glow')).toHaveLength(0)
    for (const role of ['pulse', 'pulse-wake', 'tick', 'heat'] as MarkRole[]) {
      expect(during.some((mark) => mark.role === role), `${role} on a returning lane`).toBe(false)
    }
  })

  /**
   * THE INVERTED LAW (prd10 ruling 15) — this is the assertion the issue turns on.
   *
   * It used to read "takes the cord with it — no ribbon geometry survives the
   * dissolve", and it was the thing that made a scrubbed-to-the-end replay an
   * empty rim. The motes still end exactly when they always did; what they leave
   * behind is a strand rather than a gap.
   */
  it('leaves the strand standing when the last mote lands', () => {
    const composting = mine(cut(RETURN.totalMs))
    expect(composting.some((mark) => mark.role === 'persist')).toBe(true)

    const done = mine(cut(RETURN.dissolvedMs))
    expect(done.some((mark) => mark.role === 'dissolution'), 'motes outlived the act').toBe(false)
    expect(done.some((mark) => mark.role === 'persist'), 'the strand was deleted').toBe(true)
    expect(done.filter((mark) => mark.kind === 'ribbon').length).toBeGreaterThan(0)
    // …and everything that says *which* lane it was, exactly as before.
    expect(done.some((mark) => mark.role === 'persist-mark'), 'the lane lost its lens').toBe(true)
    expect(done.some((mark) => mark.role === 'label')).toBe(true)
    expect(done.some((mark) => mark.role === 'label-figure')).toBe(true)

    // A long time later, and unchanged: the strand is a resting state, not a
    // slow fade with a longer clock on it.
    const later = mine(cut(RETURN.dissolvedMs + 3_600_000))
    expect(later.map((mark) => mark.role).sort()).toEqual(done.map((mark) => mark.role).sort())
  })

  it('holds its ink to the end rather than letting go of the picture', () => {
    // The cord used to hold its ink while its matter left and then fade out over
    // the last quarter of the dissolve — `composting()`, deleted with the erasure
    // it was the last frame of. There is nothing left for the ink to trend
    // toward, so it simply stops where the settle put it.
    const inkOf = (ms: number): number => {
      const strand = mine(cut(ms)).find((mark) => mark.role === 'persist')
      return strand === undefined ? 0 : brightnessOf(strand)
    }
    const settled = inkOf(RETURN.totalMs)
    expect(settled).toBeGreaterThan(0)
    expect(inkOf(RETURN.tensionMs + RETURN.withdrawMs + RETURN.settleMs)).toBeCloseTo(settled, 9)
    expect(inkOf(RETURN.dissolvedMs - 200)).toBeCloseTo(settled, 9)
    expect(inkOf(RETURN.dissolvedMs)).toBeCloseTo(settled, 9)
    expect(inkOf(RETURN.dissolvedMs + 3_600_000)).toBeCloseTo(settled, 9)
  })

  it('composts nothing in a replay, and nothing under reduced motion', () => {
    // The same law as the homeward ribbon's, extended: a return nobody watched
    // start is a return that did not happen on this screen. History arrives with
    // `dissolve` already at 1, so a scrub past a landing builds the ring and
    // animates nothing.
    for (const marks of [mine(cut(RETURN.dissolvedMs)), mine(cut(0))]) {
      expect(marks.filter((mark) => mark.role === 'dissolution')).toHaveLength(0)
    }
    const still = marksFor({
      reducedMotion: true,
      retire: new Map([[LEAVING, returnAt(0, allowance('structural', 'reduced').travel)]]),
    })
    expect(still.filter((mark) => mark.role === 'dissolution')).toHaveLength(0)
  })

  it('composts nothing for a hidden lane', () => {
    // A settled lane, because only a settled one is hideable — a return in
    // progress is news and is always shown. This one is still composting
    // (`dissolve` outlives the settle), so without the check it would drift motes
    // over a lane the operator asked not to see, which would be the loudest thing
    // the toggle failed to hide.
    const settled = returnAt(RETURN.totalMs)
    expect(settled.stage).toBe('persistent')
    expect(settled.dissolve).toBeLessThan(1)
    expect(
      of(marksFor({ retire: new Map([[LEAVING, settled]]) }), LEAVING, 'dissolution'),
    ).toHaveLength(1)

    const hidden = marksFor({ retire: new Map([[LEAVING, settled]]), hideFinished: true })
    expect(hidden.filter((mark) => mark.laneId === LEAVING)).toHaveLength(0)
  })

  it('never puts more than the pool on the canvas, whatever lands at once', () => {
    // Twenty lanes returning together — more than the queue would ever allow, and
    // the point: the ceiling is enforced over the *scene*, not per lane, so a wave
    // cannot spend two thousand motes.
    const fleet = fleetFor(fleet20Spec())
    const retire = new Map<string, RetireState>(
      fleet.lanes.map((lane) => [lane.id, returnAt(RETURN.tensionMs + 400)]),
    )
    const marks = marksFor({ fleet, retire })
    const live = marks
      .filter((mark) => mark.role === 'dissolution')
      .reduce((total, mark) => total + (mark.kind === 'motes' ? mark.items.length : 0), 0)

    expect(live).toBeGreaterThan(0)
    expect(live, 'the dissolution pool overflowed').toBeLessThanOrEqual(DISSOLUTION.maxLive)
  })
})

/**
 * A RECORDED SESSION, SCRUBBED TO THE END (prd10 rulings 1, 13 and 16).
 *
 * The round's own judge, as a test — and the suite the operator's replay review
 * overturned. Ruling 1 says every visual decision is judged by how a full-session
 * replay reads, and it named *amputation* as the failure: a night of landed work
 * that leaves a rim of cut-off stubs. prd10 ruling 2 answered that by deleting the
 * stubs, and this file used to assert the deletion — "leaves no orphan geometry",
 * "draws no cord, no stub and no drift".
 *
 * The operator watched the result and ruled the other way (13): an emptying field
 * is the opposite of what this organism is, and a mycelial network does not delete
 * the cords that carried its nutrients. So the same replay is asked the same
 * question and the expected answer has inverted — a night of landed work is a
 * *network*, thin and still and lit, with the heart full in the middle of it.
 *
 * It folds a fleet that has landed, drives the **real** retire registry the way a
 * replay drives it (history, so nothing is ever `note`d as news), and asks the
 * display list what is there.
 */
describe('a replay at scrub-end leaves the whole network standing', () => {
  const finished = (): Fleet => fleetFor(finishedSpec())

  /**
   * The registry as a replay leaves it: every landing is history, so none of them
   * was ever scheduled, and `progress` settles each one outright. This is the same
   * object `SceneView` paints through — nothing here hand-builds a state.
   */
  function scrubEnd(fleet: Fleet): ReadonlyMap<string, RetireState> {
    return new RetireRegistry().progress(fleet, NOW, 'full')
  }

  it('settles every landed lane without animating one of them', () => {
    const fleet = finished()
    const retire = scrubEnd(fleet)
    const landed = fleet.lanes.filter(isRetired)
    expect(landed.length).toBeGreaterThan(10)
    expect(retire.size).toBe(landed.length)
    for (const [laneId, state] of retire) {
      expect(state.stage, `${laneId} was mid-return in a replay`).toBe('persistent')
      expect(state.dissolve).toBe(1)
      expect(state.elapsedMs, `${laneId} claimed we watched it leave`).toBeNull()
    }
  })

  it('draws a strand for every one of them, and no traffic for any', () => {
    const fleet = finished()
    const marks = marksFor({ fleet, retire: scrubEnd(fleet) })
    const landed = fleet.lanes.filter(isRetired)

    // One strand each. This is the assertion the round inverted.
    expect(marks.filter((mark) => mark.role === 'persist')).toHaveLength(landed.length)
    for (const lane of landed) {
      expect(of(marks, lane.id, 'persist'), `${lane.id} lost its strand`).toHaveLength(1)
    }

    // …and nothing that would claim the scene watched it happen: a return nobody
    // saw start is a return that did not happen on this screen.
    const landedIds = new Set(landed.map((lane) => lane.id))
    for (const mark of marks) {
      if (mark.laneId === null || !landedIds.has(mark.laneId)) continue
      for (const role of ['persist-bloom', 'homeward', 'dissolution', 'thread'] as MarkRole[]) {
        expect(mark.role, `${mark.laneId} still carries a ${role}`).not.toBe(role)
      }
    }
  })

  it('still says which lanes those were — completion is never invisible', () => {
    // prd5's law 1, which nothing in this round overrules and which ruling 13
    // strengthens: the operator has to be able to see that a lane finished and
    // read which one, and now the network it was part of says so too.
    const fleet = finished()
    const marks = marksFor({ fleet, retire: scrubEnd(fleet) })
    for (const lane of fleet.lanes.filter(isRetired)) {
      const drawn = marks.filter((mark) => mark.laneId === lane.id)
      expect(drawn.length, `${lane.id} vanished entirely`).toBeGreaterThan(0)
      expect(drawn.some((mark) => mark.role === 'label')).toBe(true)
      for (const mark of drawn) {
        expect(brightnessOf(mark), `${mark.role} faded out`).toBeGreaterThan(PERSIST_FLOOR)
      }
    }
  })

  it('remembers every landing in the heart as well — one ring each', () => {
    // The memoir stands: one growth ring per landed lane, permanent, and
    // deposited by the arrival rather than drawn because a lane exists. It is no
    // longer the *only* record of the night, which is ruling 13's whole point —
    // the network is the other one.
    const fleet = finished()
    const marks = marksFor({ fleet, retire: scrubEnd(fleet) })
    const rings = marks.filter((mark) => mark.role === 'growth-ring')
    expect(rings).toHaveLength(fleet.lanes.filter(isRetired).length)

    // …and a fleet that has landed nothing has no rings at all: the memoir is a
    // record, not an ornament that scales with the fleet.
    const working = marksFor({ fleet: fleetFor(fleet20Spec()) })
    expect(working.filter((mark) => mark.role === 'growth-ring')).toHaveLength(0)
    // The lattice is there either way — it is anatomy, not history.
    expect(working.filter((mark) => mark.role === 'hyphal-fan')).toHaveLength(1)
  })

  /**
   * DENSITY BY HIERARCHY (prd10 ruling 16) — the replay's real test, and the one
   * the operator will look at first.
   *
   * "With dozens of finished lanes the field must still read." The reading is
   * bought in three channels and all three are asserted at once, on a fleet where
   * most lanes have finished: every finished strand is thinner than every living
   * thread, dimmer than every living thread, and issued before all of them.
   */
  it('reads as a network rather than a mesh — every strand under every thread', () => {
    const fleet = finished()
    const marks = marksFor({ fleet, retire: scrubEnd(fleet) })
    const strands = marks.filter((mark) => mark.role === 'persist')
    const threads = marks.filter((mark) => mark.role === 'thread')

    // The premise: this really is a field of mostly-finished lanes.
    expect(strands.length).toBeGreaterThan(10)
    expect(strands.length).toBeGreaterThan(threads.length)

    const widest = (marks: readonly Mark[]): number =>
      Math.max(...marks.map((mark) => (mark.kind === 'ribbon' ? mark.widthRoot : 0)))
    const brightest = (marks: readonly Mark[]): number =>
      Math.max(...marks.map((mark) => brightnessOf(mark)))

    if (threads.length > 0) {
      const thinnestThread = Math.min(
        ...threads.map((mark) => (mark.kind === 'ribbon' ? mark.widthRoot : Infinity)),
      )
      const dimmestThread = Math.min(...threads.map((mark) => brightnessOf(mark)))
      expect(widest(strands), 'a finished strand out-weighed a living thread').toBeLessThan(
        thinnestThread,
      )
      expect(brightest(strands), 'a finished strand out-read a living thread').toBeLessThan(
        dimmestThread,
      )
      // Depth: the last strand is issued before the first thread.
      const lastStrand = marks.map((mark) => mark.role).lastIndexOf('persist')
      const firstThread = marks.findIndex((mark) => mark.role === 'thread')
      expect(firstThread).toBeGreaterThan(lastStrand)
    }
  })

  it('hands the operator one control that empties the field — ruling 16', () => {
    // Load-bearing, so it is tested against the same replay the ruling is about.
    const fleet = finished()
    const retire = scrubEnd(fleet)
    const hidden = marksFor({ fleet, retire, hideFinished: true })
    const landed = new Set(fleet.lanes.filter(isRetired).map((lane) => lane.id))

    expect(hidden.filter((mark) => mark.laneId !== null && landed.has(mark.laneId))).toHaveLength(0)
    // The heart keeps its memoir either way: hiding is about clutter, never a
    // claim that the work was undone.
    expect(hidden.filter((mark) => mark.role === 'growth-ring')).toHaveLength(landed.size)
  })
})

/**
 * THE 9b AMENDMENT (prd10 ruling 4), RESTATED — stricter in its bounds than the
 * law it amends.
 *
 * Law 9b says the band above `CALM_CEILING` belongs to the alarms, and prd4 made
 * that band *the* salience mechanism once hue exclusivity was dropped. Ruling 4
 * opens it a hair: a working lane's tip may carry a small steady glow above the
 * ceiling. That is exactly the kind of amendment that erodes a law, so the ruling
 * bounds it in four ways and every one of them is asserted here.
 *
 * The old assertion — "every calm mark is under the ceiling" — is *kept*, with one
 * named exception whose own ceiling, radius, eligibility and fade behaviour are all
 * pinned. Three of those four clauses did not exist before.
 */
describe('law 9b, amended within reason (prd10 ruling 4)', () => {
  /** A fleet with nothing wrong: no spotlight, so nothing is receded and the tip is at full. */
  const calm = (): Fleet => fleetFor(fleet20Spec())
  const tipGlows = (marks: readonly Mark[]): Mark[] =>
    marks.filter((mark) => mark.role === 'tuft-glow')

  it('still holds every calm mark under the ceiling — except a working tip', () => {
    const marks = marksFor({ fleet: calm() })
    for (const mark of marks) {
      if (mark.alarm || mark.role === 'tuft-glow') continue
      expect(brightnessOf(mark), `${mark.role} broke the calm ceiling`).toBeLessThanOrEqual(
        CALM_CEILING + 1e-9,
      )
    }
  })

  it('lets a working tip past the ceiling and never past the alarm floor', () => {
    const glows = tipGlows(marksFor({ fleet: calm() }))
    expect(glows.length).toBeGreaterThan(0)
    for (const glow of glows) {
      const bright = brightnessOf(glow)
      expect(bright, 'a tip glow stayed inside the calm world').toBeGreaterThan(CALM_CEILING)
      expect(bright, 'a tip glow took the alarm band').toBeLessThanOrEqual(TIP_CEILING + 1e-9)
      expect(bright).toBeLessThan(ALARM_FLOOR)
    }
  })

  it('occupies a small radius, and one that carries nothing', () => {
    // "A small radius" is a bound rather than a channel: a tip glow that grew with
    // the lane's work, or its heat, would be spending the band on a quantity.
    const glows = tipGlows(marksFor({ fleet: calm() }))
    const radii = new Set<number>()
    for (const glow of glows) {
      expect(glow.kind).toBe('glow')
      if (glow.kind !== 'glow') continue
      expect(glow.radius).toBeLessThanOrEqual(TIP_GLOW_RADIUS)
      radii.add(glow.radius)
    }
    // Every lane's is the same size, whatever that lane has done.
    expect(radii.size).toBe(1)
  })

  it('wears none of the alarm grammar — no cartouche, and no fade exemption', () => {
    const marks = marksFor({ fleet: calm() })
    for (const glow of tipGlows(marks)) {
      expect(glow.alarm, 'a tip glow claimed the alarm exemption').toBe(false)
      // The enclosure is the one instrument nothing calm may ever wear, and a lane
      // with a tuft is calm by construction.
      expect(of(marks, glow.laneId as string, 'rank-enclosure')).toHaveLength(0)
    }

    // The load-bearing half: it recedes like every other calm mark. One lane
    // spotlit, the rest at `RECEDE` — including their tips.
    const spotlit = marksFor({ fleet: calm(), selectedId: '101-thread-rollup' })
    const other = tipGlows(spotlit).find((mark) => mark.laneId !== '101-thread-rollup') as Mark
    const held = tipGlows(spotlit).find((mark) => mark.laneId === '101-thread-rollup') as Mark
    expect(brightnessOf(other) / brightnessOf(held)).toBeCloseTo(RECEDE, 6)
    expect(brightnessOf(other)).toBeLessThan(CALM_CEILING)
  })

  it('is a *working* tip only — nothing else in the fleet has one', () => {
    // The eligibility clause, on the staged fixture: a waiting lane's apex is not
    // growing, a frozen one's is dead, a landed one's has stopped, and a lane in
    // any of those states already has its own vocabulary at the node.
    const marks = marksFor()
    for (const laneId of [LANE.waiting, LANE.frozen, LANE.looping, LANE.expensive, LANE.offFence]) {
      expect(of(marks, laneId, 'tuft-glow'), `${laneId} grew an apex`).toHaveLength(0)
      expect(of(marks, laneId, 'tuft'), `${laneId} grew branchlets`).toHaveLength(0)
    }
    // …and a landed lane's tuft goes with its cord.
    const landed = marksFor({ retire: new Map([[LANE.healthy, returnAt(RETURN.dissolvedMs)]]) })
    expect(of(landed, LANE.healthy, 'tuft-glow')).toHaveLength(0)
  })

  it('lets an alarm anywhere on screen still dominate at a glance', () => {
    // The claim the whole amendment has to survive, and the one an operator would
    // actually notice breaking. On the staged fixture every summons still out-reads
    // every tip in the fleet — by the band, not by luck.
    const marks = marksFor()
    const tips = tipGlows(marks).map(brightnessOf)
    for (const laneId of [LANE.looping, LANE.waiting, LANE.offFence]) {
      const summons = brightest(marks, laneId)
      expect(summons).toBeGreaterThanOrEqual(ALARM_FLOOR)
      for (const tip of tips) expect(summons, 'a tip out-read a summons').toBeGreaterThan(tip)
    }
  })

  it('grows two or three branchlets, in the family hue, off the tip', () => {
    // Ruling 4's form, as far as a law may go: the count and the placement. The
    // *shape* is `node.ts`'s to change (prd7 ruling 2 — a role is the law layer's
    // word, and the law layer may not know the drawing).
    const fleet = calm()
    const marks = marksFor({ fleet })
    const geometry = layoutScene(fleet, { ...SIZE, now: NOW })

    for (const thread of geometry.threads) {
      const tuft = of(marks, thread.laneId, 'tuft')
      expect(tuft.length, `${thread.laneId} has the wrong apex`).toBeGreaterThanOrEqual(2)
      expect(tuft.length).toBeLessThanOrEqual(3)
      // Off the node, reaching away from it: a growth cone is where the organism is
      // still happening, so it is the furthest thing out on the lane.
      for (const branchlet of tuft) {
        expect(reachOf(branchlet, thread.node)).toBeGreaterThan(0)
        expect(reachOf(branchlet, geometry.centre)).toBeGreaterThan(
          Math.hypot(thread.node.x - geometry.centre.x, thread.node.y - geometry.centre.y) * 0.8,
        )
      }
    }
  })
})

/**
 * THE ACCENT'S OWN LAW (prd10 ruling 5) — "the accent class may appear only in
 * scene tissue draws".
 *
 * Two halves, because the ruling makes two different claims and only one of them is
 * about the picture. The first is a claim about this repository: the tokens exist
 * for the scene's organic tissue and for nothing else, so a panel that reached for
 * `--color-tissue-*` would be a violation no display-list test could see. The
 * second is about the marks: no text, no status mark and no chrome may wear it.
 *
 * The source scan is deliberately the strict one — a grep over the real tree rather
 * than a list of files somebody remembered to update.
 */
describe('the tissue accent appears only in tissue draws (prd10 ruling 5)', () => {
  /** Every source file in the web package, so nothing can hide from the scan. */
  function sources(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...sources(path))
      else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(path)
    }
    return out
  }

  const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  it('names the tokens in the theme and reaches for them only from the scene', () => {
    const offenders: string[] = []
    for (const path of sources(WEB)) {
      const text = readFileSync(path, 'utf8')
      if (!/tissue/i.test(text)) continue
      const isTheme = path.endsWith(join('theme', 'theme.css'))
      const isScene = path.includes(`${sep}scene${sep}`)
      // `retire.ts`'s `PERSIST_TISSUE` is a different word for a different thing (the
      // desaturated green a remnant settles into) and predates the accent, so the
      // scan looks for the token family rather than for the word.
      if (isTheme || isScene) continue
      if (/--color-tissue|tissue-(900|700|500|400|200)|TISSUE_/.test(text)) offenders.push(path)
    }
    expect(offenders, 'the accent escaped the scene').toEqual([])
  })

  it('never lets a status mark, a name or the chrome wear it', () => {
    // The display-list half. A tissue-hued ink is one whose hue sits in the accent's
    // own window and which is saturated enough for that window to mean anything —
    // the same OKLCH reading `palette.test.ts` measures the ruling's angles in.
    const marks = corpus()
    for (const mark of marks) {
      if (!inksOf(mark).some(isTissue)) continue
      expect(TISSUE_ROLES, `${mark.role} wore the accent`).toContain(mark.role)
      // Never ink: not a name, not a figure, not a plate behind one.
      expect(['text', 'chip']).not.toContain(mark.kind)
    }
  })

  it('is actually spent — the law would be free if nothing wore it', () => {
    // A permission test passes trivially when nobody uses the permission, so the
    // corpus has to contain the draws the ruling names: the heart's depths, the
    // thread underglow, the spore motes, and the cooling gradient of a return.
    const worn = new Set(
      corpus()
        .filter((mark) => inksOf(mark).some(isTissue))
        .map((mark) => mark.role),
    )
    for (const role of ['spore', 'depth-fog', 'dissolution'] as MarkRole[]) {
      expect(worn, `nothing draws ${role} in tissue`).toContain(role)
    }
  })

  it('gives a thread its underglow without touching the thread itself', () => {
    // Ruling 5's second named home, and the one that had to be spent *without* a
    // new object: the bloom was already the widest, faintest ribbon on every lane,
    // so the undertone is a change of colour. The law is the pair — the light around
    // a thread is bioluminal, and the mark carrying the lane's own family hue is
    // untouched, because that hue is the state (law 9a).
    const marks = marksFor({ fleet: fleetFor(fleet20Spec()) })
    const lane = '101-thread-rollup'
    const thread = (inksOf(of(marks, lane, 'thread')[0] as Mark)[0] as Ink).rgb
    const bloom = (inksOf(of(marks, lane, 'thread-bloom')[0] as Mark)[0] as Ink).rgb

    // The bloom has moved toward the accent — bluer and less green than the thread.
    expect(bloom[2] - bloom[1]).toBeGreaterThan(thread[2] - thread[1])
    // …and the thread is still unmistakably its family's colour.
    expect(thread[1]).toBeGreaterThan(Math.max(thread[0] as number, thread[2] as number))
  })
})

/** Where the accent is allowed: organic tissue, and nowhere else (ruling 5). */
const TISSUE_ROLES: readonly MarkRole[] = [
  'root-mass',
  'growth-ring',
  'hyphal-fan',
  'thread-bloom',
  'spore',
  'rim-flora',
  'depth-fog',
  'dissolution',
  'absorption',
]

/**
 * Is this ink wearing the accent?
 *
 * The **violet signature**, and it is chosen to separate the accent from the one
 * thing it could plausibly be confused with in this instrument: the ice ramp. Ice
 * is a cold blue at every step and runs `r < g < b` (`#b3c6de`); the tissue ramp is
 * red-shifted violet and runs `g < r < b` (`#6b4fa8`). So green sitting *below*
 * red, with real blue above both, is a reading no step of the ice ramp and no
 * status hue can produce — the exact 41° of daylight ruling 11 measured, in the
 * cheapest form that cannot be argued with. The angles themselves are asserted in
 * `palette.test.ts`, where the ramp is.
 */
function isTissue(value: Ink): boolean {
  const [r, g, b] = value.rgb
  return b > r && r > g && b - g >= 10
}

/**
 * TISSUE'S FOURTH HOME (prd10 ruling 6) — the ambient layer, and the caps it does
 * not move.
 */
describe('depth, texture and ambient life (prd10 ruling 6)', () => {
  const marks = marksFor({ fleet: fleetFor(fleet20Spec()) })

  it('lays the panel depth in the chrome pass, not in the world', () => {
    // A vignette that panned with the scene would be a moving smudge: it is a fact
    // about the picture plane. The washes carry the panel's own size, which is what
    // `paint.ts` keys its cached gradient on — one build per resize.
    const washes = marks.filter((mark) => mark.kind === 'wash')
    expect(washes.map((mark) => mark.role).sort()).toEqual(['depth-fog', 'vignette'])
    for (const wash of washes) {
      expect(wash.kind === 'wash' && wash.width).toBe(SIZE.width)
      expect(wash.kind === 'wash' && wash.height).toBe(SIZE.height)
      expect(wash.laneId).toBeNull()
    }
  })

  it('steps the grain at twelve frames a second and no faster', () => {
    // The tile is cached; what moves is its offset, and it may move at most twelve
    // times a second. Sixty would be a screen door — the one texture in this
    // instrument that would genuinely read as motion.
    const tickAt = (now: number): number => {
      const grain = marksFor({ now }).find((mark) => mark.kind === 'grain')
      return grain?.kind === 'grain' ? grain.tick : -1
    }
    // Two frames 16 ms apart are the same tile phase…
    expect(tickAt(NOW + 16)).toBe(tickAt(NOW))
    // …and a twelfth of a second apart, exactly one step.
    expect(tickAt(NOW + 84) - tickAt(NOW)).toBe(1)
    expect(tickAt(NOW + 1000) - tickAt(NOW)).toBe(12)
  })

  it('holds the grain still when the operator pauses', () => {
    const held = marksFor({ paused: true }).find((mark) => mark.kind === 'grain')
    expect(held?.kind === 'grain' && held.tick).toBe(0)
  })

  it('drifts spores that carry nothing and cost the same at any fleet size', () => {
    const drift = marks.find((mark) => mark.role === 'spore')
    expect(drift?.kind).toBe('motes')
    if (drift?.kind !== 'motes') return
    expect(drift.items.length).toBeGreaterThan(8)
    // Ambient, not dissolution: a spore is not a lane's matter coming home, so it
    // is deliberately outside the pool a composting cord draws from.
    expect(drift.role).not.toBe('dissolution')
    expect(drift.laneId).toBeNull()
  })

  it('shimmers each thread inside the ambient ceiling, and out of phase', () => {
    // The drawn amplitude rather than the constant: a thread's ink over a whole
    // shimmer cycle stays inside ±3% of its resting brightness.
    const fleet = fleetFor(fleet20Spec())
    const lane = '101-thread-rollup'
    const at = (now: number): number =>
      brightnessOf(of(marksFor({ fleet, now }), lane, 'thread')[0] as Mark)

    const samples = Array.from({ length: 24 }, (_unused, i) => at(NOW + i * 280))
    const middle = (Math.max(...samples) + Math.min(...samples)) / 2
    for (const sample of samples) {
      expect(Math.abs(sample / middle - 1)).toBeLessThanOrEqual(AMBIENT.maxAmplitude + 1e-9)
    }
    // It actually moves — a shimmer nothing can see is a shimmer nobody wrote.
    expect(Math.max(...samples)).toBeGreaterThan(Math.min(...samples))
  })

  it('shimmers in luminance only, never in hue (law 9a)', () => {
    const fleet = fleetFor(fleet20Spec())
    const lane = '101-thread-rollup'
    // `sampled` builds the layout once and advances the clock over it, which is
    // what isolates the shimmer: re-laying the scene out per sample would also
    // advance the lane's *recency*, and a thread going paler with age is law 9a
    // working rather than a shimmer touching a hue.
    const hues = new Set(
      sampled(NOW, 12, 400, { fleet }).map((frame) =>
        (inksOf(of(frame, lane, 'thread')[0] as Mark)[0] as Ink).rgb.join(','),
      ),
    )
    expect(hues.size, 'a shimmer touched a hue').toBe(1)
  })
})

/**
 * SUBAGENT BUDS (prd10 ruling 9) — anatomy of a parent, never a lane.
 *
 * The data-honesty clauses are the ones worth pinning: liveness comes from the
 * vital the chips lane landed, a lane with no telemetry grows no buds and loses
 * nothing else, and a bud is one level deep because `parent_agent_id` is
 * uncaptured. The return grammar is the fourth: a bud that has finished is
 * *absorbed* rather than deleted.
 */
describe('subagent buds (prd10 ruling 9)', () => {
  const LIVE = '101-thread-rollup'

  /**
   * The twenty-lane fleet with **every** subagent vital cleared.
   *
   * Worth its own helper rather than an assumption: the fixture's lanes run real
   * subagent threads, so `buildFleet` reports vitals for several of them and a test
   * that assumed "no buds by default" would be testing the fixture rather than the
   * rule. This is the no-telemetry case, built explicitly.
   */
  function noBuds(): Fleet {
    const fleet = fleetFor(fleet20Spec())
    return { ...fleet, lanes: fleet.lanes.map((lane) => ({ ...lane, subagents: null })) }
  }

  /** …and the same fleet with exactly one lane's vital set. Read, never re-derived. */
  function withBud(sinceMs: number, laneId = LIVE): Fleet {
    const fleet = noBuds()
    return {
      ...fleet,
      lanes: fleet.lanes.map((lane) =>
        lane.id === laneId
          ? {
              ...lane,
              subagents: {
                lane: lane.id,
                lastActivityTs: NOW - sinceMs,
                agentId: 'agent-1',
                subagentType: 'Explore',
              },
            }
          : lane,
      ),
    }
  }

  it('grows no bud at all when nothing reported one', () => {
    // The gap-honesty clause, and the majority case: `lane.subagents` is null
    // whenever no thread-marked telemetry reached the lane, and null means no bud
    // rather than an empty one. Nothing else about the lane changes.
    const bare = marksFor({ fleet: noBuds() })
    expect(bare.filter((mark) => mark.role === 'bud')).toHaveLength(0)
    expect(bare.filter((mark) => mark.role === 'bud-flare')).toHaveLength(0)
    expect(of(bare, LIVE, 'thread').length).toBeGreaterThan(0)
  })

  it('buds from its own parent thread, one level deep', () => {
    const fleet = withBud(1_000)
    const marks = marksFor({ fleet })
    const buds = marks.filter((mark) => mark.role === 'bud')
    // One lane reported one, so there is one bud — never a second level, because
    // nothing in the log has ever named a nested agent.
    expect(buds).toHaveLength(1)
    expect(buds[0]?.laneId).toBe(LIVE)

    // On its parent's thread: the junction sits on the lane's own spine, which is
    // what makes a bud anatomy rather than a lane of its own (prd2's rule).
    const geometry = layoutScene(fleet, { ...SIZE, now: NOW })
    const parent = geometry.byLane.get(LIVE) as { path: Point[] }
    const bud = buds[0] as Mark & { kind: 'ribbon' }
    expect(nearestOn(parent.path, bud.path[0] as Point)).toBeLessThan(1)
    // …and it reaches away from the thread rather than lying along it.
    expect(nearestOn(parent.path, bud.path[bud.path.length - 1] as Point)).toBeGreaterThan(4)
  })

  it('flares when its subagent just spoke, and not a minute later', () => {
    // Event class, read off the freshest thing the vital reports: `lastActivityTs`.
    // Nothing here holds state or starts a clock, which is what makes a replay draw
    // the same bud as the session that recorded it.
    expect(marksFor({ fleet: withBud(20) }).some((mark) => mark.role === 'bud-flare')).toBe(true)
    expect(marksFor({ fleet: withBud(60_000) }).some((mark) => mark.role === 'bud-flare')).toBe(
      false,
    )
  })

  it('is absorbed back into its parent rather than blinking out', () => {
    // Ruling 2's grammar in miniature, and ruling 9 asks for it by name. As the
    // reading goes stale the branchlet retracts and gives its matter back — to the
    // *parent*, not to the mass, which is the one thing that makes it an absorption
    // rather than a small severance.
    const live = marksFor({ fleet: withBud(1_000) })
    const going = marksFor({ fleet: withBud(DEFAULT_SUBAGENT_RECENCY_MS - 900) })
    const gone = marksFor({ fleet: withBud(DEFAULT_SUBAGENT_RECENCY_MS) })

    const reach = (marks: readonly Mark[]): number => {
      const bud = marks.find((mark) => mark.role === 'bud')
      if (bud?.kind !== 'ribbon') return 0
      const from = bud.path[0] as Point
      const to = bud.path[bud.path.length - 1] as Point
      return Math.hypot(to.x - from.x, to.y - from.y)
    }

    expect(reach(going)).toBeLessThan(reach(live))
    expect(going.some((mark) => mark.role === 'absorption')).toBe(true)
    // And when the evidence expires, so does the bud — with nothing left over.
    expect(gone.some((mark) => mark.role === 'bud')).toBe(false)
    expect(gone.some((mark) => mark.role === 'absorption')).toBe(false)
  })

  it('never buds from a lane that is leaving', () => {
    // Whatever it had handed out, a landing lane has finished: a bud on a cord that
    // is composting would be work carrying on inside something that has left.
    const marks = marksFor({
      fleet: withBud(1_000),
      retire: new Map([[LIVE, returnAt(RETURN.tensionMs + 200)]]),
    })
    expect(marks.filter((mark) => mark.role === 'bud')).toHaveLength(0)
  })

  it('reads the vital rather than re-deriving it', () => {
    // The instruction the issue is explicit about, as a behaviour: change nothing
    // but `lane.subagents` and the bud appears. No telemetry is folded, no window is
    // recomputed, and no lane name is inspected — if the vital says a lane has a
    // live subagent, the scene draws one, and otherwise it does not.
    const fleet = withBud(1_000, '102-cost-authority')
    const buds = marksFor({ fleet }).filter((mark) => mark.role === 'bud')
    expect(buds).toHaveLength(1)
    expect(buds[0]?.laneId).toBe('102-cost-authority')
  })
})

/**
 * MAIN'S OWN BUD (#154, prd10 ruling 9's conductor half) — "the conductor's
 * subagents bud from MAIN's own anatomy", closing the gap #144 filed against
 * itself: `RootMass.subagents` now carries the same vital `Lane.subagents`
 * does, so the mass grows and absorbs a bud through the exact grammar above
 * rather than a fork of it. `laneId === null` is what tells a bud on the mass
 * apart from a bud on a lane's own thread — every root-mass mark carries it.
 */
describe("the conductor's own bud (prd10 ruling 9, #154)", () => {
  function noConductorBud(): Fleet {
    const fleet = fleetFor(fleet20Spec())
    return { ...fleet, root: { ...fleet.root, subagents: null } }
  }

  function withConductorBud(sinceMs: number): Fleet {
    const fleet = noConductorBud()
    return {
      ...fleet,
      root: {
        ...fleet.root,
        subagents: {
          lane: 'conductor',
          lastActivityTs: NOW - sinceMs,
          agentId: 'agent-conductor',
          subagentType: 'Explore',
        },
      },
    }
  }

  const budOnMass = (marks: readonly Mark[]): Mark[] =>
    marks.filter((mark) => mark.laneId === null && mark.role === 'bud')
  const flareOnMass = (marks: readonly Mark[]): Mark[] =>
    marks.filter((mark) => mark.laneId === null && mark.role === 'bud-flare')
  const absorptionOnMass = (marks: readonly Mark[]): Mark[] =>
    marks.filter((mark) => mark.laneId === null && mark.role === 'absorption')

  it('grows no bud on the mass when the conductor has no subagent vital', () => {
    const marks = marksFor({ fleet: noConductorBud() })
    expect(budOnMass(marks)).toHaveLength(0)
    expect(flareOnMass(marks)).toHaveLength(0)
  })

  it("buds off the mass's own rim, never a lane's thread", () => {
    const marks = marksFor({ fleet: withConductorBud(1_000) })
    expect(budOnMass(marks)).toHaveLength(1)
  })

  it('flares when the conductor subagent just spoke, and not a minute later', () => {
    expect(flareOnMass(marksFor({ fleet: withConductorBud(20) }))).toHaveLength(1)
    expect(flareOnMass(marksFor({ fleet: withConductorBud(60_000) }))).toHaveLength(0)
  })

  it('is absorbed back into the mass rather than blinking out', () => {
    const going = marksFor({ fleet: withConductorBud(DEFAULT_SUBAGENT_RECENCY_MS - 900) })
    const gone = marksFor({ fleet: withConductorBud(DEFAULT_SUBAGENT_RECENCY_MS) })

    expect(absorptionOnMass(going)).toHaveLength(1)
    // And when the evidence expires, so does the bud — with nothing left over.
    expect(budOnMass(gone)).toHaveLength(0)
    expect(absorptionOnMass(gone)).toHaveLength(0)
  })

  /**
   * #154's own case, and the exact one #144 filed against itself: a scrub never
   * replays live news, so a bud fed from `PulseField`'s news tail grows none on
   * a recorded session. This frame's `PulseField` is fresh and untouched —
   * nothing was ever `ingest`ed into it — so a bud surviving here can only have
   * come from the fleet snapshot, exactly what a replay hands the scene.
   */
  it('grows the bud from the fleet snapshot alone — a replayed conductor buds with no live news', () => {
    const marks = marksFor({ fleet: withConductorBud(1_000), field: new PulseField() })
    expect(budOnMass(marks)).toHaveLength(1)
  })
})

/**
 * THE DEPTH MAY NOT EAT THE NAMES (prd10 ruling 6, against prd4's legibility law).
 *
 * The one way ruling 6 could have broken something without any existing test
 * noticing. The fog and the vignette are painted in the chrome pass, which puts
 * them *over* the world — and the world is where the lane names are, at the rim,
 * which is exactly where a radial wash is thickest. A `text` mark's own ink is
 * unchanged by a wash laid on top of it, so the display list looks fine and the
 * screen does not.
 *
 * So the veil is bounded, and this is where the bound is read.
 */
describe('the panel depth stays off the labels', () => {
  /** A wash's alpha at `at` fractions of the half-diagonal — `paint.ts`'s own ramp. */
  function veilAt(mark: Mark, at: number): number {
    if (mark.kind !== 'wash') return 0
    const t = (at - mark.from) / (mark.to - mark.from)
    if (t <= 0) return 0
    return mark.outer.alpha * Math.min(1, t)
  }

  /** How far out the furthest lane name actually sits, in half-diagonals. */
  function rimAt(fleet: Fleet): number {
    const geometry = layoutScene(fleet, { ...SIZE, now: NOW })
    const half = Math.hypot(SIZE.width / 2, SIZE.height / 2)
    const furthest = Math.max(
      ...geometry.threads.map((thread) =>
        Math.hypot(
          thread.label.anchor.x - geometry.centre.x,
          thread.label.anchor.y - geometry.centre.y,
        ),
      ),
    )
    return furthest / half
  }

  it('veils the rim by less than a third, fog and vignette together — in both modes', () => {
    const fleet = fleetFor(fleet20Spec())
    // Where a name actually sits, as a fraction of the panel's half-diagonal —
    // the unit the washes are measured in.
    const at = rimAt(fleet)
    expect(at).toBeGreaterThan(0.5)

    const veilOf = (replaying: boolean): number => {
      const washes = marksFor({ fleet, replaying }).filter((mark) => mark.kind === 'wash')
      expect(washes).toHaveLength(2)
      return washes.reduce((total, mark) => total + veilAt(mark, at), 0)
    }

    const live = veilOf(false)
    const replay = veilOf(true)
    expect(live, 'the depth is eating the lane names').toBeLessThanOrEqual(RIM_VEIL)
    // …and the law comes out STRICTER in a replay rather than laxer (#157). The
    // multiplier only ever divides a veil, so the bound written for live mode is
    // the binding one for both, and a replay has strictly more room under it.
    expect(replay, 'the depth is eating the lane names in replay').toBeLessThanOrEqual(RIM_VEIL)
    expect(replay).toBeLessThan(live)
  })

  it('leaves the middle alone entirely — depth is a falloff, not a tint', () => {
    // At the centre both washes are transparent, so the mass and everything near it
    // are painted at exactly the ink they were built with. A wash with a floor would
    // be a filter over the whole picture, which is a different thing from depth.
    for (const mark of marksFor().filter((wash) => wash.kind === 'wash')) {
      expect(veilAt(mark, 0)).toBe(0)
      expect(mark.kind === 'wash' && mark.inner.alpha).toBe(0)
    }
  })
})

/**
 * ONE MULTIPLIER, ONE LAYER (#157) — "live is a working instrument, replay is a
 * retrospective", as arithmetic rather than as a mode switch.
 *
 * The honest framing the ruling is built on: the scene is dimmed on purpose,
 * because a *live* instrument has to be glanceable and a glanceable display
 * spends nothing on the periphery. Nobody glances at a replay. So the ambient
 * dimming — and only the ambient dimming — may relax.
 *
 * That framing is only worth anything if the multiplier cannot reach past the
 * substrate, because the cheapest way to make a replay look better would be to
 * brighten the fleet, and a brighter fleet is a fleet whose *states* have moved.
 * This suite is the fence around it: what it lifts, and the four things it may
 * not touch. Each of the four is checked as "the display list is identical",
 * which is stronger than checking a bound — a mode that changed a status ink by
 * a thousandth would fail it.
 */
describe('replay vibrancy reaches the substrate and nothing else (#157)', () => {
  const FLEET = fleetFor(fleet20Spec())

  /** Everything that is not the ambient substrate, as a comparable list. */
  const AMBIENT_ROLES: readonly MarkRole[] = ['spore', 'rim-flora', 'depth-fog', 'vignette']

  function marksOf(replaying: boolean): Mark[] {
    return marksFor({ fleet: FLEET, replaying })
  }

  function without(marks: readonly Mark[]): Mark[] {
    return marks.filter((mark) => !AMBIENT_ROLES.includes(mark.role))
  }

  it('is one number, and it is above 1 — the law would be free at parity', () => {
    expect(REPLAY_VIBRANCY).toBeGreaterThan(1)
    expect(vibrancyOf(false)).toBe(1)
    expect(vibrancyOf(true)).toBe(REPLAY_VIBRANCY)
  })

  it('lifts the substrate — spores and flora, in luminance and in chroma', () => {
    const lit = (marks: readonly Mark[], role: MarkRole): number =>
      Math.max(0, ...marks.filter((mark) => mark.role === role).map(brightnessOf))

    for (const role of ['spore', 'rim-flora'] as const) {
      expect(lit(marksOf(true), role), `${role} was not lifted`).toBeGreaterThan(
        lit(marksOf(false), role),
      )
    }

    // Chroma as well as luminance, which is the half a plain alpha bump would
    // have missed: the substrate is the accent's own home (ruling 5), and a
    // retrospective is where the tissue ramp is worth actually seeing.
    const chroma = (marks: readonly Mark[]): number => {
      const spores = marks.find((mark) => mark.kind === 'motes' && mark.role === 'spore')
      if (spores?.kind !== 'motes') return 0
      return Math.max(
        ...spores.items.map((mote) => Math.max(...mote.ink.rgb) - Math.min(...mote.ink.rgb)),
      )
    }
    expect(chroma(marksOf(true))).toBeGreaterThan(chroma(marksOf(false)))
  })

  it('relaxes the dimming rather than deepening it', () => {
    const veil = (marks: readonly Mark[], role: MarkRole): number => {
      const wash = marks.find((mark) => mark.role === role)
      return wash?.kind === 'wash' ? wash.outer.alpha : NaN
    }

    for (const role of ['depth-fog', 'vignette'] as const) {
      expect(veil(marksOf(true), role), `${role} got heavier in replay`).toBeLessThan(
        veil(marksOf(false), role),
      )
    }
  })

  it('leaves every other mark in the picture byte-identical', () => {
    // The whole of the fence, in one assertion. Threads, nodes, names, the mass,
    // the light, the chrome and the gap voice: a mode may not move one of them.
    expect(without(marksOf(true))).toEqual(without(marksOf(false)))
  })

  it('never touches a status hue, an alarm, the ladder or the grain', () => {
    const staged = fleetFor(pathologySpec())
    const live = marksFor({ fleet: staged, replaying: false })
    const replay = marksFor({ fleet: staged, replaying: true })

    // The alarm grammar, mark for mark: a replayed summons sits exactly where the
    // live one did, relative to a fleet that is exactly as bright as it was.
    const alarms = (marks: readonly Mark[]) => marks.filter((mark) => mark.alarm)
    expect(alarms(replay)).toEqual(alarms(live))
    expect(alarms(replay).length).toBeGreaterThan(0)

    // …and the calm ceiling still binds every non-alarm mark that is not a tuft
    // glow, at replay vibrancy exactly as at live.
    for (const mark of replay) {
      if (mark.alarm || mark.role === 'tuft-glow') continue
      expect(brightnessOf(mark), `${mark.role} broke the ceiling in replay`).toBeLessThanOrEqual(
        CALM_CEILING + 1e-9,
      )
    }

    // The grain is ambient too, and deliberately outside the multiplier's reach:
    // brightening a crawling 1.6% wash adds noise, not vibrancy, and it is the one
    // ambient mark where this number could have turned into movement.
    const grain = (marks: readonly Mark[]) => marks.filter((mark) => mark.kind === 'grain')
    expect(grain(replay)).toEqual(grain(live))
  })

  it('spends nothing from the motion budget — brighter, not busier', () => {
    // The picture is the same size and shape in both modes: same marks, same
    // count, same geometry. Only four inks differ, and all four are substrate.
    const live = marksOf(false)
    const replay = marksOf(true)
    expect(replay).toHaveLength(live.length)

    const differing = replay.filter((mark, i) => {
      const other = live[i] as Mark
      return JSON.stringify(mark) !== JSON.stringify(other)
    })
    for (const mark of differing) {
      expect(AMBIENT_ROLES, `${mark.role} changed with the mode`).toContain(mark.role)
    }
    expect(differing.length).toBeGreaterThan(0)
  })
})

/**
 * THE SCENE'S TWO CLOCKS (#157's audit, inherited from #155's fence overlap).
 *
 * `SceneFrame` carries two numbers where it used to carry one, and the split is
 * the whole of the audit's finding: **animation timing is real wall time even in
 * a replay, and anything that judges a state by its age is not.**
 *
 * Live they are the same number and nothing below can tell them apart — which is
 * why the split had to be pinned here rather than left to a reading of the code.
 * Each test moves exactly one of the two and names what must and must not follow.
 */
describe("the scene's two clocks", () => {
  const FLEET = fleetFor(pathologySpec())

  function frameAt(now: number, asOf: number): Mark[] {
    const base = frameFor({ fleet: FLEET, now })
    return sceneMarks({ ...base, now, asOf, breath: breathOf(now, motionMode(base)) })
  }

  /** The grain's tile offset — an ambient animation, on the animation clock. */
  function grainTick(marks: readonly Mark[]): number {
    const mark = marks.find((candidate) => candidate.kind === 'grain')
    return mark?.kind === 'grain' ? mark.tick : NaN
  }

  it('runs the animations on wall time, however far the scrub has moved', () => {
    // The scrub held still, the wall clock advanced: everything that *moves* moves.
    const before = frameAt(NOW, NOW)
    const after = frameAt(NOW + 4_000, NOW)

    expect(grainTick(after)).toBeGreaterThan(grainTick(before))
    // …and the breath with it. A replay paused on a frame is still a living
    // picture; freezing it is the pause control's job and nobody else's.
    expect(breathOf(NOW + 1_350, 'full')).not.toBe(breathOf(NOW, 'full'))
  })

  it('judges every age on the state clock, however long the wall clock has run', () => {
    // The wall clock held still, the scrub advanced ten minutes: the fleet ages.
    const before = frameAt(NOW, NOW)
    const after = frameAt(NOW, NOW + RECENCY_SPAN_MS)

    const held = (marks: readonly Mark[]): number =>
      of(marks, LANE.waiting, 'held').reduce(
        (total, mark) => total + (mark.kind === 'glow' ? mark.radius : 0),
        0,
      )
    // Ruling 5: an unanswered summons intensifies with its own age. That age is a
    // state, so it follows the scrub and not the wall.
    expect(held(after)).not.toBe(held(before))
  })

  it('leaves the picture exactly as it was when the two clocks agree', () => {
    // The property that makes the split safe: live is unchanged by construction,
    // because live is the case where both numbers are the same number.
    expect(frameAt(NOW + 900, NOW + 900)).toEqual(
      sceneMarks(frameFor({ fleet: FLEET, now: NOW + 900 })),
    )
  })
})
