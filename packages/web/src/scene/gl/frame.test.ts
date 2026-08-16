import { describe, expect, it } from 'vitest'
import type { Point } from '../geometry.js'
import { ribbonMark, type ContourMark, type Mark, type TextMark } from '../marks/index.js'
import { ICE_200, ICE_1000, TISSUE_900, ink } from '../palette.js'
import { PINCH_EPSILON } from '../ribbon.js'
import { buildFrame, dashRuns, veiled, veilOf, type VeilLayer } from './frame.js'
import { noiseTile } from './programs.js'

/**
 * THE PAINTER'S GEOMETRY, UNDER TEST — which is the thing ADR-0006 booked as
 * untestable and #244 has tracked ever since.
 *
 * jsdom returns `null` for `2d`, `webgl` and `webgl2` alike, so neither painter
 * can rasterise here and the escape hatch ADR-0006 named (`node-canvas`) does not
 * exist for a GPU. What ADR-0021 buys with that is this file: the whole of the
 * decision-making half of the painter — every triangle, every draw range, every
 * blend switch, every colour — is arithmetic over plain arrays and runs at full
 * fidelity with nothing stubbed. The 2D painter could assert that `fill()` had
 * been called. This asserts what was filled.
 *
 * Deterministic counts, never timings.
 */

const PANEL = { width: 900, height: 260 }

const base = { role: 'thread' as const, laneId: null, alarm: false }

function ring(cx: number, cy: number, radius: number, steps = 12): Point[] {
  return Array.from({ length: steps }, (_unused, i) => {
    const angle = (i / steps) * Math.PI * 2
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
  })
}

describe('the display list, in list order', () => {
  /**
   * THE SPIKE'S ONE UNSAFE SHORTCUT, REFUSED.
   *
   * `research/spikes/renderer/webgl.ts` sorted the whole frame into two batches —
   * ink and light — and drew it in two calls. That is a reordering, and additive
   * blending does not commute with source-over: a halo that canvas 2D paints
   * *under* the root-mass would come out on top of it, brightening the middle of
   * the picture. The order is the display list's, so the batching is per run.
   */
  it('opens a new run wherever the blend class changes, and never reorders', () => {
    const marks: Mark[] = [
      { ...base, kind: 'glow', at: { x: 10, y: 10 }, radius: 5, ink: ink(ICE_200, 1) },
      {
        ...base,
        kind: 'stroke',
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
        ],
        width: 2,
        ink: ink(ICE_200, 1),
      },
      { ...base, kind: 'glow', at: { x: 30, y: 10 }, radius: 5, ink: ink(ICE_200, 1) },
    ]

    const frame = buildFrame(marks, PANEL)
    expect(frame.runs.map((run) => run.kind === 'tris' && run.additive)).toEqual([
      true,
      false,
      true,
    ])
    // …and the ranges tile the stream with no gaps and no overlap, which is what
    // makes "in list order" a property of the buffer and not just of the loop.
    let at = 0
    for (const run of frame.runs) {
      if (run.kind !== 'tris') continue
      expect(run.start).toBe(at)
      at += run.count
    }
    expect(at).toBe(frame.vertices.n)
  })

  it('merges neighbours of the same class into one draw call', () => {
    const stroke = (x: number): Mark => ({
      ...base,
      kind: 'stroke',
      points: [
        { x, y: 0 },
        { x: x + 10, y: 0 },
      ],
      width: 2,
      ink: ink(ICE_200, 1),
    })

    const frame = buildFrame([stroke(0), stroke(20), stroke(40)], PANEL)
    expect(frame.runs).toHaveLength(1)
    expect(frame.drawCalls).toBe(1)
  })

  it('paints the chrome last and outside the camera', () => {
    const marks: Mark[] = [
      { ...base, kind: 'glow', at: { x: 10, y: 10 }, radius: 5, ink: ink(ICE_200, 1) },
      {
        ...base,
        role: 'depth-fog',
        kind: 'wash',
        width: PANEL.width,
        height: PANEL.height,
        from: 0.2,
        to: 1,
        inner: ink(TISSUE_900, 0),
        outer: ink(TISSUE_900, 0.3),
      },
      {
        ...base,
        role: 'gap',
        kind: 'text',
        at: { x: 8, y: 250 },
        text: 'no data',
        ink: ink(ICE_200, 1),
        font: 'mono',
        size: 10,
        weight: 400,
        align: 'left',
      },
    ]

    const frame = buildFrame(marks, { ...PANEL, camera: { k: 2, x: 30, y: 0 } })
    expect(frame.runs.map((run) => run.kind)).toEqual(['tris', 'wash'])
    expect(frame.runs[0]?.kind === 'tris' && frame.runs[0].world).toBe(true)
    expect(frame.overlay.map((item) => item.world)).toEqual([false])
  })
})

describe('a ribbon, zipped', () => {
  /** A thread pinched shut in the middle: two lobes meeting at a point. */
  function severed() {
    return ribbonMark({
      ...base,
      path: Array.from({ length: 25 }, (_unused, i) => ({ x: i * 8, y: 40 })),
      widthRoot: 6,
      widthTip: 6,
      stops: [{ at: 0.5, span: 0.12, scale: 0, flat: 0.4 }],
      paint: ink(ICE_200, 1),
    })
  }

  it('keeps every vertex of the outline, which is what keeps the caps', () => {
    // The spike built strips off the *spine* and its two encoded widths, so
    // `perfect-freehand`'s rounded reversal caps were gone and — worse — so was
    // the pinch: a severed lane came out as one healthy thread. Filling the
    // outline instead is what closes both, and this is the check that the
    // tessellation neither invents a vertex nor drops one.
    const mark = severed()
    expect(mark.outline.length).toBe(2)

    const frame = buildFrame([mark], PANEL)
    const emitted = new Set<string>()
    for (let i = 0; i < frame.vertices.n; i += 1) {
      emitted.add(`${frame.vertices.pos[i * 2]},${frame.vertices.pos[i * 2 + 1]}`)
    }
    const authored = new Set(
      mark.outline.flatMap((polygon) =>
        polygon.map((point) => `${Math.fround(point.x)},${Math.fround(point.y)}`),
      ),
    )
    expect(emitted).toEqual(authored)
  })

  it('draws the two lobes as two strips, never as one loop', () => {
    const mark = severed()
    const frame = buildFrame([mark], PANEL)
    const separate = mark.outline.reduce((total, polygon) => total + polygon.length - 2, 0)
    const merged = mark.outline.flat().length - 2
    expect(separate).not.toBe(merged)
    expect(frame.vertices.n / 3).toBe(separate)
  })

  it('leaves a closed region to the stencil, since it has no spine to zip', () => {
    // `regionMark`'s case: the outline *is* the shape (an organic enclosure), so
    // there is no pair of chains to walk and no reason to assume it is
    // star-shaped about anything.
    const region = ribbonMark({
      ...base,
      role: 'rank-enclosure',
      path: ring(100, 100, 30),
      widthRoot: 0,
      widthTip: 0,
      paint: ink(ICE_200, 1),
    })
    // The encoding really is degenerate: nothing is offset from a centre-line.
    expect(region.widthRoot).toBeLessThan(PINCH_EPSILON)

    const frame = buildFrame(
      [{ ...region, outline: [ring(100, 100, 30)] }],
      PANEL,
    )
    expect(frame.runs.map((run) => run.kind)).toEqual(['stencil'])
  })
})

describe('even-odd, without a fill rule', () => {
  /**
   * ADR-0021 named this as a coupling the spike created: the fan-from-centroid it
   * used is correct only for rings that are star-shaped about their centre, which
   * `contour.ts` does not guarantee and nothing enforced. The stencil pass has no
   * such precondition, so the constraint is not made explicit — it is **removed**.
   */
  const nested: ContourMark = {
    ...base,
    role: 'root-mass',
    kind: 'contour',
    rings: [ring(200, 130, 80, 24), ring(200, 130, 30, 24)],
    fill: ink(TISSUE_900, 0.6),
    edge: { width: 1.2, ink: ink(ICE_200, 0.4) },
    shells: [{ rings: [ring(200, 130, 60, 24)], ink: ink(TISSUE_900, 0.2) }],
  }

  it('gives each level its own stencil region, and the rim its own stroke', () => {
    const frame = buildFrame([nested], PANEL)
    expect(frame.runs.map((run) => run.kind)).toEqual(['stencil', 'tris', 'stencil'])
  })

  it('never lets a stencil region leak into the run before it', () => {
    // A run left open when the fans and the cover box are appended is sealed at
    // the stream's length and swallows them, so the box is drawn as an ordinary
    // triangle pair — a filled rectangle over the picture, one per contour. The
    // parity capture found it; this is what keeps it found.
    const before: Mark = {
      ...base,
      kind: 'stroke',
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
      ],
      width: 2,
      ink: ink(ICE_200, 1),
    }

    const alone = buildFrame([before], PANEL).vertices.n
    const frame = buildFrame([before, nested], PANEL)
    const first = frame.runs[0]
    expect(first?.kind).toBe('tris')
    if (first?.kind !== 'tris') return
    expect(first.count).toBe(alone)
  })

  it('covers the bounding box of every ring, holes included', () => {
    const frame = buildFrame([nested], PANEL)
    const surface = frame.runs[0]
    expect(surface?.kind).toBe('stencil')
    if (surface?.kind !== 'stencil') return

    // The stencil takes one fan per ring; the cover is two triangles.
    expect(surface.fillCount).toBe(3 * (24 - 2) * 2)
    expect(surface.coverCount).toBe(6)

    const xs: number[] = []
    for (let i = surface.coverStart; i < surface.coverStart + surface.coverCount; i += 1) {
      xs.push(frame.vertices.pos[i * 2] as number)
    }
    // 80 px of radius, one pixel of pad, about the centre at x = 200.
    expect(Math.min(...xs)).toBeCloseTo(119, 5)
    expect(Math.max(...xs)).toBeCloseTo(281, 5)
  })
})

describe('the panel marks, which have no vertices', () => {
  it('resolves a wash to its two radii and carries both stops', () => {
    const frame = buildFrame(
      [
        {
          ...base,
          role: 'vignette',
          kind: 'wash',
          width: 900,
          height: 260,
          from: 0.62,
          to: 1.18,
          inner: ink(ICE_1000, 0),
          outer: ink(ICE_1000, 0.5),
        },
      ],
      PANEL,
    )
    const wash = frame.runs[0]
    expect(wash?.kind).toBe('wash')
    if (wash?.kind !== 'wash') return
    expect(wash.centre).toEqual({ x: 450, y: 130 })
    expect(wash.from).toBe(0.62)
    expect(wash.outer.alpha).toBe(0.5)
  })

  it('crawls the grain tile by the mark s own step, on both axes', () => {
    const frame = buildFrame(
      [
        {
          ...base,
          role: 'grain',
          kind: 'grain',
          width: 900,
          height: 260,
          tile: 64,
          tick: 10,
          ink: ink(ICE_200, 0.016),
        },
      ],
      PANEL,
    )
    const grain = frame.runs[0]
    expect(grain?.kind).toBe('grain')
    if (grain?.kind !== 'grain') return
    expect(grain.shift).toEqual({ x: 10, y: 6 })
  })

  it('builds the same noise tile every time, on every machine', () => {
    // A fixed xorshift walk, not `Math.random`: two panels in one session and a
    // replay on another box carry the same grain. The same walk `paint.ts` wrote
    // into an `ImageData`, so the print is the print it always was.
    const once = noiseTile(16)
    const again = noiseTile(16)
    expect(Array.from(once)).toEqual(Array.from(again))
    expect(once).toHaveLength(256)
    expect(new Set(once).size).toBeGreaterThan(64)
  })
})

describe('the chrome that used to dim the type', () => {
  const fog: VeilLayer = {
    kind: 'wash',
    centre: { x: 450, y: 130 },
    from: 0,
    to: 1,
    inner: ink(TISSUE_900, 0),
    outer: ink(TISSUE_900, 0.5),
  }

  it('lets a mark at the centre through untouched', () => {
    const veil = veilOf([fog], { x: 450, y: 130 }, PANEL)
    expect(veil.transmit).toBe(1)
    expect(veiled(ink(ICE_200, 1), veil)).toEqual(ink(ICE_200, 1))
  })

  it('folds the wash into the ink of a mark out at the rim', () => {
    const veil = veilOf([fog], { x: 900, y: 260 }, PANEL)
    expect(veil.transmit).toBeCloseTo(0.5, 6)
    const dimmed = veiled(ink(ICE_200, 1), veil)
    // Half the label's own colour, half the fog's — which is exactly what
    // `ctx.fill` produced when both lived on one surface.
    expect(dimmed.rgb[0]).toBeCloseTo(ICE_200[0] / 2 + TISSUE_900[0] / 2, 5)
    expect(dimmed.alpha).toBe(1)
  })

  it('exempts the gap voice, because canvas drew it after the fog too', () => {
    const gap: TextMark = {
      ...base,
      role: 'gap',
      kind: 'text',
      at: { x: 8, y: 250 },
      text: 'no data',
      ink: ink(ICE_200, 1),
      font: 'mono',
      size: 10,
      weight: 400,
      align: 'left',
    }
    const label: TextMark = { ...gap, role: 'label', at: { x: 800, y: 40 } }

    const frame = buildFrame(
      [
        label,
        {
          ...base,
          role: 'depth-fog',
          kind: 'wash',
          width: 900,
          height: 260,
          from: 0,
          to: 1,
          inner: ink(TISSUE_900, 0),
          outer: ink(TISSUE_900, 0.5),
        },
        gap,
      ],
      PANEL,
    )

    const byRole = new Map(frame.overlay.map((item) => [item.mark.role, item]))
    expect(byRole.get('label')?.veil).toHaveLength(1)
    expect(byRole.get('gap')?.veil).toHaveLength(0)
  })
})

describe('a dashed line, walked by hand', () => {
  it('splits on arc length rather than on vertices', () => {
    const runs = dashRuns(
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
      ],
      [6, 4],
      false,
    )
    expect(runs).toHaveLength(3)
    expect(runs[0]).toEqual([
      { x: 0, y: 0 },
      { x: 6, y: 0 },
    ])
    expect(runs[1]?.[0]).toEqual({ x: 10, y: 0 })
    // The line ends inside a gap, so the last dash stops where the pattern says
    // rather than being stretched to the end of it.
    expect(runs[2]).toEqual([
      { x: 20, y: 0 },
      { x: 26, y: 0 },
    ])
  })

  it('carries the phase across a corner', () => {
    const runs = dashRuns(
      [
        { x: 0, y: 0 },
        { x: 8, y: 0 },
        { x: 8, y: 8 },
      ],
      [6, 4],
      false,
    )
    // One 6px run, a 4px gap that straddles the corner, then the rest.
    expect(runs).toHaveLength(2)
    expect(runs[1]?.[0]).toEqual({ x: 8, y: 2 })
  })
})
