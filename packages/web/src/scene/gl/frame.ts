import { IDENTITY, type Camera } from '../camera.js'
import type { Point } from '../geometry.js'
import {
  BACKDROP,
  isLinear,
  type ArcMark,
  type BakedMark,
  type ContourMark,
  type GrainMark,
  type Mark,
  type Paint,
  type RibbonMark,
  type StrokeMark,
  type WashMark,
} from '../marks/index.js'
import type { Ink } from '../palette.js'
import { Batch, type Colour, type Run, Runs } from './batch.js'
import {
  arcPoints,
  boundsOf,
  box,
  falloff,
  fanForStencil,
  LINEAR_FALLOFF,
  paintAt,
  polyline,
  rgba,
  SQUARED_FALLOFF,
  zip,
} from './tessellate.js'

/**
 * THE EXECUTOR'S FIRST HALF — the display list turned into triangles, and not one
 * line of it touching a GPU.
 *
 * `paint.ts` was one function that walked the marks and issued canvas calls, and
 * ADR-0006 booked the cost of that honestly: jsdom has no 2D context, so the
 * whole draw path was unreachable under test and #244 named `node-canvas` as the
 * way back. ADR-0021 spends that escape hatch — jsdom has no WebGL either, and a
 * GL painter has no `node-canvas`.
 *
 * This is what is bought back with the money. The painter is cut in two at the
 * seam the GPU actually sits on: **everything above it is arithmetic over plain
 * arrays** (this file), and everything below it is `bufferData` and `drawArrays`
 * (`painter.ts`). The half that decides what the picture *is* — where a ribbon's
 * triangles land, which rings share a stencil pass, what colour a vertex carries,
 * how many draw calls the frame costs — now runs in the suite, at full fidelity,
 * with nothing stubbed. The 2D painter could never assert any of that.
 *
 * The order is the display list's order, exactly. See {@link Runs}.
 */

export interface PanelView {
  /** The panel in CSS px. Not the world — the world is what the camera moves. */
  width: number
  height: number
  camera?: Camera
  /**
   * The clear colour — the ground the network hangs in, from the frame's own
   * palette. Optional and defaulting to the dark BACKDROP so every existing
   * caller (and every dark frame) is byte-identical; the light theme is what
   * needed the seam, because a hardcoded void under a paper page was the one
   * colour the theme could not reach (#551's wave).
   */
  ground?: Ink
  /**
   * How light-material marks (glow, motes) composite. `'add'` — the default,
   * and the only mode any dark frame has ever used — is additive ONE,ONE:
   * light accumulates on the void, which is what emission looks like. On
   * paper the same arithmetic is invisible-to-wrong (adding light to a
   * near-white ground saturates immediately), so the light theme asks for
   * `'cover'`: the same marks composite source-over, reading as soft ink
   * washes — presence, not emission. This is the recorded answer to prd-33's
   * open question about ambient material on light ground.
   */
  lightBlend?: 'add' | 'cover'
}

/**
 * One chrome layer standing between a mark and the eye, for {@link veilOf}.
 *
 * Type and glyphs go on a 2D canvas layered **over** the GL canvas (ADR-0021's
 * first "Bad"), so anything the GL canvas draws after them — the depth fog, the
 * vignette, the grain — cannot dim them the way `ctx.fill` did when both lived on
 * one surface. Rather than accept a label that escapes the fog, the layers are
 * carried here and folded into the overlay mark's own ink. See {@link veilOf} for
 * why that is exact rather than an approximation.
 */
export type VeilLayer =
  | { kind: 'wash'; centre: Point; from: number; to: number; inner: Ink; outer: Ink }
  | { kind: 'grain'; ink: Ink }

export interface OverlayItem {
  mark: Mark
  /** Through the camera, or at device scale — the two passes `paint` always had. */
  world: boolean
  /** The chrome drawn *after* this mark, which is what dims it. Often empty. */
  veil: readonly VeilLayer[]
}

export interface GlFrame {
  vertices: Batch
  runs: readonly Run[]
  overlay: readonly OverlayItem[]
  /** The panel's floor, premultiplied, ready for `clearColor`. */
  backdrop: Colour
  /** How many `drawArrays` calls the run list costs. Reported, and asserted in tests. */
  drawCalls: number
}

/**
 * What the camera does not move (`paint.ts`'s own `isChrome`, unchanged): the
 * scene's voice in the gutter, and the panel's own depth.
 */
function isChrome(mark: Mark): boolean {
  return mark.role === 'gap' || mark.kind === 'wash' || mark.kind === 'grain'
}

/**
 * Light adds, ink covers — and a drift of motes is light. `paint.ts`'s rule,
 * plus the one ROLE that is light material in ribbon form: the subsurface
 * underglow (maximum quality), which must add on the void exactly as a glow
 * does or it would read as paint smeared under the thread.
 */
export function isLight(mark: Mark): boolean {
  // The one motes mark that is INK, not light: the engraved stipple (Plate
  // stage 1). Additive compositing can only lighten, so a dark dot on paper
  // would vanish - which is precisely how this exception was found.
  if (mark.role === 'mass-stipple') return false
  return mark.kind === 'glow' || mark.kind === 'motes' || mark.role === 'underglow'
}

function isOverlay(mark: Mark): boolean {
  return mark.kind === 'text' || mark.kind === 'path' || mark.kind === 'chip'
}

/**
 * ONE TESSELLATION PER MARK, WHILE ITS CONTENT DOESN'T MOVE — #178's
 * discipline one stage later (prd-44 ruling 5). `layoutScene`'s cache makes a
 * settled retired lane's `path`/`filaments` a byte-stable value; this is
 * where that fact is spent, at the ONE place it still cost something:
 * `draw()`'s trip through `polyline`/`falloff`/`zip`/`fanForStencil`.
 *
 * Keyed per MARK, not per lane: `sceneMarks` visits every lane once per pass
 * (thread, off-fence, light, looping, node, label), so one lane's marks are
 * scattered across the array rather than contiguous, and any one of them may
 * sit next to a live neighbour that is still moving. A per-mark slot handles
 * that for free — each mark decides for itself, in the order the walk visits
 * it, which is also the order `Runs`' run-merging needs.
 *
 * One slot per `(laneId, role, ordinal-this-frame)`, holding the content
 * digest it was last built from and what that build produced. A live mark's
 * digest changes every frame it actually moves, which drops the slot's old
 * value rather than keeping both — this cache cannot grow with time, only
 * with the number of distinct (laneId, role) pairs the session has ever
 * produced, the same bound `livingSpineCache` already accepts.
 *
 * Camera and panel size are deliberately absent from the key: nothing below
 * this comment ever reads `panel.width`, `panel.height` or `panel.camera` for
 * a world mark (see the doc comment on `buildFrame`), so neither can move a
 * cached mark's bytes, and a resize is caught one stage up, in
 * `layoutScene`'s own `world`-keyed cache — see
 * docs/design-notes/geometry-cache-audit-178.md.
 *
 * **Measured before landing** (issue #32's own condition): at 30 live + 200
 * retired, a full `digestMark` string built and compared for every mark,
 * every frame, cost MORE than the tessellation it was meant to avoid — a
 * measured 2.34x *regression* on an interleaved before/after, not a saving.
 * `contentArrays`/`sameArrays` below are the plan's own documented fallback
 * (§6): a reference check on each kind's one large array (`outline`/`rings`/
 * `items`/`paths`/`points`) first, which is exactly the field a settled
 * lane's `ribbonOutline`/retired-spine cache already holds stable across
 * frames (docs/design-notes/geometry-cache-audit-178.md), so a genuinely
 * unmoving mark skips the O(n) digest walk *and* its string comparison
 * entirely. The full digest in `known.digest` is still the fallback verifier
 * whenever that reference check is inconclusive (a fresh mark object with
 * unchanged values but a new array — `sceneMarks` does this routinely), so
 * the "never a false hit" contract §2 states is unchanged: the array check
 * can only produce a false miss (falls through to the full digest, same as
 * always), never a false hit on genuinely different content.
 */
const markTessellationCache = new Map<string, CacheEntry>()

interface CacheEntry {
  /** This mark's own large content array(s), by reference. Empty for a kind
   * with none (`glow`, `arc`) — {@link contentArrays} — which is also why
   * the fast path below requires a non-empty array before trusting it: an
   * always-empty pair would otherwise read as "always equal" for those two
   * kinds regardless of their (small, scalar) fields actually changing. */
  arrays: readonly unknown[]
  additive: boolean
  kind: Mark['kind']
  /** The full value-faithful digest — the fallback verifier, computed only
   * when the reference check above is inconclusive. */
  digest: string
  built: BuiltMark
}

const EMPTY_ARRAYS: readonly unknown[] = []

/**
 * The one (or two) large arrays a mark's own tessellation reads — the same
 * fields `digestMark` below walks point-by-point, named here instead so a
 * reference match can skip that walk entirely. `contour`'s `shells` is
 * included because a mass with shells changes what `stencil()` draws even
 * though `rings` alone stayed put.
 */
function contentArrays(mark: Mark): readonly unknown[] {
  switch (mark.kind) {
    case 'ribbon':
      return [mark.outline]
    case 'contour':
      return [mark.rings, mark.shells]
    case 'motes':
      return [mark.items]
    case 'baked':
      return [mark.paths]
    case 'stroke':
      return [mark.points]
    default:
      return EMPTY_ARRAYS
  }
}

function sameArrays(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** One scratch pair, reused for every cache-miss tessellation this session —
 * never allocated per mark, per frame. `buildFrame` is called once per
 * animation frame from one thread; nothing here is reentrant. */
const scratch = new Batch()

interface BuiltMark {
  runs: readonly LocalRun[]
  pos: Float32Array
  col: Float32Array
  fall: Float32Array
  count: number
}

/** A run, as `draw()` left it, before it is rebased onto the real stream. */
type LocalRun =
  | { kind: 'tris'; start: number; additive: boolean; world: boolean }
  | {
      kind: 'stencil'
      fillStart: number
      fillCount: number
      coverStart: number
      coverCount: number
      additive: boolean
      world: boolean
    }

/**
 * THE WHOLE FRAME, as triangles and ranges. Pure: same marks in, byte-identical
 * arrays out, on any machine and with no canvas anywhere.
 *
 * Not stateless any more: a per-mark tessellation cache persists across calls
 * (see `markTessellationCache` above), but it changes nothing this contract
 * promises — a cache hit is required to be byte-identical to what a miss
 * would have produced, and `frame.test.ts`'s tests hold that.
 */
export function buildFrame(marks: readonly Mark[], panel: PanelView, into?: Batch): GlFrame {
  const vertices = into ?? new Batch()
  vertices.reset()
  const runs = new Runs()
  const overlay: { mark: Mark; world: boolean; from: number }[] = []
  const layers: VeilLayer[] = []

  const world: Mark[] = []
  const chrome: Mark[] = []
  for (const mark of marks) (isChrome(mark) ? chrome : world).push(mark)

  const slotOrdinal = new Map<string, number>()
  for (const mark of world) {
    if (isOverlay(mark)) {
      overlay.push({ mark, world: true, from: 0 })
      continue
    }
    const additive = isLight(mark) && panel.lightBlend !== 'cover'
    const prefix = `${mark.laneId ?? ''}|${mark.role}`
    const ordinal = slotOrdinal.get(prefix) ?? 0
    slotOrdinal.set(prefix, ordinal + 1)
    const slotKey = `${prefix}|${ordinal}`
    const known = markTessellationCache.get(slotKey)
    const arrays = contentArrays(mark)
    const fastHit =
      known !== undefined &&
      arrays.length > 0 &&
      known.kind === mark.kind &&
      known.additive === additive &&
      sameArrays(known.arrays, arrays)
    let built: BuiltMark
    if (fastHit && known !== undefined) {
      built = known.built
    } else {
      const digest = digestMark(mark, additive)
      built =
        known !== undefined && known.digest === digest
          ? known.built
          : tessellateMark(mark, true, additive)
      markTessellationCache.set(slotKey, { arrays, additive, kind: mark.kind, digest, built })
    }
    spliceBuilt(vertices, runs, built)
  }

  for (const mark of chrome) {
    if (isOverlay(mark)) {
      // Everything already laid down is *under* this mark and does not dim it;
      // what comes after does. The gap voice is last in the list, which is how
      // "a caveat is never dimmed by the fog laid over the picture it is about"
      // survives the move to a layered canvas without being restated as a rule.
      overlay.push({ mark, world: false, from: layers.length })
      continue
    }
    if (mark.kind === 'wash') {
      const run = washRun(mark)
      if (run !== null) {
        runs.push(run, vertices.n)
        layers.push({
          kind: 'wash',
          centre: run.centre,
          from: run.from,
          to: run.to,
          inner: run.inner,
          outer: run.outer,
        })
      }
      continue
    }
    if (mark.kind === 'grain') {
      const run = grainRun(mark)
      if (run !== null) {
        runs.push(run, vertices.n)
        layers.push({ kind: 'grain', ink: mark.ink })
      }
      continue
    }
    draw(vertices, runs, mark, false, isLight(mark) && panel.lightBlend !== 'cover')
  }

  const list = runs.done(vertices.n)
  return {
    vertices,
    runs: list,
    overlay: overlay.map((item) => ({
      mark: item.mark,
      world: item.world,
      veil: layers.slice(item.from),
    })),
    backdrop: premultiply(rgba(panel.ground ?? BACKDROP)),
    drawCalls: list.reduce((total, run) => total + (run.kind === 'stencil' ? 2 : 1), 0),
  }
}

/**
 * Runs `draw()` for exactly one mark into the shared scratch pair and hands
 * back what it produced, offsets still local to that one mark (0-based) so
 * the caller can rebase them onto wherever the real stream currently ends.
 * This is the miss path — the same `draw()` the live path always called,
 * just aimed at a throwaway buffer first so the result can be kept.
 */
function tessellateMark(mark: Mark, world: boolean, additive: boolean): BuiltMark {
  scratch.reset()
  const scratchRuns = new Runs()
  draw(scratch, scratchRuns, mark, world, additive)
  const runs: LocalRun[] = scratchRuns.done(scratch.n).map((run): LocalRun => {
    if (run.kind === 'tris') {
      return { kind: 'tris', start: run.start, additive: run.additive, world: run.world }
    }
    if (run.kind === 'stencil') {
      return {
        kind: 'stencil',
        fillStart: run.fillStart,
        fillCount: run.fillCount,
        coverStart: run.coverStart,
        coverCount: run.coverCount,
        additive: run.additive,
        world: run.world,
      }
    }
    // A single mark's own draw() call can only ever open `tris` or `stencil`
    // runs — `wash`/`grain` are chrome-only and never reach `draw()`.
    throw new Error(`unreachable: a mark produced a ${run.kind} run`)
  })
  return {
    runs,
    pos: scratch.pos.slice(0, scratch.n * 2),
    col: scratch.col.slice(0, scratch.n * 4),
    fall: scratch.fall.slice(0, scratch.n * 4),
    count: scratch.n,
  }
}

/**
 * Replays a built mark (fresh or cached — the two are indistinguishable from
 * here) into the real stream: the vertex bytes are appended as one block, and
 * each local run is rebased onto wherever that block landed, then issued
 * through the SAME `Runs` calls the live path always used — `openTriangles`
 * for a `tris` run (so it still merges with whatever is already open, exactly
 * as it would if `draw()` had been called directly), `push` for a `stencil`
 * run (so it still seals whatever was open, exactly as `stencil()` does).
 */
function spliceBuilt(vertices: Batch, runs: Runs, built: BuiltMark): void {
  const base = vertices.n
  vertices.appendRaw(built.pos, built.col, built.fall, built.count)
  for (const run of built.runs) {
    if (run.kind === 'tris') {
      runs.openTriangles(base + run.start, run.additive, run.world)
      continue
    }
    // Close whatever was open BEFORE this stencil's own fill/cover vertices —
    // at the position where they BEGIN, exactly as the live `stencil()`'s own
    // `runs.seal(vertices.n)` does it before appending a single one of its
    // vertices (frame.ts's `stencil`, above). `push`'s own `at` argument seals
    // too, but only at this stencil's END, which is a no-op live (nothing is
    // ever left open there) — replaying without this explicit early seal would
    // let a still-open prior run swallow this stencil's fans and cover box and
    // report their count as its own, exactly the bug that comment warns about.
    runs.seal(base + run.fillStart)
    runs.push(
      {
        kind: 'stencil',
        fillStart: base + run.fillStart,
        fillCount: run.fillCount,
        coverStart: base + run.coverStart,
        coverCount: run.coverCount,
        additive: run.additive,
        world: run.world,
      },
      base + run.coverStart + run.coverCount,
    )
  }
}

/**
 * The content this mark's OWN tessellation reads, and nothing else — listing
 * only the fields the matching branch of `draw()` (below) actually consumes,
 * cross-checked against `ribbon`/`contour`/`stencil`/`baked`/`strokeMark`/
 * `arcMark` at the point this was written. If a future change to one of those
 * functions starts reading a field this digest does not list, this cache will
 * silently keep serving the OLD value for that field forever — this function
 * and those it digests must be kept in the same edit.
 *
 * Deliberately not `JSON.stringify(mark)`: a mark here can carry a few
 * hundred numbers, and plain template joins over them are cheaper than full
 * JSON escaping for the same content, which matters at 200+ retired lanes'
 * worth of marks every frame.
 */
function digestMark(mark: Mark, additive: boolean): string {
  const pt = (p: Point): string => `${p.x},${p.y}`
  const ring = (r: readonly Point[]): string => r.map(pt).join(';')
  const ink = (i: Ink): string => `${i.rgb[0]},${i.rgb[1]},${i.rgb[2]},${i.alpha}`
  const paint = (p: Paint): string =>
    isLinear(p)
      ? `L${pt(p.from)}>${pt(p.to)}:${p.stops.map((s) => `${s.at}=${ink(s.ink)}`).join(',')}`
      : ink(p)

  switch (mark.kind) {
    case 'ribbon':
      return `ribbon|${mark.outline.map(ring).join('|')}|${mark.widthRoot}|${mark.widthTip}|${paint(mark.paint)}|${additive}`
    case 'contour':
      return `contour|${mark.rings.map(ring).join('|')}|${ink(mark.fill)}|${
        mark.edge === undefined ? '' : `${mark.edge.width},${ink(mark.edge.ink)}`
      }|${(mark.shells ?? []).map((s) => `${s.rings.map(ring).join(';')}:${ink(s.ink)}`).join('|')}|${additive}`
    case 'glow':
      return `glow|${pt(mark.at)}|${mark.radius}|${ink(mark.ink)}|${additive}`
    case 'motes':
      return `motes|${mark.items.map((m) => `${pt(m.at)}:${m.radius}:${ink(m.ink)}`).join(';')}|${additive}`
    case 'baked':
      return `baked|${pt(mark.at)}|${mark.scale}|${mark.scaleY ?? ''}|${mark.paths
        .map(ring)
        .join('|')}|${mark.closed}|${ink(mark.ink)}|${mark.width}|${additive}`
    case 'stroke':
      return `stroke|${mark.points.map(pt).join(';')}|${mark.width}|${ink(mark.ink)}|${
        mark.dash ?? ''
      }|${mark.closed ?? false}|${additive}`
    case 'arc':
      return `arc|${pt(mark.at)}|${mark.radius}|${mark.from}|${mark.to}|${mark.width}|${ink(
        mark.ink,
      )}|${mark.dash ?? ''}|${additive}`
    default:
      // Reachable only if a future mark kind starts arriving here without
      // this function being taught its fields — `digestMark`'s parameter is
      // the full `Mark` union (`text`/`path`/`chip` are filtered by
      // `isOverlay` and `wash`/`grain` by `isChrome` before a mark ever
      // reaches this function, but nothing in the type system states that,
      // so TypeScript still sees this branch as reachable and a `never`
      // assignment here would not typecheck). Failing loudly beats silently
      // caching a mark this function never learned to read.
      throw new Error(`digestMark: unexpected mark kind '${mark.kind}'`)
  }
}

/**
 * THE ACCUMULATED CHROME over a point, as the two numbers that make folding it
 * into an ink **exact** rather than a fudge.
 *
 * Canvas draws the label, then the fog over it, then the vignette over that:
 *
 *     final = ((base·(1−t) + T·t)·(1−f) + F·f)·(1−v) + V·v
 *
 * The layered painter draws the fog and the vignette first and the label last:
 *
 *     final′ = (veiled base)·(1−t) + T′·t
 *
 * Expand both and the difference collapses to a single substitution: with the
 * same alpha `t`, the two agree everywhere iff `T′ = T·k + c`, where `k` is the
 * light the chrome lets through (`Π(1−aᵢ)`) and `c` is the light it adds
 * (`Σ Cᵢaᵢ·Π_{j>i}(1−aⱼ)`) — which is exactly the chrome stack composited over
 * nothing. So this returns that composite, and the overlay applies it per mark.
 *
 * Per *mark*, not per pixel, which is the one approximation: a wash changes by
 * about 0.4% of its span across a 40 px label. Below anything anyone can see, and
 * it costs one square root per label instead of a second full-screen fill.
 */
export function veilOf(layers: readonly VeilLayer[], at: Point, panel: PanelView): Veil {
  let pre: [number, number, number] = [0, 0, 0]
  let alpha = 0

  for (const layer of layers) {
    const [colour, a] = layer.kind === 'grain' ? grainAt(layer.ink) : washAt(layer, at, panel)
    if (a <= 0) continue
    // Premultiplied source-over, this layer over everything under it.
    pre = [
      colour[0] * a + pre[0] * (1 - a),
      colour[1] * a + pre[1] * (1 - a),
      colour[2] * a + pre[2] * (1 - a),
    ]
    alpha = a + alpha * (1 - a)
  }

  return { transmit: 1 - alpha, add: pre }
}

/** `ink · transmit + add`, per channel, in 0–255. See {@link veilOf}. */
export interface Veil {
  transmit: number
  add: readonly [number, number, number]
}

export function veiled(ink: Ink, veil: Veil): Ink {
  if (veil.transmit >= 1) return ink
  return {
    rgb: [
      clampByte(ink.rgb[0] * veil.transmit + veil.add[0]),
      clampByte(ink.rgb[1] * veil.transmit + veil.add[1]),
      clampByte(ink.rgb[2] * veil.transmit + veil.add[2]),
    ],
    alpha: ink.alpha,
  }
}

/**
 * A wash's colour and alpha at a point.
 *
 * Interpolated **premultiplied**, which is what a `CanvasGradient` does, so the
 * two agree even where a stop's alpha is zero and its colour is therefore
 * meaningless. Both of the scene's washes happen to fade a colour into itself, so
 * this is parity insurance rather than a visible difference today.
 */
function washAt(
  layer: Extract<VeilLayer, { kind: 'wash' }>,
  at: Point,
  panel: PanelView,
): [readonly [number, number, number], number] {
  const half = Math.hypot(panel.width / 2, panel.height / 2)
  const r0 = half * layer.from
  const r1 = half * layer.to
  const r = Math.hypot(at.x - layer.centre.x, at.y - layer.centre.y)
  const t = r1 <= r0 ? 1 : clamp01((r - r0) / (r1 - r0))

  const alpha = layer.inner.alpha + (layer.outer.alpha - layer.inner.alpha) * t
  if (alpha <= 0) return [[0, 0, 0], 0]
  const channel = (i: 0 | 1 | 2): number => {
    const a = layer.inner.rgb[i] * layer.inner.alpha
    const b = layer.outer.rgb[i] * layer.outer.alpha
    return (a + (b - a) * t) / alpha
  }
  return [[channel(0), channel(1), channel(2)], alpha]
}

/**
 * The grain's *mean* coverage, which is the one place a per-pixel texture has to
 * be answered with a number. The tile's alphas are the top byte of an xorshift
 * walk, uniform over 0–255, so a glyph 40 px wide sees the mean and nothing else:
 * half of the mark's own alpha, i.e. 0.8% at the shipping `GRAIN.alpha`.
 */
function grainAt(ink: Ink): [readonly [number, number, number], number] {
  return [[ink.rgb[0], ink.rgb[1], ink.rgb[2]], ink.alpha * 0.5]
}

function draw(
  vertices: Batch,
  runs: Runs,
  mark: Mark,
  world: boolean,
  additive: boolean,
): void {
  switch (mark.kind) {
    case 'ribbon':
      ribbon(vertices, runs, mark, world, additive)
      return
    case 'contour':
      contour(vertices, runs, mark, world, additive)
      return
    case 'glow':
      if (mark.radius <= 0.1) return
      runs.openTriangles(vertices.n, additive, world)
      falloff(vertices, mark.at, mark.radius, rgba(mark.ink), LINEAR_FALLOFF)
      return
    case 'motes': {
      let opened = false
      for (const mote of mark.items) {
        if (mote.radius <= 0.1 || mote.ink.alpha <= 0.002) continue
        if (!opened) {
          runs.openTriangles(vertices.n, additive, world)
          opened = true
        }
        falloff(vertices, mote.at, mote.radius, rgba(mote.ink), SQUARED_FALLOFF)
      }
      return
    }
    case 'baked':
      baked(vertices, runs, mark, world, additive)
      return
    case 'stroke':
      strokeMark(vertices, runs, mark, world, additive)
      return
    case 'arc':
      arcMark(vertices, runs, mark, world, additive)
      return
    default:
      return
  }
}

/**
 * A ribbon: the polygons `ribbon.ts` built, filled — **not** a strip re-derived
 * from the spine.
 *
 * The distinction is the encoding's, not the painter's. `outline` is already
 * split at every pinch and every dash gap, so a frozen lane's thread arrives here
 * as two lobes meeting at a point; a strip rebuilt from `widthRoot`/`widthTip`
 * would have drawn one continuous healthy thread and the severing would have been
 * invisible. Each polygon is zipped independently, for the same reason `paint.ts`
 * gave each one its own `fill()`: two lobes in one path interact through the
 * winding rule.
 *
 * The zero-width case is the organic enclosure (`regionMark`), where the outline
 * *is* the shape and there is no spine to zip against — a closed ring, filled, and
 * therefore stencilled like a contour rather than assumed star-shaped.
 */
function ribbon(
  vertices: Batch,
  runs: Runs,
  mark: RibbonMark,
  world: boolean,
  additive: boolean,
): void {
  if (mark.outline.length === 0) return

  if (mark.widthRoot === 0 && mark.widthTip === 0) {
    for (const ring of mark.outline) {
      stencil(vertices, runs, [ring], paintAt(mark.paint, centroid(ring)), world, additive)
    }
    return
  }

  runs.openTriangles(vertices.n, additive, world)
  for (const polygon of mark.outline) zip(vertices, polygon, mark.paint)
}

/**
 * An iso-contour: every ring of a level in **one** even-odd region, exactly as
 * `paint.ts` filled it — a ring inside a ring is a hole, not a second lobe.
 *
 * The rim is stroked over the same rings rather than a rebuilt set, so it can
 * never disagree with the edge it is supposed to be on; the shells are the same
 * call again, one level of the field deeper each time.
 */
function contour(
  vertices: Batch,
  runs: Runs,
  mark: ContourMark,
  world: boolean,
  additive: boolean,
): void {
  stencil(vertices, runs, mark.rings, rgba(mark.fill), world, additive)

  if (mark.edge !== undefined) {
    const colour = rgba(mark.edge.ink)
    runs.openTriangles(vertices.n, additive, world)
    for (const ring of mark.rings) {
      if (ring.length >= 3) polyline(vertices, ring, mark.edge.width, colour, true)
    }
  }

  for (const shell of mark.shells ?? []) {
    stencil(vertices, runs, shell.rings, rgba(shell.ink), world, additive)
  }
}

/** One even-odd region: the rings into the stencil, the box over the result. */
function stencil(
  vertices: Batch,
  runs: Runs,
  rings: readonly (readonly Point[])[],
  colour: Colour,
  world: boolean,
  additive: boolean,
): void {
  const bounds = boundsOf(rings)
  if (bounds === null) return

  // Close whatever was being appended **before** a single stencil vertex lands in
  // the stream. An open run is sealed at the stream's length, so a run still open
  // here would swallow the fans and the cover box and draw them as ordinary
  // triangles — which paints every contour's bounding rectangle over the picture.
  // Caught by the parity capture (a faint square around the root-mass) rather
  // than by anything that could have been reasoned about.
  runs.seal(vertices.n)

  const fillStart = vertices.n
  for (const ring of rings) fanForStencil(vertices, ring)
  const fillCount = vertices.n - fillStart
  if (fillCount === 0) return

  const coverStart = vertices.n
  box(vertices, bounds, colour)
  runs.push(
    {
      kind: 'stencil',
      fillStart,
      fillCount,
      coverStart,
      coverCount: vertices.n - coverStart,
      additive,
      world,
    },
    vertices.n,
  )
}

/**
 * BAKED GEOMETRY, PLACED (prd10 ruling 3) — the heart's rings and its hyphal fan.
 *
 * `paint.ts` keeps a `Path2D` per bake and redraws it through a `translate`/
 * `scale`; here the placement is the same two multiplies done on the vertices, so
 * the cache the 2D painter needed does not exist and cannot go stale. The width
 * is already in world px, which is what the 2D painter's division by the scale
 * was reconstructing.
 */
function baked(
  vertices: Batch,
  runs: Runs,
  mark: BakedMark,
  world: boolean,
  additive: boolean,
): void {
  if (mark.paths.length === 0 || mark.scale <= 0) return
  const scaleY = mark.scaleY ?? mark.scale
  const colour = rgba(mark.ink)

  for (const unit of mark.paths) {
    if (unit.length < 2) continue
    const placed = unit.map((point) => ({
      x: mark.at.x + point.x * mark.scale,
      y: mark.at.y + point.y * scaleY,
    }))
    if (mark.width <= 0) {
      stencil(vertices, runs, [placed], colour, world, additive)
      continue
    }
    runs.openTriangles(vertices.n, additive, world)
    polyline(vertices, placed, mark.width, colour, mark.closed)
  }
}

function strokeMark(
  vertices: Batch,
  runs: Runs,
  mark: StrokeMark,
  world: boolean,
  additive: boolean,
): void {
  if (mark.points.length < 2) return
  runs.openTriangles(vertices.n, additive, world)
  const colour = rgba(mark.ink)
  const closed = mark.closed === true
  if (mark.dash === undefined) {
    polyline(vertices, mark.points, mark.width, colour, closed)
    return
  }
  for (const run of dashRuns(mark.points, mark.dash, closed)) {
    polyline(vertices, run, mark.width, colour, false)
  }
}

function arcMark(
  vertices: Batch,
  runs: Runs,
  mark: ArcMark,
  world: boolean,
  additive: boolean,
): void {
  if (mark.radius <= 0) return
  runs.openTriangles(vertices.n, additive, world)
  const points = arcPoints(mark.at, mark.radius, mark.from, mark.to)
  const colour = rgba(mark.ink)
  if (mark.dash === undefined) {
    polyline(vertices, points, mark.width, colour, false)
    return
  }
  for (const run of dashRuns(points, mark.dash, false)) {
    polyline(vertices, run, mark.width, colour, false)
  }
}

/**
 * `setLineDash`, walked by hand.
 *
 * Canvas gets it from the platform and the GPU does not, so the on/off pattern is
 * spent along the polyline's own arc length here — the same place a rasteriser
 * spends it, and the same result: a boundary that is drawn as a broken line
 * because it is a fence rather than a wall.
 */
export function dashRuns(
  points: readonly Point[],
  dash: readonly [number, number],
  closed: boolean,
): Point[][] {
  const [on, off] = dash
  if (!(on > 0) || !(off > 0)) return [[...points]]

  const period = on + off
  const out: Point[][] = []
  let current: Point[] | null = null
  let walked = 0
  const segments = closed ? points.length : points.length - 1

  const between = (a: Point, b: Point, t: number): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  })

  for (let i = 0; i < segments; i += 1) {
    const a = points[i] as Point
    const b = points[(i + 1) % points.length] as Point
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) continue

    let travelled = 0
    while (travelled < length - EPSILON) {
      const phase = (walked + travelled) % period
      const lit = phase < on
      const untilFlip = lit ? on - phase : period - phase
      const step = Math.min(untilFlip, length - travelled)
      if (lit) {
        if (current === null) current = [between(a, b, travelled / length)]
        current.push(between(a, b, (travelled + step) / length))
        if (step >= untilFlip - EPSILON) {
          if (current.length > 1) out.push(current)
          current = null
        }
      }
      travelled += step
    }
    walked += length
  }

  if (current !== null && current.length > 1) out.push(current)
  return out
}

const EPSILON = 1e-9

function washRun(mark: WashMark): Extract<Run, { kind: 'wash' }> | null {
  if (mark.width <= 0 || mark.height <= 0) return null
  return {
    kind: 'wash',
    centre: { x: mark.width / 2, y: mark.height / 2 },
    from: mark.from,
    to: mark.to,
    inner: mark.inner,
    outer: mark.outer,
    width: mark.width,
    height: mark.height,
  }
}

function grainRun(mark: GrainMark): Extract<Run, { kind: 'grain' }> | null {
  if (mark.width <= 0 || mark.height <= 0 || mark.ink.alpha <= 0.002) return null
  if (!(mark.tile > 0)) return null
  return {
    kind: 'grain',
    tile: mark.tile,
    // `paint.ts`'s own offsets: the tile crawls one step per tick on x and seven
    // on y, so the texture never reads as a grid sliding sideways.
    shift: { x: mark.tick % mark.tile, y: (mark.tick * 7) % mark.tile },
    ink: mark.ink,
    width: mark.width,
    height: mark.height,
  }
}

/** Where a region's flat paint is sampled. Only meaningful for a `linear` paint. */
function centroid(ring: readonly Point[]): Point {
  let x = 0
  let y = 0
  for (const point of ring) {
    x += point.x
    y += point.y
  }
  return { x: x / ring.length, y: y / ring.length }
}

export function premultiply(colour: Colour): Colour {
  return [colour[0] * colour[3], colour[1] * colour[3], colour[2] * colour[3], colour[3]]
}

/** Where a world point lands on the panel — the camera, as the overlay needs it. */
export function toScreen(at: Point, camera: Camera = IDENTITY): Point {
  return { x: at.x * camera.k + camera.x, y: at.y * camera.k + camera.y }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function clampByte(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : value
}
