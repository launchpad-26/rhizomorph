import { IDENTITY, type Camera } from '../camera.js'
import type { ChipMark, Mark, PathMark, TextMark } from '../marks/index.js'
import { cssColour, type Ink } from '../palette.js'
import { toScreen, veilOf, veiled, type GlFrame, type OverlayItem, type Veil } from './frame.js'
import type { Panel } from './painter.js'

/**
 * TYPE AND GLYPHS — a transparent 2D canvas, layered over the GL one.
 *
 * ADR-0021 named the choice and left it open: a font atlas, or the overlay every
 * real WebGL dashboard uses. **The overlay, and the reason is what it is made
 * of.** An atlas would have to carry `ui-sans-serif` and `ui-monospace` — two
 * *system* stacks, resolved by the browser to whatever the machine has — at every
 * size the scene draws, rebuilt on DPR change, and law 11's "tabular numerals"
 * clause is a property of the face rather than of the raster. Baking that into a
 * texture means either shipping a font (weight the repo removed `three` to avoid)
 * or rasterising the system one at runtime, which is the overlay again with extra
 * steps. The spike measured the overlay at 0.4 ms for 215 glyph paths a frame,
 * against a 16.67 ms budget; an atlas would buy back a fraction of that and cost
 * a font pipeline.
 *
 * **The compositing order, stated once so it is never in doubt:**
 *
 * 1. the GL canvas draws the world (through the camera) and then the chrome
 *    washes and the grain (at device scale);
 * 2. this canvas, on top and transparent, draws the world's type through the
 *    same camera and then the gap voice at device scale.
 *
 * Two surfaces means the chrome cannot dim what is above it, and the fog and the
 * vignette are exactly the chrome that used to dim labels. That is not accepted
 * as a delta — it is folded into each overlay mark's own ink by {@link veilOf},
 * which is exact wherever the wash is locally flat. The gap voice is *excluded*
 * from it, because canvas drew the gap voice after the fog too: law 12's caveat
 * was never dimmed and still is not.
 *
 * Three `setTransform` calls per frame, in the order `paint.ts` made them:
 * device scale, camera, device scale. Not an accident — the transform sequence is
 * the observable the camera suite reads a frame's camera off.
 */

export interface OverlayPainter {
  draw(frame: GlFrame, panel: Panel, camera: Camera): void
}

/** Cached by path data: the same glyph is drawn on every frame, at every node. */
const glyphCache = new Map<string, Path2D>()

/**
 * Law 11: sans for names, mono for every figure. Canvas has no
 * `font-variant-numeric`, so the law's "tabular numerals" clause is carried by
 * the choice of a monospaced face — in which every figure is the same width by
 * construction rather than by an opt-in feature the canvas cannot request.
 *
 * THE MIRROR (prd-32 ruling 1, #548). These two strings are `--font-sans` and
 * `--font-mono` from `theme/theme.css`, character for character, because
 * `ctx.font` takes a string and canvas cannot read a custom property. Before
 * #548's wave 1 they had already drifted: the sans stack did not name Inter at
 * all, and the mono stack listed JetBrains Mono *fourth*, behind `ui-monospace`
 * — so the scene would have gone on painting in the system faces even after the
 * DOM started using the real ones, and no test would have said so.
 * `palette.test.ts` holds this record to the tokens, which is the only thing
 * that keeps the scene and the panels around it one typeface.
 *
 * **Exported for that test and for no other reason.** It moved here from
 * `paint.ts` when #578 swapped the renderer, and the move is exactly where a
 * mirror dies quietly: a painter rewritten from the old file would have carried
 * the old, drifted stacks and re-introduced the regression #548 existed to fix,
 * with the mirror's import pointing at a file that no longer exists. Type is the
 * one thing the WebGL2 painter still draws through a 2D context, so this is
 * still the one place the stack is spelled out — keep the mirror pointed here.
 */
export const FONT: Record<TextMark['font'], string> = {
  sans: "'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
}

const ALIGN: Record<TextMark['align'], CanvasTextAlign> = {
  left: 'left',
  right: 'right',
  centre: 'center',
}

/** A 2D context over the overlay canvas, or `null` where there is none (jsdom). */
export function createOverlayPainter(canvas: HTMLCanvasElement): OverlayPainter | null {
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = canvas.getContext('2d')
  } catch {
    return null
  }
  if (ctx === null) return null
  const context = ctx

  return {
    draw(frame: GlFrame, panel: Panel, camera: Camera = IDENTITY): void {
      const dpr = panel.dpr
      const screen = (): void => context.setTransform(dpr, 0, 0, dpr, 0, 0)

      screen()
      context.clearRect(0, 0, panel.width, panel.height)

      const scale = dpr * camera.k
      context.setTransform(scale, 0, 0, scale, dpr * camera.x, dpr * camera.y)
      for (const item of frame.overlay) {
        if (item.world) drawItem(context, item, panel, camera)
      }

      screen()
      for (const item of frame.overlay) {
        if (!item.world) drawItem(context, item, panel, camera)
      }
    },
  }
}

function drawItem(
  ctx: CanvasRenderingContext2D,
  item: OverlayItem,
  panel: Panel,
  camera: Camera,
): void {
  const mark = item.mark
  const at = anchorOf(mark)
  const veil =
    item.veil.length === 0
      ? NO_VEIL
      : veilOf(item.veil, item.world ? toScreen(at, camera) : at, panel)

  if (mark.kind === 'text') text(ctx, mark, veil)
  else if (mark.kind === 'chip') chip(ctx, mark, veil)
  else if (mark.kind === 'path') glyph(ctx, mark, veil)
}

const NO_VEIL: Veil = { transmit: 1, add: [0, 0, 0] }

function anchorOf(mark: Mark): { x: number; y: number } {
  return 'at' in mark ? mark.at : { x: 0, y: 0 }
}

function tint(ink: Ink, veil: Veil): string {
  return cssColour(veiled(ink, veil))
}

function text(ctx: CanvasRenderingContext2D, mark: TextMark, veil: Veil): void {
  ctx.save()
  ctx.font = `${mark.weight} ${mark.size}px ${FONT[mark.font]}`
  ctx.textAlign = ALIGN[mark.align]
  ctx.textBaseline = 'middle'
  ctx.fillStyle = tint(mark.ink, veil)
  ctx.fillText(mark.text, mark.at.x, mark.at.y)
  ctx.restore()
}

/** The plate behind a spotlit label, so a name survives any background. */
function chip(ctx: CanvasRenderingContext2D, mark: ChipMark, veil: Veil): void {
  ctx.fillStyle = tint(mark.fill, veil)
  ctx.fillRect(mark.at.x, mark.at.y, mark.width, mark.height)
  ctx.lineWidth = 1
  ctx.strokeStyle = tint(mark.border, veil)
  ctx.strokeRect(mark.at.x, mark.at.y, mark.width, mark.height)
}

/**
 * A glyph from the sigil alphabet, authored in a unit square by `fleet/strokes`
 * and placed here. The same path data draws the fleet table's 15px row mark and
 * the scene's node sigil — one alphabet, one hand (graft g1).
 */
function glyph(ctx: CanvasRenderingContext2D, mark: PathMark, veil: Veil): void {
  let path = glyphCache.get(mark.d)
  if (path === undefined) {
    path = new Path2D(mark.d)
    glyphCache.set(mark.d, path)
  }

  ctx.save()
  ctx.translate(mark.at.x, mark.at.y)
  ctx.rotate(mark.rotate)
  ctx.scale(mark.size, mark.size * (mark.squash ?? 1))
  // Authored around (0.5, 0.5); placed by its centre.
  ctx.translate(-0.5, -0.5)

  if (mark.stroke === undefined) {
    ctx.fillStyle = tint(mark.ink, veil)
    ctx.fill(path)
  } else {
    // The transform is in glyph units, so a line width in pixels has to be
    // divided back out or a scaled-up mark would grow a scaled-up outline.
    ctx.lineWidth = mark.stroke / mark.size
    ctx.strokeStyle = tint(mark.ink, veil)
    ctx.stroke(path)
  }
  ctx.restore()
}
