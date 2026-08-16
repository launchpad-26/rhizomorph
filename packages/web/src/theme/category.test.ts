import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ink, luminance } from '../scene/palette.js'
import { CALM_CEILING } from '../scene/salience.js'
import {
  CATEGORY_CHROMA_FRACTION,
  CATEGORY_LIGHTNESS_STEP,
  CATEGORY_NOTICE_CLEARANCE,
  CATEGORY_SHADOWS_ALLOWED,
  capViolations,
  type CategoryWorld,
} from './category.js'
import { hueGap, oklch, rgbFromHex, type Rgb } from './oklch.js'
import { resolve, themesOf } from './tokens.js'

/**
 * THE CATEGORY FAMILY'S CAPS (prd-32 ruling 8), and the proof each one bites.
 *
 * Ruling 8 amends "no new semantic hue" — the most-repeated constraint in this
 * repository's record — and it is the kind of amendment that erodes a colour law
 * by degrees unless the bound is arithmetic. So the ruling states five caps as
 * numbers, and this file does two separate things with them:
 *
 *   1. holds the **real** family to all five; and
 *   2. hands the same law a family that breaks exactly one cap, five times over,
 *      and requires that cap to be the one that fails.
 *
 * The second is the load-bearing half, and prd-32 asks for it in those words:
 * "a rigged violation of any cap must turn the suite red". A cap that has only
 * ever been shown passing is indistinguishable from a cap that cannot fail —
 * the repo's own second-worst defect shape, a test that cannot fail for the
 * reason it claims.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const THEME = readFileSync(path.join(SRC, 'theme', 'theme.css'), 'utf8')
const DARK = themesOf(THEME)[0]?.tokens ?? new Map<string, string>()

function token(name: string): Rgb {
  const literal = resolve(name, DARK)
  expect(literal, `theme.css has no ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
  return rgbFromHex(literal as string)
}

/** The four, read off the real stylesheet rather than restated here. */
const FAMILY: readonly Rgb[] = ['--category-1', '--category-2', '--category-3', '--category-4'].map(token)

/**
 * The six status hues, from the same sheet. Cap 1 is a fraction of whichever of
 * them is quietest, so this list has to be the real six — a short list would
 * make the cap generous by accident.
 */
const STATUS_HUES: readonly Rgb[] = [
  '--color-working',
  '--color-done',
  '--color-waiting-benign',
  '--color-needs-you',
  '--color-broken',
  '--color-notice',
].map(token)

const WORLD: CategoryWorld = {
  statusHues: STATUS_HUES,
  notice: token('--color-notice'),
  calmCeiling: CALM_CEILING,
  css: THEME,
}

describe('the category family, against its own five caps', () => {
  it('defines four and only four', () => {
    // Bounded is half the ruling. A family that grows is a palette, and a
    // palette beside six status hues is the thing "no new hue" was protecting.
    const declared = [...THEME.matchAll(/(--category-[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string)
    expect(new Set(declared)).toEqual(
      new Set(['--category-1', '--category-2', '--category-3', '--category-4']),
    )
    expect(FAMILY).toHaveLength(4)
  })

  it('breaks none of them', () => {
    expect(capViolations(FAMILY, WORLD)).toEqual([])
  })

  it('is the organism’s own material, drained — not a new hue', () => {
    // "Extended from the tissue accent the scene already owns (OKLCH H ≈ 295.5),
    // so category colour reads as the organism's own material rather than as UI
    // decoration." The claim is an angle, so it is checked as one. The accent's
    // own token is not named here on purpose: `marks.test.ts` holds it to
    // "scene draws and nowhere else", and this family is not the accent — it is
    // the same hue at a fraction of the chroma.
    for (const [index, colour] of FAMILY.entries()) {
      expect(Math.abs(oklch(colour).h - 295.5), `category-${index + 1} left the family`).toBeLessThan(12)
    }
  })

  it('reports the measured margin on every cap, so a retune can see its headroom', () => {
    const chromas = FAMILY.map((colour) => oklch(colour).c)
    const quietest = Math.min(...STATUS_HUES.map((hue) => oklch(hue).c))
    const lit = FAMILY.map((colour) => luminance(ink(colour, 1)))

    expect(Math.max(...chromas)).toBeLessThanOrEqual(quietest * CATEGORY_CHROMA_FRACTION)
    expect(Math.max(...lit)).toBeLessThanOrEqual(CALM_CEILING)
    expect(Math.min(...FAMILY.map((colour) => hueGap(colour, WORLD.notice)))).toBeGreaterThanOrEqual(
      CATEGORY_NOTICE_CLEARANCE,
    )
    // Sorted, then adjacent: four tints that survive greyscale are four
    // *ordered* lightnesses, which is also what makes them usable as a ramp.
    const sorted = [...lit].sort((a, b) => a - b)
    for (let i = 1; i < sorted.length; i += 1) {
      expect((sorted[i] as number) - (sorted[i - 1] as number)).toBeGreaterThanOrEqual(
        CATEGORY_LIGHTNESS_STEP,
      )
    }
  })
})

/**
 * THE RIGGED FAMILIES — one per cap, each breaking exactly one.
 *
 * Every rig starts from the real family and changes the least it can, so the
 * failure it produces is attributable. A rig that broke three caps would prove
 * only that the law returns something.
 */
describe('a rigged violation of any cap turns the suite red', () => {
  /**
   * Cap 1: `category-1`'s own hue and lightness at 0.150 chroma instead of
   * 0.056 — a saturated violet. Nothing else about it moves, which is why the
   * only cap it can trip is the chroma one.
   */
  const OVER_CHROMA: readonly Rgb[] = [rgbFromHex('#4c2887'), ...FAMILY.slice(1)]

  /** Cap 2: a category tint given a halo, which is alarm grammar. */
  const HALOED = `${THEME}\n@utility glow-category-1 { box-shadow: 0 0 16px var(--category-1); }\n`

  /** Cap 3: the same violet at the same chroma, lifted to 0.864 — into the band
   * the alarms own, where a category has no business being. */
  const OVER_CEILING: readonly Rgb[] = [...FAMILY.slice(0, 3), rgbFromHex('#e0d8fc')]

  /** Cap 4: a tint that kept the chroma cap and the lightness step but drifted
   * round the wheel to 1.3° off `--color-notice` — a category wearing cyan. */
  const NEAR_NOTICE: readonly Rgb[] = [...FAMILY.slice(0, 3), rgbFromHex('#99c7cf')]

  /** Cap 5: two members at the same lightness — one grey in greyscale. */
  const COLLAPSED: readonly Rgb[] = [FAMILY[0] as Rgb, FAMILY[0] as Rgb, ...FAMILY.slice(2)]

  it.each([
    ['cap 1 (chroma)', OVER_CHROMA, WORLD],
    ['cap 2 (no glow)', FAMILY, { ...WORLD, css: HALOED }],
    ['cap 3 (calm ceiling)', OVER_CEILING, WORLD],
    ['cap 4 (notice clearance)', NEAR_NOTICE, WORLD],
    ['cap 5 (greyscale)', COLLAPSED, WORLD],
  ])('catches %s', (cap, family, world) => {
    const broken = capViolations(family as readonly Rgb[], world as CategoryWorld)
    expect(broken.length, `${cap} did not fail: ${JSON.stringify(broken)}`).toBeGreaterThan(0)
    // Attributable: the rig must trip the cap it was built for, and only it.
    expect(broken.every((message) => message.startsWith(cap)), broken.join('\n')).toBe(true)
  })

  it('has a zero-shadow cap that is genuinely zero', () => {
    // The one cap whose number is a count. Stated rather than implied, because
    // "no glow, ever" read as "not many glows" is how an exclusivity erodes.
    expect(CATEGORY_SHADOWS_ALLOWED).toBe(0)
  })

  it('finds nothing to complain about in the real sheet — no glow ships', () => {
    expect(capViolations(FAMILY, WORLD).filter((m) => m.startsWith('cap 2'))).toEqual([])
  })
})
