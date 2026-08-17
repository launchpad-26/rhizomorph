/**
 * OKLCH, WRITTEN OUT — because the colour laws in this directory are only worth
 * what the number they turn on is worth.
 *
 * Every claim prd-32 makes about the palette is an angle or a distance: the
 * category family sits 86.8° clear of `--color-notice`; its chroma is a
 * fraction of the least chromatic status hue; the four steps separate by
 * lightness so they survive greyscale. All three are meaningless in sRGB and
 * misleading in HSL — HSL puts `done` and `notice` 29° apart while the eye
 * reads a clear green and a clear cyan, and a law that fails on a colour nobody
 * confuses is a law that gets deleted.
 *
 * Eleven lines of published matrix arithmetic (Björn Ottosson's Oklab), and it
 * is inlined rather than depended on for the reason `palette.test.ts` gives for
 * its own copy of the hue half: the laws above are worth more if the number
 * they turn on is inspectable in the diff a reviewer reads. This module is the
 * shared version — `palette.test.ts`'s local `oklabHue` predates it and stays
 * where it is, deliberately, so the canvas mirror suite carries its own
 * arithmetic and cannot be broken from here.
 *
 * Oklab is also the space `theme.css` already mixes in (`color-mix(in oklab,
 * …)` in every glow), so a law measured here and a colour blended there are
 * measured in the same units.
 */

/** An sRGB colour as three bytes, matching `scene/palette.ts`'s `Rgb`. */
export type Rgb = readonly [number, number, number]

/** Lightness 0–1, chroma in Oklab units, hue in degrees 0–360. */
export interface Oklch {
  readonly l: number
  readonly c: number
  readonly h: number
}

/** `#rrggbb` → three bytes. Throws rather than guessing: a malformed token in
 * the theme is a fact a law wants to hear about loudly. */
export function rgbFromHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new Error(`not a 6-digit hex colour: ${hex}`)
  const digits = match[1] as string
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ]
}

/** sRGB byte → linear-light. The gamma decode both Oklab and WCAG are defined on. */
export function linearise(byte: number): number {
  const channel = byte / 255
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

export function oklch(rgb: Rgb): Oklch {
  const [r, g, b] = rgb.map(linearise) as [number, number, number]

  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  const l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short
  const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short
  const bb = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short

  return { l, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 }
}

/** The shorter way round the colour wheel between two hues, in degrees. */
export function hueGap(a: Rgb, b: Rgb): number {
  const gap = Math.abs(oklch(a).h - oklch(b).h) % 360
  return Math.min(gap, 360 - gap)
}
