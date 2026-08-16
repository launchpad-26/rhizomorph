/**
 * CONTRAST AS ARITHMETIC (prd-32 ruling 3 and ruling 9).
 *
 * The legibility floor has been a comment since prd9: "text may not wear
 * anything dimmer than `ice-400` (5.1:1 against the `ice-1000` floor); ice-500
 * and ice-600 measure 3.3:1 and 2.4:1". Three numbers, computed nowhere, in a
 * file whose hexes anybody may retune. A ramp edit could cross the floor
 * without a single test going red, and the prose would go on claiming the old
 * ratio — which is not a hypothetical failure mode: computing the third number
 * for the first time is how this wave found that `ice-600` is 2.18:1, not 2.4.
 *
 * `legibility.test.ts` already polices *which token* text may wear, by grepping
 * the source. It cannot police *what that token measures*, because the answer
 * lives in the hexes rather than in the class names. This is the other half.
 *
 * **Per theme** is ruling 9's word and the reason this is a function of a token
 * table rather than of the ice ramp: light (#551) redefines the same ten role
 * names against a warm off-white ground, and a light-theme regression has to
 * fail the same suite a dark-theme one does. Nothing here knows what dark is.
 */

import { linearise, type Rgb } from './oklch.js'

/**
 * WCAG 2.x relative luminance. Deliberately not `scene/palette.ts`'s
 * `luminance`, and the two must not be confused: that one is a *budget* — a
 * gamma-naive weighted mean of the bytes, times alpha, in which `CALM_CEILING`
 * and `ALARM_FLOOR` are denominated, and it exists so the scene can reason
 * about how loud a mark is. This one answers a different question — can a human
 * read this text — and it is the gamma-decoded definition the 4.5:1 threshold
 * is actually specified against. A category tint is measured with the first; a
 * body-copy pair is measured with this.
 */
export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(linearise) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The WCAG ratio between two colours, 1:1 to 21:1, order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * WCAG's threshold for body text, and the one the prd9 ruling was measured
 * against ("ice-500 and ice-600 … under WCAG's 4.5:1 body threshold").
 */
export const BODY_TEXT_MINIMUM = 4.5

/**
 * WCAG's threshold for a non-text indicator — a focus ring, a border a reader
 * has to find. The old hand-rolled ring was `ice-600`, which measures 2.18:1
 * against the floor and misses this by a wide margin; that, rather than mere
 * inconsistency, is why the one focus token is `ice-200`.
 */
export const NON_TEXT_MINIMUM = 3
