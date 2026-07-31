/**
 * The stroke engine behind the sigil alphabet.
 *
 * Ruling 23 asks for cyber-sigilism: sharp *tapered* strokes with thorn-curl
 * terminals. An SVG stroke is uniform-width, so every mark in `sigils.tsx` is
 * instead a filled polygon built from a centre-line plus a width ramp — one
 * vocabulary, one helper, and marks that keep their character when scaled.
 *
 * Everything here works in a **unit square** (0–1 on both axes) and is scaled
 * once at render time. That is what lets the same code draw the scene's 64px
 * node sigil and the fleet table's 15px row glyph: widths are fractions of the
 * glyph, so a stroke that reads as confident at scene scale is still 1.2px —
 * and still tapered — in a table row (graft g1).
 */

export interface Pt {
  x: number
  y: number
}

/** Two decimals is plenty at any size we draw, and keeps path data diffable. */
function n(value: number): string {
  return Number.isFinite(value) ? Number(value.toFixed(3)).toString() : '0'
}

export function polar(cx: number, cy: number, r: number, angle: number): Pt {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
}

/** Straight centre-line, sampled so {@link taper} has something to ramp along. */
export function segment(from: Pt, to: Pt, steps = 12): Pt[] {
  const points: Pt[] = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
  }
  return points
}

/** Sampled arc or spiral: radius and angle both interpolate. */
export function spiral(
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  steps = 48,
): Pt[] {
  const points: Pt[] = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    points.push(polar(cx, cy, r0 + (r1 - r0) * t, a0 + (a1 - a0) * t))
  }
  return points
}

/**
 * A tapered ribbon along `points`, `w0` wide at the head and `w1` at the tail.
 * The default quadratic ramp keeps a stroke confident for most of its length
 * and then lets go quickly — the shape that reads as "drawn with a nib" rather
 * than "scaled down".
 */
export function taper(
  points: readonly Pt[],
  w0: number,
  w1: number,
  ease: (t: number) => number = (t) => t * t,
): string {
  if (points.length < 2) return ''

  const left: Pt[] = []
  const right: Pt[] = []

  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)] as Pt
    const next = points[Math.min(points.length - 1, i + 1)] as Pt
    const dx = next.x - previous.x
    const dy = next.y - previous.y
    const length = Math.hypot(dx, dy) || 1
    const half = (w0 + (w1 - w0) * ease(i / (points.length - 1))) / 2
    const point = points[i] as Pt
    left.push({ x: point.x + (-dy / length) * half, y: point.y + (dx / length) * half })
    right.push({ x: point.x - (-dy / length) * half, y: point.y - (dx / length) * half })
  }

  const head = left.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(p.x)} ${n(p.y)}`).join('')
  const tail = right
    .slice()
    .reverse()
    .map((p) => `L${n(p.x)} ${n(p.y)}`)
    .join('')
  return `${head}${tail}Z`
}

/**
 * A thorn-curl terminal: the stroke's last gesture, curling inward off the end
 * of `points`. This is the one flourish that makes the register read as
 * sigilist rather than as iconography, so it is a helper rather than a
 * hand-drawn path per mark.
 */
export function thorn(cx: number, cy: number, r: number, angle: number, sweep: number, width: number): string {
  return taper(spiral(cx, cy, r, r * 0.42, angle, angle + sweep, 14), width, 0)
}

/** Plain polyline, for hairlines that must stay hairline. */
export function line(points: readonly Pt[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${n(p.x)} ${n(p.y)}`).join('')
}

export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const from = polar(cx, cy, r, a0)
  const to = polar(cx, cy, r, a1)
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0
  const sweep = a1 > a0 ? 1 : 0
  return `M${n(from.x)} ${n(from.y)}A${n(r)} ${n(r)} 0 ${large} ${sweep} ${n(to.x)} ${n(to.y)}`
}
