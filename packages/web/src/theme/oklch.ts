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
 *
 * This module also carries the two red-green dichromacy matrices and
 * `deltaE` — law 9's status-family test (#39) needs the same Oklab distance
 * this file already computes for hue, applied to a simulated colour rather
 * than the shipped one.
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

/** Oklab `[l, a, b]` for an sRGB colour — the eleven lines `oklch()` turns into l/c/h. */
function oklab(rgb: Rgb): readonly [number, number, number] {
  const [r, g, b] = rgb.map(linearise) as [number, number, number]

  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  const l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short
  const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short
  const bb = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short

  return [l, a, bb]
}

export function oklch(rgb: Rgb): Oklch {
  const [l, a, bb] = oklab(rgb)
  return { l, c: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 }
}

/** The shorter way round the colour wheel between two hues, in degrees. */
export function hueGap(a: Rgb, b: Rgb): number {
  const gap = Math.abs(oklch(a).h - oklch(b).h) % 360
  return Math.min(gap, 360 - gap)
}

/** Linear-light → sRGB byte. `linearise`'s inverse, clamped, for re-encoding a simulated colour. */
export function delinearise(channel: number): number {
  const clamped = channel < 0 ? 0 : channel > 1 ? 1 : channel
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055
  return Math.round(encoded * 255)
}

/**
 * Perceptual distance between two colours: Euclidean in Oklab, ×100 so the
 * numbers sit on the scale colour-vision validators report (ΔE ≈ 1 is about
 * the least difference a reader notices; the shipped light pair measured 1.4
 * under deuteranopia). Oklab because that is the space every law in this
 * directory is already denominated in.
 */
export function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = oklab(a)
  const [l2, a2, b2] = oklab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100
}

/** The two red-green dichromacies — the ~8% of male readers law 9 is for. */
export type Dichromacy = 'deuteranopia' | 'protanopia'

/**
 * Machado, Oliveira & Fernandes (2009), "A Physiologically-based Model for
 * Simulation of Color Vision Deficiency", severity 1.0, applied in linear
 * light. Inlined for the reason `oklch()` is: a law is worth what the number
 * it turns on is worth, and this matrix is the number.
 */
const DICHROMACY: Readonly<Record<Dichromacy, readonly (readonly [number, number, number])[]>> = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
}

/** What `rgb` looks like to a reader with the given dichromacy, as sRGB bytes. */
export function simulate(rgb: Rgb, kind: Dichromacy): Rgb {
  const [r, g, b] = rgb.map(linearise) as [number, number, number]
  const [row0, row1, row2] = DICHROMACY[kind] as [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ]
  return [
    delinearise(row0[0] * r + row0[1] * g + row0[2] * b),
    delinearise(row1[0] * r + row1[1] * g + row1[2] * b),
    delinearise(row2[0] * r + row2[1] * g + row2[2] * b),
  ]
}
