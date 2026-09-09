import { describe, expect, it } from 'vitest'
import { DARK_PALETTE, type Ink, LIGHT_PALETTE, type ScenePalette } from '../../scene/palette.js'
import { widthOf } from '../../scene/ribbon.js'
import { AXIS_INSET, markerX } from '../axis/position.js'
import {
  CHECKPOINT_AT_38,
  CHECKPOINT_MOVED,
  checkpointAt,
  experimentOf,
  LIVE_TWO_BY_THREE,
  NO_DISPATCH_RECORDS,
  outcomeOf,
  runOf,
  STOPPED_LAUNCH,
  STOPPED_LAUNCH_FAILED_ARMS,
  UNMEASURED_ARM,
} from './fixtures.js'
import {
  type CanvasPicture,
  canvasHeightFor,
  costWidth,
  FAN_FLIP_FRACTION,
  layoutCanvas,
  MASS_LEVELS,
  organismState,
  PINCH,
  TIP_FORM,
  WIDTH_CAP,
  WIDTH_FLOOR,
} from './organism.js'

/**
 * THE LAWS OF THE PICTURE (prd-55 ruling 11; prd-53 rulings 5, 7, 8). Every
 * test here reads the display list `layoutCanvas` returns — the same list
 * `paint.ts` fills — so what is asserted is what is drawn.
 */

/** Every constant a palette exports, as `r,g,b` keys — the set an ink must resolve to. */
function paletteConstants(palette: ScenePalette): Set<string> {
  const rgbs = [
    ...Object.values(palette.status),
    ...Object.values(palette.register),
    ...palette.tissue,
    ...palette.fruit,
    palette.necrotic,
    palette.ground,
  ]
  return new Set(rgbs.map((rgb) => rgb.join(',')))
}

/** Every ink the picture carries, wherever it sits — a new ink field added tomorrow belongs in this list. */
function inksOf(picture: CanvasPicture): { where: string; ink: Ink }[] {
  const out: { where: string; ink: Ink }[] = [
    { where: 'axis', ink: picture.axis.ink },
    { where: 'drop', ink: picture.drop.ink },
    { where: 'root.fan', ink: picture.root.fan.ink },
    { where: 'root.core', ink: picture.root.core.ink },
    { where: 'emphasis.body', ink: picture.emphasis.body },
    { where: 'emphasis.ring', ink: picture.emphasis.ring },
  ]
  picture.root.shells.forEach((shell, i) => out.push({ where: `root.shells[${i}]`, ink: shell.ink }))
  picture.root.rings.forEach((ring, i) => out.push({ where: `root.rings[${i}]`, ink: ring.ink }))
  for (const ribbon of picture.ribbons) {
    out.push({ where: `${ribbon.id}.ink`, ink: ribbon.ink }, { where: `${ribbon.id}.tip`, ink: ribbon.tip.ink })
    ribbon.motes.forEach((mote, i) => out.push({ where: `${ribbon.id}.motes[${i}]`, ink: mote.ink }))
  }
  picture.stubs.forEach((stub) => out.push({ where: `stub-${stub.arm}`, ink: stub.ink }))
  return out
}

const live = (overrides: Partial<Parameters<typeof layoutCanvas>[0]> = {}) => layoutCanvas({ experiment: LIVE_TWO_BY_THREE, checkpoint: CHECKPOINT_AT_38, ...overrides })

describe('one ribbon per dispatch record — never a synthesised count (prd-53 ruling 5, prd-55 ruling 11)', () => {
  it('ribbons === runs, keyed by the run handles as a set, arm-major then run', () => {
    const picture = live()
    const handles = LIVE_TWO_BY_THREE.arms.flatMap((arm) => arm.runs.map((run) => run.laneHandle))
    expect(picture.ribbons).toHaveLength(handles.length)
    expect(new Set(picture.ribbons.map((ribbon) => ribbon.id))).toEqual(new Set(handles))
    expect(picture.ribbons.map((ribbon) => [ribbon.arm, ribbon.run])).toEqual([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]])
  })

  it('every ribbon is filled geometry the ribbon brush built — several polygons, because a forked reality is drawn broken (prd-12 ruling 3)', () => {
    for (const ribbon of live().ribbons) {
      expect(ribbon.polygons.length).toBeGreaterThan(1)
      for (const polygon of ribbon.polygons) expect(polygon.length).toBeGreaterThan(2)
      expect(ribbon.shape.dashed).toBe(true)
    }
  })

  it('a failed arm is a stub — drawn, named with its error, and never counted (prd-53 ruling 7)', () => {
    const picture = layoutCanvas({ experiment: STOPPED_LAUNCH, checkpoint: CHECKPOINT_AT_38, failedArms: STOPPED_LAUNCH_FAILED_ARMS })
    expect(picture.ribbons).toHaveLength(4)
    expect(picture.stubs).toHaveLength(1)
    expect(picture.stubs[0]).toMatchObject({ arm: 3, error: 'workmux: tmux server not running' })
    expect(picture.stubs[0]?.polygons.length).toBeGreaterThan(0)
    expect(picture.stubs[0]?.ink.rgb).toEqual(DARK_PALETTE.necrotic)
    // On a row of its own below every run, so its name never lands on a run's line — and the picture grew a row to hold it.
    const lowestNode = Math.max(...picture.ribbons.map((ribbon) => ribbon.node.y))
    expect(picture.stubs[0]?.at.y).toBeGreaterThan(lowestNode + 8)
    expect(picture.height).toBe(canvasHeightFor(4, 1))
    expect(canvasHeightFor(4, 1)).toBeGreaterThan(canvasHeightFor(4))
    // Named on the free side of its tip: the label continues the stub's own direction.
    expect((picture.stubs[0]?.at.x ?? 0) > (picture.stubs[0]?.tip.x ?? 0)).toBe(picture.direction === 'right')
  })

  it('EMPTY (ruling 9): with no dispatch records the root is drawn and nothing else is drawn from nothing', () => {
    const picture = layoutCanvas({ experiment: NO_DISPATCH_RECORDS, checkpoint: CHECKPOINT_AT_38 })
    expect(picture.ribbons).toEqual([])
    expect(picture.stubs).toEqual([])
    expect(picture.root.shells[0]?.rings.length).toBeGreaterThan(0)
    expect(picture.root.rings).toEqual([])
    expect(picture.height).toBe(canvasHeightFor(0))
  })

  it('HELD BACK (ruling 9): an unmeasured arm reaches shorter, its tips hollow in WORKING, and no verdict is invented', () => {
    const picture = layoutCanvas({ experiment: UNMEASURED_ARM, checkpoint: CHECKPOINT_AT_38 })
    const judged = live()
    const reach = (p: CanvasPicture, id: string) => {
      const ribbon = p.ribbons.find((r) => r.id === id)
      if (ribbon === undefined) throw new Error(id)
      return Math.hypot(ribbon.node.x - p.root.at.x, ribbon.node.y - p.root.at.y)
    }
    for (const ribbon of picture.ribbons) {
      expect(ribbon.state).toBe('unmeasured')
      expect(ribbon.tip.form).toBe('ring')
      expect(ribbon.tip.ink.rgb).toEqual(DARK_PALETTE.status.working)
    }
    expect(reach(picture, 'lane-u-a2')).toBeLessThan(reach(judged, 'lane-a2'))
    expect(picture.root.rings).toEqual([])
  })
})

describe('the tip is the verdict — prd-53 ruling 5\'s mapping, unchanged, with a form for each hue', () => {
  it('pass DONE disc · fail BROKEN cross · not-run NECROTIC square · unmeasured WORKING ring', () => {
    const byId = new Map(live().ribbons.map((ribbon) => [ribbon.id, ribbon]))
    expect(byId.get('lane-a1')?.tip).toMatchObject({ form: 'disc', ink: { rgb: DARK_PALETTE.status.done } })
    expect(byId.get('lane-b1')?.tip).toMatchObject({ form: 'cross', ink: { rgb: DARK_PALETTE.status.broken } })
    expect(byId.get('lane-b3')?.tip).toMatchObject({ form: 'square', ink: { rgb: DARK_PALETTE.necrotic } })
    expect(byId.get('lane-b2')?.tip).toMatchObject({ form: 'ring', ink: { rgb: DARK_PALETTE.status.working } })
    // Four states, four distinct hues, four distinct forms — colour is never the sole carrier.
    expect(new Set(Object.values(TIP_FORM)).size).toBe(4)
    expect(new Set([...byId.values()].map((r) => r.tip.ink.rgb.join(','))).size).toBe(4)
  })

  it('organismState maps every verdict, and no verdict, to one state', () => {
    expect([undefined, 'pass', 'fail', 'not-run'].map((v) => organismState(v as never))).toEqual(['unmeasured', 'passed', 'failed', 'not-run'])
  })
})

describe('width is booked cost on an ABSOLUTE log scale, with a pinch at the fork (prd-6 ruling 1 kept)', () => {
  it('the ribbon\'s root width is exactly the encoded cost width, and a pinch narrows it just off the root', () => {
    for (const ribbon of live().ribbons) {
      expect(widthOf(ribbon.shape, 0)).toBe(ribbon.width)
      expect(ribbon.width).toBe(costWidth(ribbon.costUsd))
      expect(widthOf(ribbon.shape, PINCH.at)).toBeLessThan(0.5 * widthOf(ribbon.shape, 0.5))
      // Pinched, never severed: a closed ribbon is FROZEN's cut, and no run here is cut.
      expect(widthOf(ribbon.shape, PINCH.at)).toBeGreaterThan(0)
    }
  })

  it('floor for nothing booked, cap past ten dollars, monotone between — and the same dollar is the same width whatever its siblings cost', () => {
    expect(costWidth(null)).toBe(WIDTH_FLOOR)
    expect(costWidth(0)).toBe(WIDTH_FLOOR)
    expect(costWidth(100)).toBe(WIDTH_CAP)
    expect(costWidth(0.1)).toBeLessThan(costWidth(1))
    expect(costWidth(1)).toBeLessThan(costWidth(5))
    const alone = layoutCanvas({ experiment: experimentOf([{ arm: 1, treatment: { model: null, promptDigest: null }, runs: [runOf('x', 1, outcomeOf({ verified: 'pass', costUsd: 1 }))] }]) })
    const crowded = layoutCanvas({
      experiment: experimentOf([
        {
          arm: 1,
          treatment: { model: null, promptDigest: null },
          runs: [
            runOf('x', 1, outcomeOf({ verified: 'pass', costUsd: 1 })),
            runOf('rich', 2, outcomeOf({ verified: 'pass', costUsd: 10 })),
            runOf('poor', 3, outcomeOf({ verified: 'pass', costUsd: 0.01 })),
          ],
        },
      ]),
    })
    expect(crowded.ribbons.find((r) => r.id === 'lane-x')?.width).toBe(alone.ribbons[0]?.width)
  })

  it('the scale is LOG-spaced between its ends: equal cost ratios are equal width steps', () => {
    const ROOT_TEN = Math.sqrt(10)
    const costs = [0.01, 0.01 * ROOT_TEN, 0.1, 0.1 * ROOT_TEN, 1, ROOT_TEN, 10]
    const widths = costs.map(costWidth)
    const step = (WIDTH_CAP - WIDTH_FLOOR) / (costs.length - 1)
    for (const [index, width] of widths.entries()) {
      expect(width).toBeGreaterThanOrEqual(WIDTH_FLOOR)
      expect(width).toBeLessThanOrEqual(WIDTH_CAP)
      if (index > 0) expect(width - (widths[index - 1] as number), `step ${index}`).toBeCloseTo(step, 1)
    }
  })

  it('motes only where a channel carries nothing: a run with nothing booked wears a drift, a booked one wears none', () => {
    const byId = new Map(live().ribbons.map((ribbon) => [ribbon.id, ribbon]))
    expect(byId.get('lane-a1')?.motes).toEqual([])
    expect(byId.get('lane-b1')?.motes).toEqual([])
    expect(byId.get('lane-b2')?.motes.length).toBeGreaterThan(0)
    expect(byId.get('lane-b3')?.motes.length).toBeGreaterThan(0)
    for (const mote of byId.get('lane-b2')?.motes ?? []) expect(mote.ink.rgb).toEqual(DARK_PALETTE.tissue[2])
  })
})

describe('the root keeps its true x on the inset axis, and the fan opens toward the free side (prd-55 ruling 8)', () => {
  it('the root sits at markerX — through the one position function — at every fraction, 100 % included; unplaced, it sits at the inset', () => {
    for (const fraction of [0, 0.38, 0.6, 0.61, 1]) {
      const picture = live({ checkpoint: checkpointAt(fraction) })
      expect(picture.root.at.x, `fraction ${fraction}`).toStrictEqual(markerX(checkpointAt(fraction), 1000))
      expect(picture.drop.x).toStrictEqual(picture.root.at.x)
    }
    // A clamp that kept the root left of 60 % would fail here: at 100 % the true x is the axis's far end.
    expect(live({ checkpoint: checkpointAt(1) }).root.at.x).toBe(1000 - AXIS_INSET)
    const moved = live({ checkpoint: CHECKPOINT_MOVED })
    expect(moved.root.at.x).toBe(AXIS_INSET)
    expect(moved.fraction).toBeNull()
    expect(layoutCanvas({ experiment: LIVE_TWO_BY_THREE }).root.at.x).toBe(AXIS_INSET)
  })

  it(`opens rightward up to ${FAN_FLIP_FRACTION * 100} % and leftward past it — the nodes on the free side of the root`, () => {
    const early = live({ checkpoint: checkpointAt(FAN_FLIP_FRACTION) })
    expect(early.direction).toBe('right')
    for (const ribbon of early.ribbons) expect(ribbon.node.x).toBeGreaterThan(early.root.at.x)
    const late = live({ checkpoint: checkpointAt(FAN_FLIP_FRACTION + 0.01) })
    expect(late.direction).toBe('left')
    for (const ribbon of late.ribbons) expect(ribbon.node.x).toBeLessThan(late.root.at.x)
  })

  it('SWEEP: at every fork position from 0 % to 100 %, at two widths, no node, polygon point, mote or stub lies outside the drawing', () => {
    // Every point of every polygon is checked — tens of thousands per width — so the check is a
    // plain predicate and the ASSERTION is made once over the collected violations: an `expect`
    // per point costs more than the layout does and timed the sweep out under the suite.
    const outside: string[] = []
    for (const width of [1000, 320]) {
      for (let percent = 0; percent <= 100; percent += 1) {
        const picture = layoutCanvas({ experiment: LIVE_TWO_BY_THREE, checkpoint: checkpointAt(percent / 100), failedArms: STOPPED_LAUNCH_FAILED_ARMS, width })
        const inside = (p: { x: number; y: number }, margin = 0) => p.x >= margin && p.x <= picture.width - margin && p.y >= margin && p.y <= picture.height - margin
        const label = `width ${width} at ${percent} %`
        const note = (what: string) => {
          if (outside.length < 20) outside.push(`${label}: ${what}`)
        }
        expect(picture.root.at.x, label).toStrictEqual(markerX(checkpointAt(percent / 100), width))
        for (const ribbon of picture.ribbons) {
          if (!inside(ribbon.node, ribbon.tip.radius)) note(`node ${ribbon.id} at ${ribbon.node.x},${ribbon.node.y}`)
          for (const polygon of ribbon.polygons) for (const point of polygon) if (!inside(point)) note(`ribbon ${ribbon.id} polygon point ${point.x},${point.y}`)
          for (const mote of ribbon.motes) if (!inside(mote.at)) note(`mote of ${ribbon.id} at ${mote.at.x},${mote.at.y}`)
        }
        for (const stub of picture.stubs) {
          if (!inside(stub.at)) note(`stub ${stub.arm} at ${stub.at.x},${stub.at.y}`)
          for (const polygon of stub.polygons) for (const point of polygon) if (!inside(point)) note(`stub ${stub.arm} polygon point ${point.x},${point.y}`)
        }
        for (const shell of picture.root.shells) for (const ring of shell.rings) for (const point of ring) if (!inside(point)) note(`root ring point ${point.x},${point.y}`)
        for (const strand of picture.root.fan.paths) for (const point of strand) if (!inside(point)) note(`root fan point ${point.x},${point.y}`)
      }
    }
    expect(outside).toEqual([])
  })
})

describe('the root-mass is the checkpoint, as tissue (ruling 11)', () => {
  it('contour layers on the tissue ramp — levels of one field, outermost first, climbing the ramp as they deepen, plus the rind — and a fan seeded by the checkpoint', () => {
    const picture = live()
    expect(picture.root.shells).toHaveLength(MASS_LEVELS + 1)
    const ramp = DARK_PALETTE.tissue.map((rgb) => rgb.join(','))
    const steps = picture.root.shells.slice(0, MASS_LEVELS).map((shell) => ramp.indexOf(shell.ink.rgb.join(',')))
    // Every level wears a step of the ramp, the skin its ground-ward end and the core its far end, never stepping back.
    for (const step of steps) expect(step).toBeGreaterThanOrEqual(0)
    expect(steps[0]).toBe(0)
    expect(steps.at(-1)).toBe(ramp.length - 1)
    for (let i = 1; i < steps.length; i += 1) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1] as number)
    // Nearly transparent each: the accumulation is the body, and no single level is an edge (the observatory's own discipline).
    for (const shell of picture.root.shells.slice(0, MASS_LEVELS)) expect(shell.ink.alpha).toBeLessThan(0.25)
    expect(picture.root.shells[0]?.rings.length).toBeGreaterThan(0)
    expect(picture.root.fan.paths.length).toBeGreaterThan(0)
    // Every point of the fan lies within the mass's own skin — anatomy inside the body, not hairs on it. The heart's
    // strands run to 1.19 of a mass's radius in the observatory ("just past the rim, so a strand meets the threads
    // outside"); here they are placed at `FAN_SCALE` so the longest lands inside the rim.
    for (const strand of picture.root.fan.paths) for (const point of strand) expect(Math.hypot(point.x - picture.root.at.x, point.y - picture.root.at.y)).toBeLessThanOrEqual(picture.root.radius)
    // Seeded by the checkpoint: another checkpoint, another fan; the same one, the same fan.
    const other = layoutCanvas({ experiment: { ...LIVE_TWO_BY_THREE, checkpointId: 'ckpt-other' }, checkpoint: CHECKPOINT_AT_38 })
    expect(other.root.fan.paths).not.toEqual(picture.root.fan.paths)
    expect(live().root.fan.paths).toEqual(picture.root.fan.paths)
  })

  it('one growth ring per run a gate has JUDGED — pass or fail — and none for a run it did not', () => {
    const picture = live()
    const judged = LIVE_TWO_BY_THREE.arms.flatMap((arm) => arm.runs).filter((run) => run.outcome?.verified === 'pass' || run.outcome?.verified === 'fail')
    expect(picture.root.rings.map((ring) => ring.id).sort()).toEqual(judged.map((run) => run.laneHandle).sort())
    expect(picture.root.rings).toHaveLength(4)
    // A heavier booking lays down a heavier ring — the work-size channel, on the same absolute scale.
    const widthOfRing = (id: string) => picture.root.rings.find((ring) => ring.id === id)?.width ?? Number.NaN
    expect(widthOfRing('lane-a3')).toBeGreaterThan(widthOfRing('lane-b1'))
  })
})

describe('every ink is a palette constant, and the picture is a pure function of the record', () => {
  it.each([
    ['dark', DARK_PALETTE],
    ['light', LIGHT_PALETTE],
  ] as const)('%s: every ink in the picture resolves to a constant the palette exports — nothing reaches for a hex or a mix', (_name, palette) => {
    const constants = paletteConstants(palette)
    const picture = layoutCanvas({ experiment: LIVE_TWO_BY_THREE, checkpoint: CHECKPOINT_AT_38, failedArms: STOPPED_LAUNCH_FAILED_ARMS, palette })
    const inks = inksOf(picture)
    expect(inks.length).toBeGreaterThan(20)
    for (const { where, ink } of inks) {
      expect(constants.has(ink.rgb.join(',')), `${where} wears ${ink.rgb.join(',')}, which no palette constant is`).toBe(true)
      expect(ink.alpha).toBeGreaterThan(0)
      expect(ink.alpha).toBeLessThanOrEqual(1)
    }
  })

  it('the same record draws the same picture — no clock, no random, no motion input', () => {
    const options = { experiment: LIVE_TWO_BY_THREE, checkpoint: CHECKPOINT_AT_38, failedArms: STOPPED_LAUNCH_FAILED_ARMS }
    expect(layoutCanvas(options)).toEqual(layoutCanvas(options))
  })

  it('the height fits its ribbons — one row each, within sane bounds', () => {
    expect(canvasHeightFor(0)).toBe(160)
    expect(canvasHeightFor(6)).toBe(226)
    expect(canvasHeightFor(180)).toBe(640)
    const tall = layoutCanvas({ experiment: LIVE_TWO_BY_THREE })
    expect(tall.height).toBe(canvasHeightFor(6))
    const ys = tall.ribbons.map((ribbon) => ribbon.node.y)
    for (let i = 1; i < ys.length; i += 1) expect((ys[i] as number) - (ys[i - 1] as number)).toBeCloseTo(26, 5)
  })
})
