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
import { contrastRatio } from './contrast.js'
import { deltaE, hueGap, oklch, rgbFromHex, simulate, type Dichromacy, type Rgb } from './oklch.js'
import { resolve, themesOf, type Declarations } from './tokens.js'

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
const THEMES = themesOf(THEME)
const DARK = THEMES[0]?.tokens ?? new Map<string, string>()

function token(name: string, tokens: Declarations = DARK): Rgb {
  const literal = resolve(name, tokens)
  expect(literal, `theme.css has no ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
  return rgbFromHex(literal as string)
}

const FAMILY_TOKENS: readonly string[] = ['--category-1', '--category-2', '--category-3', '--category-4']

/**
 * The six status hues. Cap 1 is a fraction of whichever of them is quietest, so
 * this list has to be the real six — a short list would make the cap generous
 * by accident. Read per theme, because light re-inks all six and its quietest
 * chroma is not dark's.
 */
const STATUS_TOKENS: readonly string[] = [
  '--color-working',
  '--color-done',
  '--color-waiting-benign',
  '--color-needs-you',
  '--color-broken',
  '--color-notice',
]

/** The four, read off the real stylesheet rather than restated here. */
const FAMILY: readonly Rgb[] = FAMILY_TOKENS.map((name) => token(name))
const STATUS_HUES: readonly Rgb[] = STATUS_TOKENS.map((name) => token(name))

const WORLD: CategoryWorld = {
  statusHues: STATUS_HUES,
  notice: token('--color-notice'),
  calmCeiling: CALM_CEILING,
  css: THEME,
}

/**
 * EVERY THEME, AGAINST ITS OWN WORLD (prd-32 rulings 4 and 8).
 *
 * The caps are a function of the theme they are measured in: cap 1 is a
 * fraction of the *quietest status hue*, and light re-inks all six, so a family
 * that clears the cap on the void may not clear it on paper. Discovered rather
 * than listed, exactly as the contrast law is — a third theme is covered the
 * moment it lands.
 *
 * The dark-only laws below this block stay dark-only on purpose: they are
 * claims about the ice register, and light re-derives its family beside them
 * rather than inheriting them (ruling 7).
 */
describe.each(THEMES)('the five caps hold in $name', (theme) => {
  const family = FAMILY_TOKENS.map((name) => token(name, theme.tokens))
  const world: CategoryWorld = {
    statusHues: STATUS_TOKENS.map((name) => token(name, theme.tokens)),
    notice: token('--color-notice', theme.tokens),
    calmCeiling: CALM_CEILING,
    css: THEME,
  }

  it('breaks none of them', () => {
    expect(capViolations(family, world)).toEqual([])
  })

  it('is the organism’s own material in this world too', () => {
    // The hue is a fact about the organism rather than about the theme, so it
    // does not move between them: light drains the same H 295.5 against a warm
    // ground instead of picking a violet that looks nice on paper.
    for (const [index, colour] of family.entries()) {
      expect(Math.abs(oklch(colour).h - 295.5), `${theme.name} category-${index + 1} left the family`)
        .toBeLessThan(12)
    }
  })

  it('is a different family from the other theme’s, not the same one reused', () => {
    // The failure ruling 7 names by name: "light derived by inverting dark". A
    // light family that reused dark's tints would put `category-4` (#ada4ca) on
    // warm paper, where it is a pale lilac on off-white — and cap 5 would go on
    // passing, because greyscale separation is a property of the four together
    // rather than of the ground under them.
    const dark = FAMILY_TOKENS.map((name) => token(name, DARK))
    if (theme.name === 'dark') return
    expect(family).not.toEqual(dark)
    expect(family.map((colour) => colour.join()).some((hex) => dark.map((c) => c.join()).includes(hex))).toBe(false)
  })
})

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

/**
 * LAW 9, FOR THE STATUS FAMILY'S TWO POLES (#39).
 *
 * Cap 5 above is law 9 restated for the category tints: strip the hue and
 * four tints must still be four things. The alarm colours that actually carry
 * state never got the same treatment — and the light theme shipped a `broken`
 * and a `working` that measured 1.25:1 in greyscale and ΔE 1.4 under
 * deuteranopia: "fine" and "dead" were one colour to one reader in twelve.
 *
 * Scope, stated honestly: this holds the two POLES of the scale — the green
 * that means "getting on with it" and the red that means "dead" — not all
 * fifteen pairs. The six are not pairwise separable without their glyphs in
 * EITHER theme (dark's done/broken sit at 1.01:1; light's done/waiting-benign
 * at 1.01:1), and they are not meant to be: law 9's by-construction half —
 * every state is glyph + word (`fleet/sigils.tsx`) — carries those. The poles
 * are the one pair whose confusion inverts the whole instrument's reading, so
 * they are held to a number. Both red-green dichromacies are checked, because
 * a fix picked against one is exactly the sibling-case shape this repo keeps
 * finding: the shipped pair passed protanopia (ΔE 15.3) while failing
 * deuteranopia (1.4).
 *
 * Why not cap 5's own `luminance()`: it is `scene/palette.ts`'s gamma-naive
 * budget, and it reports the shipped light pair 0.176 apart — comfortably
 * over cap 5's 0.08 step — while a gamma-decoded grey puts them at 1.25:1.
 * The naive mean errs little on the low-chroma tints cap 5 was written for and
 * badly on saturated dark inks. So this law is denominated in WCAG contrast
 * (`contrast.ts`), the same ratio the legibility law uses, and it would have
 * seen the defect the day it shipped.
 */
const POLE_GREYSCALE_FLOOR = 1.5
const POLE_CVD_FLOOR = 8
const DICHROMACIES: readonly Dichromacy[] = ['deuteranopia', 'protanopia']

/** Every way the two poles fail to separate, as sentences. Empty is the only pass. */
function poleViolations(working: Rgb, broken: Rgb): string[] {
  const found: string[] = []
  const grey = contrastRatio(working, broken)
  if (grey < POLE_GREYSCALE_FLOOR) {
    found.push(`greyscale: working and broken are ${grey.toFixed(2)}:1 with colour removed, under ${POLE_GREYSCALE_FLOOR}:1`)
  }
  for (const kind of DICHROMACIES) {
    const distance = deltaE(simulate(working, kind), simulate(broken, kind))
    if (distance < POLE_CVD_FLOOR) {
      found.push(`${kind}: working and broken are ΔE ${distance.toFixed(1)} apart to a ${kind.replace(/ia$/, 'e')}, under ${POLE_CVD_FLOOR}`)
    }
  }
  return found
}

describe.each(THEMES)('law 9 — the two poles survive greyscale and a red-green reader in $name', (theme) => {
  const working = token('--color-working', theme.tokens)
  const broken = token('--color-broken', theme.tokens)

  it('separates fine from dead without hue', () => {
    expect(poleViolations(working, broken)).toEqual([])
  })

  it('reports its margin on every axis, so a retune can see its headroom', () => {
    expect(contrastRatio(working, broken)).toBeGreaterThanOrEqual(POLE_GREYSCALE_FLOOR)
    for (const kind of DICHROMACIES) {
      expect(deltaE(simulate(working, kind), simulate(broken, kind)), kind).toBeGreaterThanOrEqual(POLE_CVD_FLOOR)
    }
  })
})

describe('a rigged pair of poles turns the suite red, on the axis it was rigged on', () => {
  it.each([
    // The defect itself: the light pair as it shipped before #39. Fails the
    // grey and the deuteranope, passes the protanope — which is why both are checked.
    ['greyscale + deuteranopia', '#007137', '#a90035', ['greyscale', 'deuteranopia']],
    // Equal luminance, wildly different hue: one grey, two colours to everyone else.
    ['greyscale', '#802000', '#0000e0', ['greyscale']],
    // A green and a red a protanope cannot tell apart, that everyone else can.
    ['protanopia', '#006040', '#e02040', ['protanopia']],
    // …and the deuteranope's own confusion line, distinct from the protanope's.
    ['deuteranopia', '#60a020', '#e00040', ['deuteranopia']],
  ])('catches %s', (_label, working, broken, axes) => {
    const found = poleViolations(rgbFromHex(working), rgbFromHex(broken))
    expect(found.map((message) => message.split(':')[0]).sort()).toEqual([...axes].sort())
  })

  it('has floors the shipped dark pair clears with room, so the law is not tuned to a hair', () => {
    const working = token('--color-working', DARK)
    const broken = token('--color-broken', DARK)
    expect(contrastRatio(working, broken)).toBeGreaterThan(POLE_GREYSCALE_FLOOR * 1.2)
    expect(deltaE(simulate(working, 'deuteranopia'), simulate(broken, 'deuteranopia'))).toBeGreaterThan(POLE_CVD_FLOOR * 1.2)
  })

  it('simulates a colour, not the identity — a red loses its red to a protanope', () => {
    // The one assertion that would catch a zero or identity matrix: pure red
    // darkens sharply for a protanope (the L cones are gone) and barely for a
    // deuteranope. Numbers from the matrix, not from taste.
    const red = rgbFromHex('#ff0000')
    expect(simulate(red, 'protanopia')[0]).toBeLessThan(120)
    expect(simulate(red, 'deuteranopia')[0]).toBeGreaterThan(140)
    expect(deltaE(red, red)).toBe(0)
  })
})
