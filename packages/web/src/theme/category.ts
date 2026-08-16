/**
 * THE CATEGORY FAMILY'S FIVE CAPS (prd-32 ruling 8), as arithmetic.
 *
 * Ruling 8 amends the most-repeated constraint in this repository's record, and
 * it says so in those words: "no new semantic hue" has been restated in every
 * colour ruling since prd3, and a small violet family for *kind of work* now
 * lands beside the six status hues. The six remain the entire vocabulary of
 * *state*. What is new is a vocabulary of *kind*.
 *
 * An amendment like that is exactly how a colour law erodes by degrees — first
 * one accent for organic material, then a category family, then a chart series,
 * and eventually the amber that means "a human must act" is competing with four
 * other ambers for the reader's eye. prd10's accent survived that objection by
 * stating its safety in numbers (41° clear of ice, 87° from notice, 78° from
 * broken) and then putting those numbers in a test. This is the same move,
 * generalised: the ruling's five caps are five functions, every one of them
 * riggable, and `category.test.ts` feeds each a deliberately illegal family and
 * watches it turn red. A cap that has only ever been shown passing is a cap
 * nobody has checked.
 *
 * The family itself is extended from the organism's own material hue — OKLCH
 * H ≈ 295.5, the accent the scene already owns — at a fraction of its chroma.
 * That is the "one organism, many tissues" claim in ruling 8: a category reads
 * as the instrument's own substance rather than as UI decoration, because it
 * literally is the same hue, drained.
 */

import { ink, luminance, type Rgb } from '../scene/palette.js'
import { hueGap, oklch } from './oklch.js'

/**
 * CAP 1 — chroma ceiling, as a fraction of the *least* chromatic status hue.
 *
 * "Well below every status hue" is the ruling's phrase, and a fixed number
 * would go stale the first time a status hue is retuned. A fraction of the
 * quietest one cannot: whatever `done` becomes, a category stays under
 * two-thirds of it. Category is a tint, never a signal.
 */
export const CATEGORY_CHROMA_FRACTION = 0.6

/**
 * CAP 2 — no glow, ever. Expressed as a count that must be zero.
 *
 * Glow is alarm grammar (law 9b) — the halo, the cartouche, the fade exemption
 * and the band above the calm ceiling are together what buys a summons its
 * attention now that hue exclusivity no longer does. A category tint with a
 * halo would be borrowing the one treatment reserved for "a human must act",
 * and it would do it while carrying no state at all.
 */
export const CATEGORY_SHADOWS_ALLOWED = 0

/**
 * CAP 4 — angular clearance from `--color-notice`, in OKLCH degrees.
 *
 * Cyan is the accent prompts already carry, and it is the one status hue a
 * violet family could plausibly drift toward on its way round the wheel. 60° is
 * roughly twice the 30° separation `palette.test.ts` holds the status hues to
 * from each other, because a non-status family has to be *more* clearly not-a-
 * status than two statuses have to be not-each-other.
 */
export const CATEGORY_NOTICE_CLEARANCE = 60

/**
 * CAP 5 — greyscale survival, as the minimum luminance step between any two
 * members of the family.
 *
 * Law 9 restated for the new family: colour is never the sole carrier. Strip
 * the hue and four tints at the same lightness become one grey; four tints a
 * step apart stay four things. Measured in the scene's own luminance units so
 * it is the same scale cap 3 is denominated in.
 */
export const CATEGORY_LIGHTNESS_STEP = 0.08

/** The world the caps are measured against — the parts that are not the family. */
export interface CategoryWorld {
  /** The six status hues. Cap 1 is a fraction of the least chromatic of them. */
  readonly statusHues: readonly Rgb[]
  /** `--color-notice`, the hue cap 4 measures clearance from. */
  readonly notice: Rgb
  /** `CALM_CEILING` — the top of the calm band, from `scene/salience.ts`. */
  readonly calmCeiling: number
  /** `theme.css` itself, for the one cap that is about CSS rather than colour. */
  readonly css: string
}

/**
 * Every cap the family breaks, as sentences a reader can act on. Empty is the
 * only passing answer.
 *
 * Returned rather than asserted so the test can rig one cap at a time and see
 * exactly that cap fail — a boolean would let a family that breaks two caps
 * pass a test that only meant to prove one of them bites.
 */
export function capViolations(family: readonly Rgb[], world: CategoryWorld): string[] {
  const broken: string[] = []

  // CAP 1 — chroma.
  const quietestStatus = Math.min(...world.statusHues.map((hue) => oklch(hue).c))
  const chromaCeiling = quietestStatus * CATEGORY_CHROMA_FRACTION
  for (const [index, colour] of family.entries()) {
    const chroma = oklch(colour).c
    if (chroma > chromaCeiling) {
      broken.push(
        `cap 1 (chroma): category-${index + 1} is ${chroma.toFixed(4)}, over the ${chromaCeiling.toFixed(
          4,
        )} ceiling (${CATEGORY_CHROMA_FRACTION}× the quietest status hue) — that is a signal, not a tint`,
      )
    }
  }

  // CAP 2 — no glow. A halo is alarm grammar; a category may not wear one.
  const haloed = shadowsNamingCategory(world.css)
  if (haloed.length > CATEGORY_SHADOWS_ALLOWED) {
    broken.push(`cap 2 (no glow): ${haloed.length} shadow declaration(s) wear a category tint: ${haloed.join(' · ')}`)
  }

  // CAP 3 — never above CALM_CEILING. Structurally incapable of entering the
  // band the alarms own, rather than merely not doing so today.
  for (const [index, colour] of family.entries()) {
    const lit = luminance(ink(colour, 1))
    if (lit > world.calmCeiling) {
      broken.push(
        `cap 3 (calm ceiling): category-${index + 1} is ${lit.toFixed(3)}, above CALM_CEILING ${world.calmCeiling} — it has entered the alarm band`,
      )
    }
  }

  // CAP 4 — angular clearance from the cyan that means notice.
  for (const [index, colour] of family.entries()) {
    const gap = hueGap(colour, world.notice)
    if (gap < CATEGORY_NOTICE_CLEARANCE) {
      broken.push(
        `cap 4 (notice clearance): category-${index + 1} is ${gap.toFixed(1)}° from --color-notice, under ${CATEGORY_NOTICE_CLEARANCE}°`,
      )
    }
  }

  // CAP 5 — greyscale survival, pairwise so no two members collapse.
  for (let i = 0; i < family.length; i += 1) {
    for (let j = i + 1; j < family.length; j += 1) {
      const step = Math.abs(
        luminance(ink(family[i] as Rgb, 1)) - luminance(ink(family[j] as Rgb, 1)),
      )
      if (step < CATEGORY_LIGHTNESS_STEP) {
        broken.push(
          `cap 5 (greyscale): category-${i + 1} and category-${j + 1} are ${step.toFixed(3)} apart in luminance, under ${CATEGORY_LIGHTNESS_STEP} — they are one grey with colour removed`,
        )
      }
    }
  }

  return broken
}

/**
 * Shadow declarations that reach for a category token, anywhere in the sheet.
 *
 * Both spellings of the offence are caught: a `@utility glow-category-…` block,
 * and a plain `box-shadow` on some surface that happens to name a category
 * tint. The second is the one a law that only read utility names would miss,
 * and it is the more likely mistake — nobody names a violation `glow-`.
 */
function shadowsNamingCategory(css: string): string[] {
  const found: string[] = []
  const declaration = /(box-shadow|text-shadow|filter)\s*:\s*([^;}]*)/gi
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(declaration)) {
    const value = match[2] as string
    if (/--category-/.test(value)) found.push(`${match[1] as string}: ${value.trim().slice(0, 60)}`)
  }
  return found
}
