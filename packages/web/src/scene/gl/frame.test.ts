import { describe, expect, it, vi } from 'vitest'
import type { Point } from '../geometry.js'
import { ribbonMark, type ContourMark, type Mark, type RibbonMark, type TextMark } from '../marks/index.js'
import { ICE_200, ICE_1000, TISSUE_900, ink } from '../palette.js'
import { PINCH_EPSILON } from '../ribbon.js'
import { Batch } from './batch.js'
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

describe('the settled-ribbon tessellation cache (prd-44 ruling 5)', () => {
  // Distinct laneIds from every other describe block in this file, so a slot
  // ordinal here can never collide with one from an earlier `it()` by
  // content-coincidence.
  /**
   * THE SPINE A SETTLED LANE IS HANDED, FRAME AFTER FRAME — the same array
   * object, memoised here because that is the production invariant and not a
   * convenience (#147).
   *
   * Once `dissolve` pins at 1, `geometry.ts`'s `retiredSpineCacheFor` hands
   * every mark builder ONE cached `path` array for that lane, `thread.ts`'s
   * `PERSIST_RIBBON_CACHE` keys its mark on that array's identity, and
   * `ribbon.ts`'s `OUTLINE_CACHE` keys the outline on it in turn — so the
   * outline's rings are the same objects every frame, which is exactly what
   * `digestRibbon` now reads. A helper that minted a fresh spine per call would
   * be exercising the one condition a settled lane never reaches, and the arms
   * below would be asserting a hit that production gets for a reason the test
   * had removed.
   */
  const spines = new Map<number, readonly Point[]>()
  function settledSpine(y: number): readonly Point[] {
    const known = spines.get(y)
    if (known !== undefined) return known
    const built = Array.from({ length: 20 }, (_unused, i) => ({ x: i * 6, y }))
    spines.set(y, built)
    return built
  }

  function persistMark(laneId: string, y = 80): RibbonMark {
    return ribbonMark({
      ...base,
      role: 'persist',
      laneId,
      path: settledSpine(y),
      widthRoot: 1.4,
      widthTip: 0.6,
      paint: ink(ICE_200, 0.5),
    })
  }

  function liveThread(laneId: string, y = 80): Mark {
    return {
      ...base,
      role: 'thread',
      laneId,
      kind: 'stroke',
      points: [
        { x: 0, y },
        { x: 30, y },
      ],
      width: 2,
      ink: ink(ICE_200, 1),
    }
  }

  // The SHAPE a real living lane actually draws (`marks/thread.ts:158-160`):
  // `kind: 'ribbon'`, `role: 'thread'`. This is the population `isSettledRibbon`
  // must exclude — a `stroke` mark was never going to reach the ribbon-cache
  // code at all, so it cannot stand in for this case.
  //
  // It takes the SAME memoised spine a settled lane gets, deliberately. The
  // gate is `role`, so this mark is the one thing standing between the cache
  // and the population the first attempt's own measurement rejected — and it
  // can only prove that if everything EXCEPT the role says "hit". Given a fresh
  // spine it would miss on identity alone, and the arm below would pass with
  // the gate loosened, which is the mutation it exists to fail (#147).
  function livingRibbon(laneId: string, y = 80): RibbonMark {
    return ribbonMark({
      ...base,
      role: 'thread',
      laneId,
      path: settledSpine(y),
      widthRoot: 1.4,
      widthTip: 0.6,
      paint: ink(ICE_200, 0.5),
    })
  }

  it('writes vertices once, and none again for the same content on the next frame', () => {
    const spy = vi.spyOn(Batch.prototype, 'vertex')
    const first = buildFrame([persistMark('lane-cache-a')], PANEL)
    const afterFirst = spy.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    // A FRESH mark object, same values — exactly what `sceneMarks` hands
    // `buildFrame` every frame for a lane whose `dissolve` has pinned at 1.
    const second = buildFrame([persistMark('lane-cache-a')], PANEL)
    expect(spy.mock.calls.length).toBe(afterFirst)

    // The byte-equal contract the issue names: a cache hit reproduces exactly
    // what a fresh build produced, run structure included.
    expect(Array.from(second.vertices.pos.slice(0, second.vertices.n * 2))).toEqual(
      Array.from(first.vertices.pos.slice(0, first.vertices.n * 2)),
    )
    expect(second.runs).toEqual(first.runs)
    expect(second.drawCalls).toBe(first.drawCalls)
    spy.mockRestore()
  })

  it('changed content is a real miss — this is not a cache that lies', () => {
    const spy = vi.spyOn(Batch.prototype, 'vertex')
    buildFrame([persistMark('lane-cache-b')], PANEL)
    const afterFirst = spy.mock.calls.length
    buildFrame([persistMark('lane-cache-b', 84)], PANEL) // one input moved
    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst)
    spy.mockRestore()
  })

  it('a rebuilt outline is a MISS, never a false hit — the one direction the identity key is allowed to be wrong in', () => {
    // The safety property the key rests on (#147). `digestRibbon` reads the
    // outline's ring IDENTITIES, so a lane whose geometry is rebuilt as fresh
    // arrays — byte-for-byte the same picture — does NOT hit. That is correct
    // and it is the whole licence: a false miss costs exactly the pre-cache
    // tessellation, while a false hit would serve last frame's triangles for
    // this frame's shape. Identity can only ever fail in the safe direction,
    // and this is the arm that says so out loud.
    const spy = vi.spyOn(Batch.prototype, 'vertex')
    const points = (): readonly Point[] =>
      Array.from({ length: 20 }, (_unused, i) => ({ x: i * 6, y: 80 }))
    const of = (path: readonly Point[]): RibbonMark =>
      ribbonMark({
        ...base,
        role: 'persist',
        laneId: 'lane-cache-rebuilt',
        path,
        widthRoot: 1.4,
        widthTip: 0.6,
        paint: ink(ICE_200, 0.5),
      })

    const first = buildFrame([of(points())], PANEL)
    const afterFirst = spy.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)

    // A SEPARATE array of identical points — same picture, new objects.
    const second = buildFrame([of(points())], PANEL)
    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst)

    // …and the miss is a real tessellation, not a degraded one: the safe
    // direction has to stay byte-correct or "false miss" is not the harmless
    // thing this arm claims it is.
    expect(Array.from(second.vertices.pos.slice(0, second.vertices.n * 2))).toEqual(
      Array.from(first.vertices.pos.slice(0, first.vertices.n * 2)),
    )
    expect(second.runs).toEqual(first.runs)
    spy.mockRestore()
  })

  it('a living thread pays no cache overhead — every frame is a full write, not a slot lookup', () => {
    const spy = vi.spyOn(Batch.prototype, 'vertex')
    buildFrame([liveThread('lane-cache-live')], PANEL)
    const firstCalls = spy.mock.calls.length
    spy.mockClear()
    buildFrame([liveThread('lane-cache-live')], PANEL)
    expect(spy.mock.calls.length).toBe(firstCalls)
    spy.mockRestore()
  })

  it('a living RIBBON (kind: ribbon, role: thread) never enters the cache — this is the exact population the rejected first attempt regressed on', () => {
    // `isSettledRibbon` gates on `role`, not `kind`, precisely because a real
    // living lane's own thread IS a `RibbonMark` (`marks/thread.ts:158-160`).
    // If this gate were loosened to `mark.kind === 'ribbon'` — reintroducing
    // exactly the population the first attempt's own measurement rejected —
    // this same-content second frame would be a cache hit (zero writes)
    // instead of a full redraw.
    const spy = vi.spyOn(Batch.prototype, 'vertex')
    buildFrame([livingRibbon('lane-cache-live-ribbon')], PANEL)
    const firstCalls = spy.mock.calls.length
    expect(firstCalls).toBeGreaterThan(0)
    spy.mockClear()
    // Same content, a fresh mark object — exactly the shape that IS a cache
    // hit for a 'persist' role. A 'thread' role must redraw it in full again.
    buildFrame([livingRibbon('lane-cache-live-ribbon')], PANEL)
    expect(spy.mock.calls.length).toBe(firstCalls)
    spy.mockRestore()
  })

  it('a paint-only change on a settled ribbon is a real miss — a settled lane\'s salience can still shift', () => {
    // `budget()` reads live salience even for a settled lane (spotlight, alarm
    // elsewhere in the fleet), so `paint` is NOT pinned the way geometry is —
    // `digestRibbon` has to catch this or a dimmed/brightened settled lane
    // would silently keep serving its old colour forever.
    const spy = vi.spyOn(Batch.prototype, 'vertex')
    const geometry = Array.from({ length: 20 }, (_unused, i) => ({ x: i * 6, y: 80 }))
    buildFrame(
      [
        ribbonMark({
          ...base,
          role: 'persist',
          laneId: 'lane-cache-paint',
          path: geometry,
          widthRoot: 1.4,
          widthTip: 0.6,
          paint: ink(ICE_200, 0.5),
        }),
      ],
      PANEL,
    )
    const afterFirst = spy.mock.calls.length
    buildFrame(
      [
        ribbonMark({
          ...base,
          role: 'persist',
          laneId: 'lane-cache-paint',
          path: geometry, // same geometry, identity included
          widthRoot: 1.4,
          widthTip: 0.6,
          paint: ink(ICE_1000, 1), // only the paint moved
        }),
      ],
      PANEL,
    )
    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst)
    spy.mockRestore()
  })

  it('a settled lane scattered across passes is recognised beside a live neighbour that keeps moving', () => {
    // `sceneMarks` never hands one lane's marks to `buildFrame` contiguously,
    // so this is the case that actually matters: the settled lane's mark
    // lands with a changing live mark on either side, and must still be
    // recognised on its own, contributing zero further vertex writes.
    const settled = persistMark('lane-cache-c')

    const liveSpy = vi.spyOn(Batch.prototype, 'vertex')
    buildFrame([liveThread('lane-cache-live-c', 0)], PANEL)
    const liveAloneCalls = liveSpy.mock.calls.length
    liveSpy.mockRestore()

    const spy = vi.spyOn(Batch.prototype, 'vertex')
    buildFrame([liveThread('lane-cache-live-c', 0), settled], PANEL)
    const afterFirst = spy.mock.calls.length

    buildFrame([liveThread('lane-cache-live-c', 10), persistMark('lane-cache-c')], PANEL)
    const secondCallCalls = spy.mock.calls.length - afterFirst
    // The live mark's own cost, and NOTHING from the settled one.
    expect(secondCallCalls).toBe(liveAloneCalls)
    spy.mockRestore()
  })

  it('a camera change cannot invalidate a settled ribbon — ribbon() never reads panel.camera', () => {
    const spy = vi.spyOn(Batch.prototype, 'vertex')
    buildFrame([persistMark('lane-cache-d')], PANEL)
    const afterFirst = spy.mock.calls.length
    buildFrame([persistMark('lane-cache-d')], { ...PANEL, camera: { k: 2.4, x: 30, y: -10 } })
    expect(spy.mock.calls.length).toBe(afterFirst)
    spy.mockRestore()
  })

  it('a lane leaving the settled state is a guaranteed miss, not a stale hit', () => {
    // A re-dispatched lane arrives with a different ROLE ('thread' instead of
    // 'persist') for the same laneId — a slot `buildFrame` has never filled,
    // so there is nothing stale to serve even before content is compared.
    const spy = vi.spyOn(Batch.prototype, 'vertex')
    buildFrame([persistMark('lane-cache-e')], PANEL)
    const afterFirst = spy.mock.calls.length
    buildFrame([liveThread('lane-cache-e')], PANEL)
    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst)
    spy.mockRestore()
  })

  it('the tail/seal role (persist-mark) is cached too, and independently of the strand', () => {
    const tail = ribbonMark({
      ...base,
      role: 'persist-mark',
      laneId: 'lane-cache-f',
      path: [
        { x: 40, y: 80 },
        { x: 46, y: 78 },
        { x: 50, y: 76 },
      ],
      widthRoot: 2,
      widthTip: 0,
      paint: ink(ICE_1000, 1),
    })

    const spy = vi.spyOn(Batch.prototype, 'vertex')
    buildFrame([tail], PANEL)
    const afterFirst = spy.mock.calls.length
    expect(afterFirst).toBeGreaterThan(0)
    buildFrame([{ ...tail }], PANEL)
    expect(spy.mock.calls.length).toBe(afterFirst)
    spy.mockRestore()
  })

  it('a zero-width settled ribbon takes the stencil path through the cache without corrupting a neighbour', () => {
    // The degenerate (organic-enclosure) branch of ribbon() produces `stencil`
    // runs instead of `tris`. The replay path has to seal whatever run is open
    // BEFORE its first byte lands, exactly as stencil() itself does — getting
    // this wrong swallows a preceding open run's bytes into the stencil fan
    // (the bug fixed on branch 32-spike-per-mark-cache, commit 6ad2777).
    const enclosure = ribbonMark({
      ...base,
      role: 'persist',
      laneId: 'lane-cache-g',
      path: ring(120, 120, 20),
      widthRoot: 0,
      widthTip: 0,
      paint: ink(ICE_200, 1),
    })
    const settled = { ...enclosure, outline: [ring(120, 120, 20)] }
    const live = liveThread('lane-cache-live-g', 0)

    // Ground truth: what the live mark's own tris run costs with no settled
    // neighbour at all — what a seal-position bug would corrupt away from.
    const liveOnly = buildFrame([liveThread('lane-cache-live-g', 0)], PANEL)
    const liveOnlyTris = liveOnly.runs[0]
    expect(liveOnlyTris?.kind === 'tris' && liveOnlyTris.count).toBeGreaterThan(0)
    const liveOnlyCount = liveOnlyTris?.kind === 'tris' ? liveOnlyTris.count : -1

    const fresh = buildFrame([live, settled], PANEL)
    expect(fresh.runs.map((run) => run.kind)).toEqual(['tris', 'stencil'])
    const liveTris = fresh.runs[0]
    // Sealing at the wrong position (the historical bug) makes the stencil's
    // own fill+cover bytes bleed into this count — asserting it against the
    // live-only baseline, not just against itself, is what catches that.
    expect(liveTris?.kind === 'tris' && liveTris.count).toBe(liveOnlyCount)

    // Second frame: the settled ribbon is a cache hit, replayed through the
    // exact same seal-then-splice path — the live neighbour's count must
    // still match the same ground truth, not just match the first (miss) frame.
    const cached = buildFrame([liveThread('lane-cache-live-g', 5), { ...settled }], PANEL)
    expect(cached.runs.map((run) => run.kind)).toEqual(['tris', 'stencil'])
    const cachedLiveTris = cached.runs[0]
    expect(cachedLiveTris?.kind === 'tris' && cachedLiveTris.count).toBe(liveOnlyCount)
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
