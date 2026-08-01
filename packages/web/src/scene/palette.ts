/**
 * The scene's ink — the ice-neon register (ruling 29) as canvas numbers.
 *
 * Canvas cannot read a Tailwind class, so these are the one place in the
 * instrument where a theme token is repeated as a literal. `palette.test.ts`
 * parses `theme/theme.css` and asserts every constant here still equals its
 * token, so the mirror cannot drift silently.
 *
 * Two laws are carried by the numbers themselves:
 *
 * - **Status owns hue** (law 9). The calm world — root-mass, threads, filaments,
 *   labels, and every pulse — is built out of the ICE ramp alone: one cold
 *   blue-white hue at several luminances. The three saturated values below are
 *   ladder rungs and appear nowhere else.
 * - **Neon is luminance, not saturation** (ruling 29). "White-hot" for an
 *   expensive thread is therefore lawful: it is {@link ICE_050}, the ramp's
 *   ceiling, not a fifth hue. Nothing in this file reaches for `#ffffff` — the
 *   scene's white is the ice register's white, which is why a blown-out thread
 *   still belongs to the same world as the panel chrome around it.
 */

export type Rgb = readonly [number, number, number]

/** A colour and how much of it. Kept unstringified so brightness stays comparable. */
export interface Ink {
  readonly rgb: Rgb
  readonly alpha: number
}

// ── the ice ramp: the calm world ────────────────────────────────────────────

/** The void the network hangs in. */
export const ICE_1000: Rgb = [4, 6, 12]
/** The chip behind a spotlit label — the panel surface, borrowed. */
export const ICE_950: Rgb = [8, 11, 20]
/** A thread whose lane has drifted cold. The floor of the thread ramp. */
export const ICE_700: Rgb = [38, 51, 77]
/** Secondary label ink: the mono figure under a lane's name. */
export const ICE_400: Rgb = [106, 129, 168]
/** Primary data ink, and a fresh thread. The calm neon. */
export const ICE_200: Rgb = [179, 198, 222]
/** Peak luminance. Pulses, the root-mass core, a white-hot thread. */
export const ICE_050: Rgb = [240, 245, 252]

// ── the ladder: four hues, exclusive (law 9) ────────────────────────────────

/** NOTICE — something changed; nobody is needed. EXPENSIVE's chevrons only. */
export const NOTICE: Rgb = [77, 234, 255]
/** NEEDS-YOU — a human must act: looping, waiting, off-fence. */
export const NEEDS_YOU: Rgb = [255, 200, 87]
/** BROKEN — dead air. FROZEN's cut strokes and hollow node. */
export const BROKEN: Rgb = [255, 61, 104]

/**
 * Dead tissue: a frozen lane's *thread*, while its marks keep the broken hue.
 * The corpse is grey, the alarm is red. A luminance, not a fifth rung.
 */
export const NECROTIC: Rgb = [74, 82, 102]

// ── helpers ─────────────────────────────────────────────────────────────────

export function ink(rgb: Rgb, alpha: number): Ink {
  return { rgb, alpha: clamp01(alpha) }
}

export function fade(source: Ink, factor: number): Ink {
  return { rgb: source.rgb, alpha: clamp01(source.alpha * factor) }
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t)
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

/**
 * Toward the ice register's ceiling — how anything in this scene runs hot
 * without acquiring a hue. The target is {@link ICE_050} rather than pure white
 * on purpose: the brightest thing on screen still belongs to the palette.
 */
export function hotter(rgb: Rgb, amount: number): Rgb {
  return mix(rgb, ICE_050, amount)
}

/**
 * Perceived brightness, 0–1, alpha included. This is the number the contrast
 * budget is spent in (`salience.ts`) and the number graft g6's test compares, so
 * "the white-hot lane must not outshine the summons" is one arithmetic
 * assertion rather than a judgement about two screenshots.
 */
export function luminance(value: Ink): number {
  const [r, g, b] = value.rgb
  return ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * value.alpha
}

export function cssColour(value: Ink): string {
  const [r, g, b] = value.rgb
  return `rgba(${r}, ${g}, ${b}, ${clamp01(value.alpha).toFixed(3)})`
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}
