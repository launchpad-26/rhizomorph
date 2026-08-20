import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LadderRank } from '@rhizomorph/core'
import { describe, expect, it } from 'vitest'
import { FALLBACK_HUE } from '../panels/attention/useTabSignal.js'
import { SETTLE_MS } from './geometry/scale.js'
import { BREATH_PERIOD_MS } from './marks/frame.js'
import { AMBIENT } from './motion.js'
// The scene's type stacks. They moved from `paint.ts` to the WebGL2 painter's 2D
// type layer with #578 — type is the one thing the GPU painter still draws
// through a canvas context, so it is still the one place the stack is a string.
// The assertions below are unchanged; only the address is.
import { FONT } from './gl/overlay.js'
import { entryOf } from '../settings/registry.js'
import { resolveTheme, type ResolvedTheme } from '../settings/apply.js'
import { resolve as resolveToken, themesOf, type Theme } from '../theme/tokens.js'
import { CHANNELS, SHIMMER_MAX, SHIMMER_PERIOD_MS, variationFor } from './variation.js'
import {
  ACTIVITY_HUE,
  BROKEN,
  DONE,
  ICE_050,
  ICE_100,
  ICE_1000,
  ICE_200,
  ICE_300,
  ICE_400,
  ICE_500,
  ICE_600,
  ICE_700,
  ICE_950,
  NECROTIC,
  NEEDS_YOU,
  NOTICE,
  TISSUE_200,
  TISSUE_400,
  TISSUE_500,
  TISSUE_700,
  TISSUE_900,
  TISSUE_RAMP,
  CALM_BODY_FLOOR,
  DARK_PALETTE,
  LIGHT_PALETTE,
  PALETTES,
  PAPER_ALARM_FLOOR,
  PAPER_BODY_FLOOR,
  PAPER_CALM_CEILING,
  PAPER_CALM_FLOOR,
  PAPER_TIP_CEILING,
  REPLAY_VIBRANCY,
  SEVERITY_LADDER,
  TUFT_WASH,
  WAITING_BENIGN,
  WORKING,
  activityInk,
  activityInkOn,
  ambientLift,
  ambientVeil,
  capPresence,
  carriesSeverity,
  cssColour,
  emphatic,
  hotter,
  incandescent,
  ink,
  luminance,
  mix,
  paletteFor,
  presence,
  returningInk,
  saturate,
  tissueAt,
  type Ink,
  type RegisterSlot,
  type Rgb,
  type ScenePalette,
  type SeverityReading,
  type ThemeName,
} from './palette.js'
import { ALARM_FLOOR, CALM_CEILING, CALM_FLOOR, RECEDE, spend, TIP_CEILING } from './salience.js'

/**
 * THE MIRROR. Canvas cannot read a Tailwind class, so `palette.ts` is the one
 * place in the instrument where a theme token is repeated as a literal — and a
 * repeated constant drifts unless something checks. This parses the real
 * `theme/theme.css` and holds every number to its token, so the scene and the
 * panels around it cannot quietly stop being the same colour.
 */

/**
 * The real stylesheet, read off disk. Reading the token source itself is the
 * point — a hand-copied expectation would drift in exactly the way this test
 * exists to catch. Resolved from this file rather than from the working
 * directory, so it finds the theme whether the suite is run from the repo root
 * or from `packages/web`.
 *
 * Deliberately not `new URL('…', import.meta.url)`: Vite rewrites that shape
 * into an asset URL, and the asset it produces is not a file path.
 */
const THEME = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../theme/theme.css'),
  'utf8',
)

function token(name: string): Rgb {
  const match = new RegExp(`--color-${name}:\\s*#([0-9a-f]{6})`, 'i').exec(THEME)
  expect(match, `theme.css has no --color-${name}`).not.toBeNull()
  const hex = (match as RegExpExecArray)[1] as string
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ]
}

/**
 * A token's raw value, whatever shape it takes — a font stack, a duration, a
 * hex. `token()` above insists on a colour because the ramp assertions want
 * bytes; the mirrors added by prd-32 wave 1 are strings.
 */
function raw(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(THEME.replace(/\/\*[\s\S]*?\*\//g, ' '))
  expect(match, `theme.css has no ${name}`).not.toBeNull()
  return ((match as RegExpExecArray)[1] as string).trim()
}

/** The ice ramp, mirrored here in the order the register climbs. */
const RAMP = [
  ICE_1000,
  ICE_950,
  ICE_700,
  ICE_600,
  ICE_500,
  ICE_400,
  ICE_300,
  ICE_200,
  ICE_100,
  ICE_050,
] as const

/** The six status hues (law 9a), in the order the semantic map declares them. */
const STATUS_HUES: readonly (readonly [string, Rgb])[] = [
  ['working', WORKING],
  ['done', DONE],
  ['waiting-benign', WAITING_BENIGN],
  ['needs-you', NEEDS_YOU],
  ['broken', BROKEN],
  ['notice', NOTICE],
]

describe('the ice-neon register, mirrored for canvas', () => {
  it.each([
    ['ice-1000', ICE_1000],
    ['ice-950', ICE_950],
    ['ice-700', ICE_700],
    ['ice-600', ICE_600],
    ['ice-500', ICE_500],
    ['ice-400', ICE_400],
    ['ice-300', ICE_300],
    ['ice-200', ICE_200],
    ['ice-100', ICE_100],
    ['ice-050', ICE_050],
    ['working', WORKING],
    ['done', DONE],
    ['waiting-benign', WAITING_BENIGN],
    ['notice', NOTICE],
    ['needs-you', NEEDS_YOU],
    ['broken', BROKEN],
    ['necrotic', NECROTIC],
    // prd10 rulings 5 and 11's five-step tissue ramp. In this list for the same
    // reason every hue above is: canvas cannot read a token, so the mirror needs
    // something that fails when it drifts.
    ['tissue-900', TISSUE_900],
    ['tissue-700', TISSUE_700],
    ['tissue-500', TISSUE_500],
    ['tissue-400', TISSUE_400],
    ['tissue-200', TISSUE_200],
  ])('%s still equals its theme token', (name, value) => {
    expect(value).toEqual(token(name))
  })

  it('builds the structural world out of one hue at several luminances (ruling 29)', () => {
    // "Neon is luminance, not saturation": the ice ramp must be monotonic in
    // brightness and share a hue, or the scene stops being one world.
    const brightness = RAMP.map((rgb) => luminance(ink(rgb, 1)))
    for (let i = 1; i < brightness.length; i += 1) {
      expect(brightness[i]).toBeGreaterThan(brightness[i - 1] as number)
    }
    // Cold: every step has more blue than red.
    for (const [r, , b] of RAMP) expect(b).toBeGreaterThan(r)
  })

  it('reaches its white through the ramp, never through #ffffff', () => {
    // The brightest thing on screen still belongs to the palette — which is why
    // a blown-out EXPENSIVE thread reads as the same world as the chrome.
    expect(hotter(ICE_200, 1)).toEqual(ICE_050)
    expect(ICE_050).not.toEqual([255, 255, 255])
  })

  it('keeps every status hue out of the ice ramp (law 9a)', () => {
    // Prd3's version of this law said "the ladder hues are not in the ramp",
    // because only the ladder had hues. Prd4 gave activity real colour, so the
    // claim widens to all six: ice means structure and nothing-to-say, and a
    // structural surface must never be able to pick up a status hue by
    // accident — nor a status able to pass itself off as chrome.
    for (const [name, hue] of STATUS_HUES) {
      expect(RAMP, `${name} is a member of the ice ramp`).not.toContainEqual(hue)
    }
  })
})

/**
 * THE MIRROR, DOUBLED (prd-32 ruling 4).
 *
 * "`scene/palette.ts` becomes per-theme tables and the colour mirror test
 * doubles." Everything above is dark's, read out of `@theme` by a regex that
 * takes the first match in the file; everything below reads *both* worlds
 * through `themesOf`, which layers each `[data-theme]` block over the base the
 * way the cascade does. The discovery is the mechanism: a third theme would be
 * mirrored the moment it landed, with no edit here.
 *
 * The slot table is the artefact worth reading. Ten slots, two registers, and
 * the two run in opposite physical directions through them — `ground` is the
 * darkest thing in the ice ramp and the lightest thing on paper; `peak` is the
 * reverse. That single fact is the whole reason severity could not simply be
 * re-pointed at a new set of hexes, and it is why `theme.css` numbers the paper
 * register by ink rather than by luminance.
 */
const THEMES = themesOf(THEME)

const REGISTER_TOKENS: Readonly<Record<ThemeName, Readonly<Record<RegisterSlot, string>>>> = {
  dark: {
    ground: '--color-ice-1000',
    plate: '--color-ice-950',
    cold: '--color-ice-700',
    unknown: '--color-ice-600',
    oldest: '--color-ice-500',
    idle: '--color-ice-400',
    body: '--color-ice-300',
    data: '--color-ice-200',
    emphasis: '--color-ice-100',
    peak: '--color-ice-050',
  },
  light: {
    ground: '--color-paper-000',
    plate: '--color-paper-050',
    cold: '--color-paper-300',
    unknown: '--color-paper-400',
    oldest: '--color-paper-500',
    idle: '--color-paper-600',
    body: '--color-paper-700',
    data: '--color-paper-800',
    emphasis: '--color-paper-900',
    peak: '--color-paper-950',
  },
}

const STATUS_TOKENS: Readonly<Record<keyof ScenePalette['status'], string>> = {
  working: '--color-working',
  done: '--color-done',
  waitingBenign: '--color-waiting-benign',
  needsYou: '--color-needs-you',
  broken: '--color-broken',
  notice: '--color-notice',
}

const TISSUE_TOKENS: readonly string[] = [
  '--color-tissue-900',
  '--color-tissue-700',
  '--color-tissue-500',
  '--color-tissue-400',
  '--color-tissue-200',
]

/** A token's colour in one theme, followed through whatever `var()` chain it takes. */
function themed(theme: Theme, name: string): Rgb {
  const literal = resolveToken(name, theme.tokens)
  expect(literal, `${theme.name} has no ${name}`).toMatch(/^#[0-9a-f]{6}$/i)
  const hex = (literal as string).slice(1)
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ]
}

describe('both themes are declared, and the tables are the themes', () => {
  it('finds dark first and light beside it', () => {
    // Dark is the unqualified `:root` — the theme you get before anybody has
    // chosen — because "dark remains the source of truth" (prd-32 non-goals).
    expect(THEMES.map((theme) => theme.name)).toEqual(['dark', 'light'])
  })

  it('has a palette for every theme the stylesheet declares, and no orphan', () => {
    // The half that catches the real drift: a theme added to `theme.css` with
    // no table beside it would leave the scene painting the void under light
    // chrome, silently. Set equality both ways, so an orphan table fails too.
    expect(new Set(Object.keys(PALETTES))).toEqual(new Set(THEMES.map((theme) => theme.name)))
    for (const theme of THEMES) {
      expect(paletteFor(theme.name as ThemeName).theme).toBe(theme.name)
    }
  })

  it('is the same set the settings registry offers and the applier resolves to (#550)', () => {
    // THE SEAM, HELD FROM BOTH ENDS. Three lists have to agree about what a
    // theme is, and they live in three places by design: the registry declares
    // what a person may choose, `settings/apply.ts` resolves that choice onto
    // `data-theme`, and this file declares what the scene can actually paint.
    // Nothing structural stops them drifting — a fourth option added to the
    // control would store and apply perfectly and then meet no table here, so
    // the page would say `light-high-contrast` while the instrument drew the
    // void. That is the failure mode #550's own gap note is about, and this is
    // the assertion that makes it impossible rather than merely unlikely.
    const offered = (entryOf('appearance.theme').options ?? [])
      .map((option) => option.value)
      .filter((value) => value !== 'system')
    expect(new Set(offered)).toEqual(new Set(Object.keys(PALETTES)))

    // …and the applier's own resolution lands on a table for every one of them,
    // including the `system` case in both directions. `ResolvedTheme` and
    // `ThemeName` are structurally the same type; this is the runtime half.
    for (const prefersLight of [true, false]) {
      for (const choice of ['system', ...offered]) {
        const resolved: ResolvedTheme = resolveTheme(choice, {
          prefersLight,
          prefersReducedMotion: false,
        })
        expect(paletteFor(resolved).theme, `${choice} at prefersLight=${prefersLight}`).toBe(resolved)
      }
    }
  })
})

describe.each(THEMES)('the register and the hues, mirrored for canvas — $name', (theme) => {
  const palette = paletteFor(theme.name as ThemeName)
  const slots = REGISTER_TOKENS[theme.name as ThemeName]

  it.each(Object.keys(slots) as RegisterSlot[])('the %s slot still equals its token', (slot) => {
    expect(palette.register[slot]).toEqual(themed(theme, slots[slot]))
  })

  it.each(Object.keys(STATUS_TOKENS) as (keyof ScenePalette['status'])[])(
    '%s still equals its token',
    (hue) => {
      expect(palette.status[hue]).toEqual(themed(theme, STATUS_TOKENS[hue]))
    },
  )

  it('mirrors necrotic and the whole tissue ramp', () => {
    expect(palette.necrotic).toEqual(themed(theme, '--color-necrotic'))
    expect(palette.tissue).toEqual(TISSUE_TOKENS.map((token) => themed(theme, token)))
  })

  it('is one register at several luminances, ground-ward to peak', () => {
    // Ruling 29's surviving half, restated for whichever world is on: the
    // register is a *ramp*, so it must be monotone in brightness from `ground`
    // to `peak` — and the direction is the theme's own. Dark climbs (light is
    // added); paper descends (ink is). A register that wobbled would be a set
    // of swatches somebody picked between.
    const steps = (Object.keys(slots) as RegisterSlot[]).map((slot) =>
      luminance(ink(palette.register[slot], 1)),
    )
    const rising = theme.name === 'dark'
    for (let i = 1; i < steps.length; i += 1) {
      const previous = steps[i - 1] as number
      const here = steps[i] as number
      expect(rising ? here > previous : here < previous, `${theme.name} register wobbles at step ${i}`).toBe(true)
    }
    // …and it departs from its own ground monotonically, which is the same
    // claim written in the one quantity that holds in both worlds.
    let departure = -1
    for (const slot of Object.keys(slots) as RegisterSlot[]) {
      const here = presence(ink(palette.register[slot], 1), palette.ground)
      expect(here).toBeGreaterThanOrEqual(departure)
      departure = here
    }
  })

  it('keeps every status hue out of the register (law 9a)', () => {
    // Ice means structure and nothing-to-say, and so does paper: a structural
    // surface must never be able to pick up a status hue by accident, nor a
    // status pass itself off as chrome.
    const register = Object.values(palette.register)
    for (const [name, token] of Object.entries(STATUS_TOKENS)) {
      expect(register, `${name} is a member of the ${theme.name} register`).not.toContainEqual(
        themed(theme, token),
      )
    }
  })
})

/**
 * LAW 9a SURVIVES THE CROSSING — hue is meaning, and the meaning is the angle.
 *
 * "Green means productive, amber means blocked, red means dead" cannot be a
 * property of one theme. So the light register's six are not new colours: each
 * keeps its dark counterpart's OKLCH *hue angle* and is given a new lightness
 * and chroma, because on paper a status is ink laid down rather than light
 * emitted. Every separation law from the dark suite is then re-run against
 * light's own six, which is the test that would catch the obvious mistake —
 * picking six pleasant paper colours that no longer sit where the map says.
 */
describe('the semantic map holds in both worlds', () => {
  it.each(Object.keys(STATUS_TOKENS) as (keyof ScenePalette['status'])[])(
    'keeps %s at the angle it means',
    (hue) => {
      // 12° is the tolerance `theme/category.test.ts` uses for "left the
      // family", and the same idea: a hue that drifted further has stopped
      // being the same signal in the other theme.
      expect(hueGap(LIGHT_PALETTE.status[hue], DARK_PALETTE.status[hue])).toBeLessThan(12)
    },
  )

  it.each(THEMES.map((theme) => paletteFor(theme.name as ThemeName)))(
    'keeps the families together and broken alone — $theme',
    (palette: ScenePalette) => {
      const { working, done, waitingBenign, needsYou, broken, notice } = palette.status
      expect(hueGap(working, done)).toBeLessThan(15)
      expect(hueGap(waitingBenign, needsYou)).toBeLessThan(10)
      for (const green of [working, done]) expect(hueGap(green, notice)).toBeGreaterThan(30)
      for (const [name, hue] of Object.entries(palette.status)) {
        if (hue === broken) continue
        expect(hueGap(hue, broken), `${name} is too close to broken in ${palette.theme}`).toBeGreaterThan(30)
      }
    },
  )

  it.each(THEMES.map((theme) => paletteFor(theme.name as ThemeName)))(
    'keeps the family ladder pointing the same way — $theme',
    (palette: ScenePalette) => {
      // The relation, in the one quantity that means the same thing on both
      // grounds. On the void `working` is the brighter green and `needs-you`
      // the incandescent amber; on paper both are the *deeper ink*. Written in
      // luminance this assertion would have to be inverted per theme, which is
      // exactly the sort of per-theme special case that becomes a bug.
      const departs = (rgb: Rgb): number => presence(ink(rgb, 1), palette.ground)
      expect(departs(palette.status.working)).toBeGreaterThan(departs(palette.status.done))
      expect(departs(palette.status.needsYou)).toBeGreaterThan(departs(palette.status.waitingBenign))
    },
  )

  it('keeps the accent 30° clear of whichever register is under it (prd10 ruling 11)', () => {
    // The law that light's ink colour could most easily have broken in silence.
    // "Deep plum-grey inks" and a violet accent are neighbours on the wheel, so
    // `theme.css` puts the paper register at H 332 and the accent stays at the
    // organism's own 295.5 — measured here rather than trusted, in both worlds.
    for (const theme of THEMES) {
      const palette = paletteFor(theme.name as ThemeName)
      const accent = palette.tissue[3] as Rgb
      for (const step of Object.values(palette.register)) {
        // The two steps nearest the ground have no colour to be far from — a
        // hue angle on near-black or near-white is noise.
        if (presence(ink(step, 1), palette.ground) < 0.1) continue
        expect(hueGap(accent, step), `the accent drifted into the ${theme.name} register`).toBeGreaterThan(30)
      }
      expect(hueGap(accent, DARK_PALETTE.tissue[3] as Rgb), 'the organism changed material').toBeLessThan(12)
    }
  })
})

/**
 * THE FOUR IMMOVABLE NUMBERS (charter §2.2, prd-32 ruling 7).
 *
 * "Dark's four numbers do not move." They are asserted by value here, in the
 * file that adds a second theme, because this is the wave that could plausibly
 * have moved them — a light band is very easy to buy by renegotiating the dark
 * one, and the ruling names that as the thing not to do.
 */
describe('dark’s four numbers, unchanged', () => {
  it.each([
    ['RECEDE', RECEDE, 0.3],
    ['CALM_CEILING', CALM_CEILING, 0.78],
    ['ALARM_FLOOR', ALARM_FLOOR, 0.84],
    ['CALM_FLOOR', CALM_FLOOR, 0.15],
  ])('%s is still %s', (_name, actual, expected) => {
    expect(actual).toBe(expected)
  })

  it('is the band dark’s table reports, so the table cannot drift from the budget', () => {
    expect(DARK_PALETTE.band).toEqual({
      carrier: 'luminance',
      floor: CALM_FLOOR,
      calmCeiling: CALM_CEILING,
      // Ruling 4's one door, carried on the band since the frame's budget
      // learned to dispatch on the carrier (#551's consumption wave).
      tipCeiling: TIP_CEILING,
      alarmFloor: ALARM_FLOOR,
      recede: RECEDE,
    })
  })

  it('gives light its own three, beside dark’s rather than out of them', () => {
    // The rejected alternative, refused arithmetically: a light band computed
    // by scaling dark's is an inverted palette wearing a different coat. So the
    // assertion is that no such relationship exists — the two ceilings are not
    // one factor apart, and light's band is not dark's band times anything.
    const factor = PAPER_CALM_CEILING / CALM_CEILING
    expect(PAPER_ALARM_FLOOR).not.toBeCloseTo(ALARM_FLOOR * factor, 3)
    expect(PAPER_CALM_FLOOR).not.toBeCloseTo(CALM_FLOOR * factor, 3)

    // It is still a *band*, which is the part that does transfer: a gap the
    // alarms own, with the calm world under it and a floor under that.
    expect(PAPER_CALM_FLOOR).toBeLessThan(PAPER_CALM_CEILING)
    expect(PAPER_CALM_CEILING).toBeLessThan(PAPER_ALARM_FLOOR)
    expect(LIGHT_PALETTE.band.recede).toBe(RECEDE)
  })

  it("holds ruling 4's tip door open the same width in both worlds: above the calm ceiling, below the alarm floor", () => {
    // Dark: 0.78 / 0.81 / 0.84. Light mirrors the SPACING — the tip closer to
    // the calm ceiling than the alarm floor — not the values. PAPER_TIP_CEILING
    // is an operator item (light-mode plan 2c): pinned so it is a decision, and
    // cheap to move before the light theme ships.
    expect(LIGHT_PALETTE.band.tipCeiling).toBe(PAPER_TIP_CEILING)
    expect(PAPER_TIP_CEILING).toBeGreaterThan(PAPER_CALM_CEILING)
    expect(PAPER_TIP_CEILING).toBeLessThan(PAPER_ALARM_FLOOR)
    expect(TIP_CEILING).toBeGreaterThan(CALM_CEILING)
    expect(TIP_CEILING).toBeLessThan(ALARM_FLOOR)
  })

  it('agrees with luminance on the void, which is why one number served for two ideas', () => {
    // `presence` is the quantity the light band is denominated in, and this is
    // the honest account of its relationship to the number dark's four are in:
    // on the void the ground is 0.024, so the two agree to within that, and
    // nobody had to name the difference until a second ground existed.
    const groundLuminance = luminance(ink(DARK_PALETTE.ground, 1))
    expect(groundLuminance).toBeLessThan(0.03)
    for (const step of Object.values(DARK_PALETTE.register)) {
      const lit = ink(step, 1)
      expect(Math.abs(presence(lit, DARK_PALETTE.ground) - luminance(lit))).toBeLessThanOrEqual(
        groundLuminance + 1e-9,
      )
    }
    // …and on paper they are not the same quantity at all: they run in
    // opposite directions, which is the entire problem this wave is about.
    const paperPeak = ink(LIGHT_PALETTE.register.peak, 1)
    const paperGround = ink(LIGHT_PALETTE.register.ground, 1)
    expect(presence(paperPeak, LIGHT_PALETTE.ground)).toBeGreaterThan(
      presence(paperGround, LIGHT_PALETTE.ground),
    )
    expect(luminance(paperPeak)).toBeLessThan(luminance(paperGround))
  })
})

/**
 * SEVERITY IS RE-CARRIED, NOT RE-LIT (ruling 7) — and this is the proof rather
 * than the claim.
 *
 * The done-when sentence is "a severity reading in light mode is legible with
 * luminance held constant". So the ladder is read with the luminance channel
 * taken away entirely — {@link carriesSeverity} looks at weight, enclosure and
 * saturation and at nothing else — and light's ladder has to keep climbing.
 *
 * The failing half is what makes the passing half mean anything, and here it is
 * *dark's own ladder*: run through the same luminance-blind reading, it stops
 * climbing at two of its three steps, because on the void those steps are
 * bought with brightness and with the alarm grammar's exemptions. That is not a
 * defect in dark. It is the finding — it is precisely why the encoding could
 * not be carried across, and a suite that only ever showed light passing would
 * not have established it.
 */
describe('severity, read with luminance taken away', () => {
  const pairs = SEVERITY_LADDER.slice(1).map(
    (rank, index) => [SEVERITY_LADDER[index] as LadderRank, rank] as const,
  )

  it.each(pairs)('climbs from %s to %s on paper, on channels brightness is not', (lower, higher) => {
    const from = LIGHT_PALETTE.severity[lower]
    const to = LIGHT_PALETTE.severity[higher]
    expect(carriesSeverity(from, to), `${lower} → ${higher} carries nothing a flat reader can see`).toBe(true)
    // Named individually, because "at least one channel rose" would pass on a
    // ladder that only ever thickened its stroke — and ruling 7 names three.
    expect(to.weight).toBeGreaterThan(from.weight)
    expect(to.saturation).toBeGreaterThan(from.saturation)
    expect(to.enclosure).toBeGreaterThanOrEqual(from.enclosure)
  })

  it('holds every rung at one luminance and still reads the ladder', () => {
    // The done-when sentence, literally: every rung re-emitted at exactly the
    // same luminance, so nothing about brightness can be carrying the reading,
    // and the ladder still climbs.
    const flat = SEVERITY_LADDER.map((rank) => flatten(LIGHT_PALETTE.severity[rank], 0.2))
    for (const reading of flat) expect(luminance(reading)).toBeCloseTo(0.2, 9)
    for (let i = 1; i < flat.length; i += 1) {
      expect(
        carriesSeverity(flat[i - 1] as SeverityReading, flat[i] as SeverityReading),
        `${SEVERITY_LADDER[i - 1]} → ${SEVERITY_LADDER[i]} collapsed once luminance was held`,
      ).toBe(true)
    }
  })

  it('does not survive the same flattening on the void — which is the finding', () => {
    // Dark's ladder, read the same way. `calm → notice` and `needs-you →
    // broken` both stop dead: the first is bought purely with luminance, and
    // the second with the alarm grammar's exemptions (spotlight, fade
    // exemption) rather than with anything a flat reader can see. Two of three.
    const collapsed = pairs.filter(
      ([lower, higher]) => !carriesSeverity(DARK_PALETTE.severity[lower], DARK_PALETTE.severity[higher]),
    )
    expect(collapsed.map(([lower, higher]) => `${lower} → ${higher}`)).toEqual([
      'calm → notice',
      'needs-you → broken',
    ])
    // And the reason, stated: dark climbs in luminance where light does not.
    expect(luminance(DARK_PALETTE.severity.notice)).toBeGreaterThan(
      luminance(DARK_PALETTE.severity.calm),
    )
  })

  it('would rank a dead lane below a notice, if it still read brightness', () => {
    // The trap, measured at the shipped light values. Brightness on paper
    // orders the ladder *wrongly*, not merely weakly: the worst rung is dimmer
    // than the mildest alarm, and it sits within a thousandth of a calm
    // thread's luminance — indistinguishable. A reader who kept the void's
    // encoding would put the dying lane at the bottom.
    const lit = (rank: LadderRank): number => luminance(LIGHT_PALETTE.severity[rank])
    expect(lit('broken')).toBeLessThan(lit('notice'))
    expect(lit('broken')).toBeLessThan(lit('needs-you'))
    expect(Math.abs(lit('broken') - lit('calm'))).toBeLessThan(0.01)
    // The brightest rung on paper is a *notice* — the one rung that means
    // "nobody is needed yet". That is the inversion, named.
    const brightest = [...SEVERITY_LADDER].sort((a, b) => lit(b) - lit(a))[0]
    expect(brightest).toBe('notice')

    // …and in presence, which is what the light band is denominated in, the
    // ladder is monotone, worst last, exactly as it should be.
    let departure = -1
    for (const rank of SEVERITY_LADDER) {
      const here = presence(LIGHT_PALETTE.severity[rank], LIGHT_PALETTE.ground)
      expect(here, `${rank} did not out-present the rung below it`).toBeGreaterThan(departure)
      departure = here
    }
  })

  it('gives BROKEN the cartouche and the weight the void gave it as luminance', () => {
    // Ruling 7's own sentence, as arithmetic. On the void BROKEN is *exempt*
    // from ALARM_FLOOR — `#ff3d68` only reaches 0.84 by being mixed two-thirds
    // to white, at which point it is pink — so it buys supremacy with the
    // spotlight, the cartouche and the fade exemption. On paper a dark red is
    // the most present thing on the page by construction, so it needs no
    // exemption at all: it clears the alarm floor outright, and gains weight
    // and a full enclosure on top.
    expect(luminance(ink(BROKEN, 1))).toBeLessThan(ALARM_FLOOR)
    const broken = LIGHT_PALETTE.severity.broken
    expect(presence(broken, LIGHT_PALETTE.ground)).toBeGreaterThanOrEqual(PAPER_ALARM_FLOOR)
    expect(broken.enclosure).toBe(1)
    expect(broken.weight).toBeGreaterThan(LIGHT_PALETTE.severity['needs-you'].weight)
  })

  it('needs an emphatic end on paper for the same reason the void needs an incandescent one', () => {
    // The exact mirror of `incandescent`, and it exists for the same measured
    // reason: the raw family hue does not reach its own theme's alarm floor.
    const raw = ink(LIGHT_PALETTE.status.needsYou, 1)
    expect(presence(raw, LIGHT_PALETTE.ground)).toBeLessThan(PAPER_ALARM_FLOOR)
    const lifted = ink(emphatic(LIGHT_PALETTE.status.needsYou), 1)
    expect(presence(lifted, LIGHT_PALETTE.ground)).toBeGreaterThanOrEqual(PAPER_ALARM_FLOOR)
    // Still amber, not a brown nothing: it stays in its own family, exactly as
    // `incandescent(NEEDS_YOU)` stays in its.
    expect(hueGap(emphatic(LIGHT_PALETTE.status.needsYou), LIGHT_PALETTE.status.needsYou)).toBeLessThan(15)
    // And the summons the light table ships *is* that lift, rather than a hex
    // that happens to look similar.
    expect(LIGHT_PALETTE.severity['needs-you'].rgb).toEqual(emphatic(LIGHT_PALETTE.status.needsYou))
  })
})

/** A reading re-emitted at exactly `target` luminance, everything else held. */
function flatten(reading: SeverityReading, target: number): SeverityReading {
  const full = luminance(ink(reading.rgb, 1))
  return { ...reading, alpha: target / full }
}

describe('the calm world on paper, swept through its own band', () => {
  it('keeps every activity inside the light band, at every freshness and heat', () => {
    // The light twin of the `CALM_FLOOR` sweep above, in the quantity the light
    // band is denominated in. The floor is `activityInkOn`'s own promise; the
    // ceiling is the budget's, so it is asserted on the capped pair — which is
    // also the only combination a light scene would ever paint.
    for (const activity of Object.keys(LIGHT_PALETTE.activity) as (keyof typeof LIGHT_PALETTE.activity)[]) {
      for (const freshness of [0, 0.5, 1]) {
        for (const heat of [0, 0.5, 1]) {
          const raw = activityInkOn(LIGHT_PALETTE, activity, freshness, heat)
          const where = `${activity} at f=${freshness} h=${heat}`
          expect(presence(raw, LIGHT_PALETTE.ground), `${where} left no mark on the page`)
            .toBeGreaterThan(PAPER_CALM_FLOOR)
          expect(
            presence(capPresence(raw, LIGHT_PALETTE.ground, PAPER_CALM_CEILING), LIGHT_PALETTE.ground),
            `${where} broke into the alarm band`,
          ).toBeLessThanOrEqual(PAPER_CALM_CEILING + 1e-9)
        }
      }
    }
  })

  it('has a ceiling that genuinely binds, rather than one nothing reaches', () => {
    // The half that makes the sweep worth running: the ramp overshoots on paper
    // exactly as it does on the void, and the cap is what holds it.
    const hottest = activityInkOn(LIGHT_PALETTE, 'working', 1, 1)
    expect(presence(hottest, LIGHT_PALETTE.ground)).toBeGreaterThan(PAPER_CALM_CEILING)
    expect(capPresence(hottest, LIGHT_PALETTE.ground, PAPER_CALM_CEILING).alpha).toBeLessThan(hottest.alpha)
    // …and it only ever scales down, so a cap can never buy a mark presence.
    const quiet = activityInkOn(LIGHT_PALETTE, 'idle', 0, 0)
    expect(capPresence(quiet, LIGHT_PALETTE.ground, PAPER_CALM_CEILING)).toBe(quiet)
  })

  it('starts a resting thread at its own theme’s body floor', () => {
    expect(activityInkOn(LIGHT_PALETTE, 'working', 0, 0).alpha).toBe(PAPER_BODY_FLOOR)
    expect(PAPER_BODY_FLOOR).toBeLessThan(CALM_BODY_FLOOR)
  })

  it('reads as its own family on paper too, at every freshness', () => {
    // The layman bar, restated for the ground it is now on. A working lane's
    // ink is green-dominant whatever else is going on with it — which on paper
    // means the green channel still leads after the tint, even though every
    // channel is much darker than it is on the void.
    for (const freshness of [0, 0.5, 1]) {
      for (const heat of [0, 1]) {
        const working = activityInkOn(LIGHT_PALETTE, 'working', freshness, heat)
        expect(working.rgb[1], `working at f=${freshness} h=${heat} was not green`).toBeGreaterThan(
          Math.max(working.rgb[0], working.rgb[2]),
        )
      }
    }
  })

  it('keeps nothing-to-say quieter than idle in both worlds', () => {
    // The original law is written in luminance — "unknown is dimmer than idle"
    // — and it inverts on paper, where quieter means *less ink*. In presence it
    // is the same sentence in both worlds, which is the phrasing that should
    // have been there all along.
    for (const theme of THEMES) {
      const palette = paletteFor(theme.name as ThemeName)
      expect(
        presence(ink(palette.activity.unknown, 1), palette.ground),
        `${theme.name} gave unknown more presence than idle`,
      ).toBeLessThan(presence(ink(palette.activity.idle, 1), palette.ground))
    }
  })

  it('is the same function dark has always used, byte for byte', () => {
    // `activityInkOn` is a widening of `activityInk`, not a rewrite, and this is
    // what makes that a fact rather than an intention: every mark in `marks/`
    // still calls the original, so any divergence would be a light table that
    // quietly repainted the void.
    for (const activity of Object.keys(ACTIVITY_HUE) as (keyof typeof ACTIVITY_HUE)[]) {
      for (const freshness of [0, 0.25, 0.5, 0.75, 1]) {
        for (const heat of [0, 0.5, 1]) {
          expect(activityInkOn(DARK_PALETTE, activity, freshness, heat)).toEqual(
            activityInk(activity, freshness, heat),
          )
        }
      }
    }
  })
})

/**
 * THE MIRROR'S OTHER THREE CONSTANTS (prd-32 wave 1).
 *
 * The colour half of this file has existed since prd4. Everything below is the
 * same argument applied to the three places a theme value is repeated as a
 * literal *outside* the palette — each one a constant whose comment already
 * claimed to match a token, with nothing checking that it did:
 *
 *   - `paint.ts`'s FONT record. Canvas takes a string, not a custom property.
 *   - `BREATH_PERIOD_MS` and `SETTLE_MS`, whose doc comments say "Matches
 *     `--duration-breath` / `--duration-settle` in the theme" in so many words.
 *   - `FALLBACK_HUE`, the two hexes a favicon needs because a rasterised data
 *     URI is generated outside the CSS cascade.
 *
 * Two of the four were *already wrong* when the mirror was written, which is
 * the argument for the mirror rather than a coincidence: the canvas sans stack
 * did not name Inter at all, and its mono stack listed JetBrains Mono fourth,
 * behind `ui-monospace`. The DOM would have started rendering in the real faces
 * this week and the scene would have gone on painting in the system ones.
 */
describe('the type stacks, mirrored for canvas (prd-32 ruling 1)', () => {
  it.each([
    ['sans', '--font-sans'],
    ['mono', '--font-mono'],
  ])('paints %s in exactly the stack the theme names', (face, token) => {
    expect(FONT[face as keyof typeof FONT]).toBe(raw(token))
  })

  it('leads both stacks with a face the app actually ships', () => {
    // The half a string comparison alone would not catch: two identical stacks
    // that both name a font nobody installed. `tokens.test.ts` holds the theme
    // side to the installed packages' own family names; this holds the canvas
    // to the theme, so the chain reaches from the woff2 on disk to `ctx.font`.
    expect(FONT.sans.startsWith("'Inter Variable'")).toBe(true)
    expect(FONT.mono.startsWith("'JetBrains Mono Variable'")).toBe(true)
  })
})

describe('the durations, mirrored for the scene (prd-32 ruling 1)', () => {
  it.each([
    ['BREATH_PERIOD_MS', BREATH_PERIOD_MS, '--duration-breath'],
    ['SETTLE_MS', SETTLE_MS, '--duration-settle'],
  ])('%s is still its token', (_name, value, token) => {
    expect(`${value}ms`).toBe(raw(token as string))
  })
})

describe('the favicon hues, mirrored out of the cascade (prd-32 ruling 3)', () => {
  it.each([
    ['needs-you', 'needs-you'],
    ['broken', 'broken'],
  ])('%s still equals its theme token', (key) => {
    // The last two unpinned hexes in the instrument. A favicon is not something
    // anybody looks at while retuning a hue, so this is exactly the constant
    // that drifts — and drifts invisibly, because the fallback only shows on a
    // surface where `getComputedStyle` returned nothing.
    expect(FALLBACK_HUE[key as keyof typeof FALLBACK_HUE].toLowerCase()).toBe(
      raw(`--color-${key}`).toLowerCase(),
    )
  })
})

/**
 * HUE ANGLES — the arithmetic law 9a is actually about.
 *
 * "Green means productive, amber means blocked, red means broken" is only true
 * if the six hues sit where the map says they sit, and *stay* there. Measured in
 * OKLCH rather than HSL because these are claims about what a reader perceives:
 * HSL puts `done` and `notice` 29° apart while the eye reads them as a clear
 * green and a clear cyan, and a law that fails on a colour nobody confuses is a
 * law that gets deleted. Oklab is also the space `theme.css` already mixes in.
 */
describe('the semantic map, as angles', () => {
  it('makes each family one hue at two brightnesses', () => {
    // Working and done are the same green; the reader is told "still going" vs
    // "finished" by brightness, hollowness and the seal — never by a new colour.
    expect(hueGap(WORKING, DONE)).toBeLessThan(15)
    expect(luminance(ink(WORKING, 1))).toBeGreaterThan(luminance(ink(DONE, 1)))

    // Same for the amber family, which is the load-bearing half of ruling 3:
    // benign waiting is the muted end of the summons, not a different signal.
    expect(hueGap(WAITING_BENIGN, NEEDS_YOU)).toBeLessThan(10)
    expect(luminance(ink(WAITING_BENIGN, 1))).toBeLessThan(luminance(ink(NEEDS_YOU, 1)))
  })

  it('keeps the green family clear of the cyan that means notice', () => {
    // The one confusion the green family could plausibly cause: a teal that
    // reads as "something changed" when it means "this lane is fine".
    for (const green of [WORKING, DONE]) {
      expect(hueGap(green, NOTICE)).toBeGreaterThan(30)
    }
  })

  it('lets nothing else near the red that means broken (law 9a)', () => {
    // Red only ever means broken. Nothing may be close enough to borrow it.
    for (const [name, hue] of STATUS_HUES) {
      if (hue === BROKEN) continue
      expect(hueGap(hue, BROKEN), `${name} is too close to broken`).toBeGreaterThan(30)
    }
  })
})

/**
 * THE ACCENT (prd10 rulings 5, 11 and 12) — the arithmetic that makes it safe.
 *
 * Ruling 29 bought salience by forbidding the calm world colour at all; prd4
 * replaced that with the brightness band, and prd10 opens the door a hair for
 * organic tissue. An accent is exactly the sort of amendment that erodes a colour
 * law by degrees, so the ruling states its safety in numbers — 41° clear of ice,
 * 87° from notice-cyan, 78° from broken-red — and this is where those numbers stop
 * being a document.
 *
 * The *permission* half of the ruling ("only in scene tissue draws, never text,
 * never status, never chrome") cannot be checked here, because it is a claim about
 * where the colour is used rather than about the colour. It is checked in
 * `marks.test.ts`, over the display list and over this repo's own source.
 */
describe('the tissue accent, as angles', () => {
  it('sits where ruling 11 says it sits, and nowhere near a status hue', () => {
    // The accent proper. The ruling's own measurements, restated as assertions —
    // and the tolerances are tight, because a hue that drifted 20° toward ice
    // would stop being a distinguishable material and start being cold chrome.
    expect(oklabHue(TISSUE_400)).toBeCloseTo(295.5, 0)

    // Clear of the ice ramp: tissue is a *material*, ice is structure, and a
    // viewer has to be able to tell the mass's depths from its own chrome.
    for (const ice of RAMP) {
      // The two darkest steps of the ramp are nearly black, where a hue angle is
      // meaningless — the void has no colour to be far from.
      if (luminance(ink(ice, 1)) < 0.1) continue
      expect(hueGap(TISSUE_400, ice), `the accent drifted into the ice ramp`).toBeGreaterThan(30)
    }

    // …and clear of every status hue by a wide margin, which is the half that
    // matters for law 9a: a mote must never be mistakable for a state.
    for (const [name, hue] of STATUS_HUES) {
      expect(hueGap(TISSUE_400, hue), `the accent is too close to ${name}`).toBeGreaterThan(60)
    }
  })

  it('is one hue at five luminances, like every other ramp in the instrument', () => {
    // "Neon is luminance, not saturation" (ruling 29's surviving half) applies to
    // the accent as much as to ice: five steps, monotone in brightness, one hue.
    const brightness = TISSUE_RAMP.map((rgb) => luminance(ink(rgb, 1)))
    for (let i = 1; i < brightness.length; i += 1) {
      expect(brightness[i]).toBeGreaterThan(brightness[i - 1] as number)
    }
    for (const step of TISSUE_RAMP) expect(hueGap(step, TISSUE_400)).toBeLessThan(12)
  })

  it('is below the text floor by design — because tissue is never ink', () => {
    // The legibility law (prd9's operator ruling: nothing dimmer than `ice-400`)
    // is untouched rather than bent, and this is the arithmetic form of that
    // claim: every step of the ramp is dimmer than the floor, so a hand that
    // reached for tissue as a text colour would be reaching below the floor and
    // the existing law would catch it.
    const floor = luminance(ink(ICE_400, 1))
    for (const step of TISSUE_RAMP) {
      expect(luminance(ink(step, 1)), 'a tissue step is bright enough to be mistaken for ink')
        .toBeLessThan(floor)
    }
  })

  it('samples the ramp as a gradient rather than as five choices', () => {
    expect(tissueAt(0)).toEqual(TISSUE_900)
    expect(tissueAt(1)).toEqual(TISSUE_200)
    // Monotone and continuous in between: the cooling gradient ruling 12 asks for
    // is a *travel* through the ramp, so a step in it would be a mote changing
    // colour in a jump nobody's substance does.
    let previous = -1
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const here = luminance(ink(tissueAt(t), 1))
      expect(here).toBeGreaterThan(previous)
      previous = here
    }
  })

  it('carries a lane home from its own family into the accent (ruling 12)', () => {
    // The composting story told in colour, as one function. At the cut a mote is
    // its lane's substance and reads as green; at the heart it is tissue. Both
    // ends are assertions about *hue*, because that is what the ruling is about —
    // status meaning at the cut, tissue meaning at home.
    const born = returningInk(DONE, 0, 0.6)
    const home = returningInk(DONE, 1, 0.6)
    expect(hueGap(born.rgb, DONE), 'a mote is not born its lane own colour').toBeLessThan(12)
    expect(hueGap(home.rgb, TISSUE_400), 'a mote did not cool into the accent').toBeLessThan(30)

    // …and it is a crossfade rather than a switch: the middle belongs to neither.
    const middle = returningInk(DONE, 0.5, 0.6)
    expect(hueGap(middle.rgb, DONE)).toBeGreaterThan(hueGap(born.rgb, DONE))
    expect(hueGap(middle.rgb, TISSUE_400)).toBeGreaterThan(hueGap(home.rgb, TISSUE_400))

    // Never brighter than it was asked for: the luminance is the caller's, so a
    // mote cannot smuggle brightness in through the gradient.
    for (const journey of [0, 0.25, 0.5, 0.75, 1]) {
      expect(returningInk(DONE, journey, 0.6).alpha).toBeCloseTo(0.6, 10)
    }
  })
})

/**
 * THE SHIMMER (prd10 ruling 6) — ±3%, and the bound is the whole of it.
 *
 * An iridescence that crept past the ambient ceiling would stop being ignorable and
 * start costing the attention the periphery is supposed to save; one that touched a
 * hue would be a lane whose *state* wobbled. Both are pinned here rather than at the
 * mark that spends it, because the bound belongs to the channel table.
 */
describe('the per-thread shimmer', () => {
  it('stays inside the channel table cap, at every phase and for every lane', () => {
    expect(SHIMMER_MAX).toBe(CHANNELS.shimmer.limit)
    expect(SHIMMER_MAX).toBeLessThanOrEqual(AMBIENT.maxAmplitude)
    expect(SHIMMER_PERIOD_MS).toBeGreaterThanOrEqual(AMBIENT.minPeriodMs)
    expect(SHIMMER_PERIOD_MS).toBeLessThanOrEqual(AMBIENT.maxPeriodMs)

    for (const seed of ['113-ribbons', '114-contour', 'a', 'main', '144-gorgeous-scene']) {
      const habit = variationFor(seed)
      for (let phase = 0; phase < 4; phase += 0.017) {
        expect(Math.abs(habit.shimmer(phase) - 1), `${seed} shimmered past the cap`)
          .toBeLessThanOrEqual(SHIMMER_MAX + 1e-12)
      }
    }
  })

  it('puts two lanes out of phase, so the fleet has no single pulse in it', () => {
    // The failure this prevents is specific: one shared phase would make twenty
    // threads brighten together, which is a scene-wide pulse — a thing a viewer
    // notices, and therefore not ambient at all.
    const a = variationFor('113-ribbons')
    const b = variationFor('114-contour')
    const apart = Array.from({ length: 40 }, (_unused, i) => Math.abs(a.shimmer(i / 40) - b.shimmer(i / 40)))
    expect(Math.max(...apart)).toBeGreaterThan(SHIMMER_MAX * 0.5)
  })

  it('is the same shimmer in a replay as in the session that recorded it', () => {
    // Seeded off the lane, never off the clock: the property every visual channel
    // in this scene has, restated for the one that is a function of time.
    const fresh = variationFor('144-gorgeous-scene')
    for (const phase of [0, 0.3, 1.7, 99.4]) {
      expect(fresh.shimmer(phase)).toBe(variationFor('144-gorgeous-scene').shimmer(phase))
    }
  })
})

describe('the activity chokepoint', () => {
  it('gives every activity a hue, and only idle and unknown a structural one', () => {
    expect(ACTIVITY_HUE.working).toEqual(WORKING)
    expect(ACTIVITY_HUE.done).toEqual(DONE)
    expect(ACTIVITY_HUE.waiting).toEqual(WAITING_BENIGN)
    // Nothing to say is structure: idle and unknown stay in the ramp, so a lane
    // the log has never mentioned cannot borrow a status hue's confidence.
    expect(RAMP).toContainEqual(ACTIVITY_HUE.idle)
    expect(RAMP).toContainEqual(ACTIVITY_HUE.unknown)
    expect(luminance(ink(ACTIVITY_HUE.unknown, 1))).toBeLessThan(
      luminance(ink(ACTIVITY_HUE.idle, 1)),
    )
  })

  it('keeps every activity inside the calm band, at every freshness (CALM_FLOOR)', () => {
    // The floor is checked against the twenty-lane fixture in `marks.test.ts`,
    // but that fixture is entirely `working` — so the states nothing stages
    // (idle, unknown, a lane merely stopped) would go unpinned. This sweeps the
    // ramp itself: no activity may be too dark to read, and none may claim the
    // band the alarms own, whatever its age or heat.
    //
    // The floor is this function's own promise, so it is asserted on the raw
    // ink. The ceiling is the budget's — a maximally fresh, maximally hot green
    // thread does reach past 0.78 before `spend` sees it, and `spend` capping it
    // is the mechanism, not a leak — so it is asserted on the pair, which is
    // also the only combination the scene ever paints.
    const calm = { spotlightId: null, hoverId: null }

    for (const activity of Object.keys(ACTIVITY_HUE) as (keyof typeof ACTIVITY_HUE)[]) {
      for (const freshness of [0, 0.5, 1]) {
        for (const heat of [0, 0.5, 1]) {
          const raw = activityInk(activity, freshness, heat)
          const where = `${activity} at f=${freshness} h=${heat}`
          expect(luminance(raw), `${where} was too dark to read`).toBeGreaterThan(CALM_FLOOR)
          expect(
            luminance(spend(raw, calm, 'a-lane', false)),
            `${where} broke into the alarm band`,
          ).toBeLessThanOrEqual(CALM_CEILING + 1e-9)
        }
      }
    }
  })

  it('reads as its own family at every freshness, and never leaves the calm band', () => {
    for (const freshness of [0, 0.5, 1]) {
      for (const heat of [0, 1]) {
        const working = activityInk('working', freshness, heat)
        // Guessability: a working lane's ink is green-dominant, whatever else
        // is going on with it. This is the layman bar as arithmetic.
        expect(working.rgb[1], `working at f=${freshness} h=${heat} was not green`).toBeGreaterThan(
          Math.max(working.rgb[0], working.rgb[2]),
        )
      }
    }

    // Done is the dimmer end of the same family: still recognisably green, and
    // quieter than a lane that is still going. (The hue-angle law is asserted on
    // the tokens themselves above; these are tints of the ice ramp, so their
    // angles carry the ramp's blue as well as the family's green.)
    const live = activityInk('working', 1, 0)
    const landed = activityInk('done', 1, 0)
    expect(landed.rgb[1]).toBeGreaterThan(Math.max(landed.rgb[0], landed.rgb[2]))
    expect(luminance(landed)).toBeLessThan(luminance(live))
  })

  it('runs a summons up into the band the alarms own (law 9b)', () => {
    // Why `incandescent` has to exist at all: amber at full strength is only
    // ~0.80, which is not enough daylight over a green fleet at the ceiling. So
    // the summons is lifted toward the ramp's white until it clears ALARM_FLOOR.
    expect(luminance(ink(NEEDS_YOU, 1))).toBeLessThan(ALARM_FLOOR)
    expect(luminance(ink(incandescent(NEEDS_YOU), 1))).toBeGreaterThan(ALARM_FLOOR)
    // Still amber, not a pale nothing: it stays in its own family.
    expect(hueGap(incandescent(NEEDS_YOU), NEEDS_YOU)).toBeLessThan(15)
  })
})

describe('the arithmetic the contrast budget is spent in', () => {
  it('counts alpha as part of brightness', () => {
    expect(luminance(ink(ICE_050, 0.5))).toBeCloseTo(luminance(ink(ICE_050, 1)) / 2, 10)
  })

  it('mixes and clamps without leaving the byte range', () => {
    expect(mix(ICE_1000, ICE_050, 0.5)).toEqual([122, 126, 132])
    expect(mix(ICE_1000, ICE_050, 5)).toEqual(ICE_050)
    expect(ink(ICE_200, 4).alpha).toBe(1)
    expect(ink(ICE_200, -1).alpha).toBe(0)
  })

  it('writes a canvas colour a browser will accept', () => {
    expect(cssColour(ink(NEEDS_YOU, 0.5))).toBe('rgba(255, 200, 87, 0.500)')
  })
})

/** The shorter way round the colour wheel between two hues, in degrees. */
function hueGap(a: Rgb, b: Rgb): number {
  const gap = Math.abs(oklabHue(a) - oklabHue(b)) % 360
  return Math.min(gap, 360 - gap)
}

/**
 * A colour's hue angle in OKLCH. Written out here rather than pulled in as a
 * dependency: it is eleven lines of published matrix arithmetic, and the laws
 * above are worth more if the number they turn on is inspectable.
 */
function oklabHue(rgb: Rgb): number {
  const [r, g, b] = rgb.map(linear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
}

/** sRGB byte → linear-light, the gamma decode OKLab is defined on. */
function linear(byte: number): number {
  const c = byte / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * THE VIBRANCY DIALS (#157) — and the property that makes all of them safe.
 *
 * The operator asked for more vibrancy and the band the alarms own is six
 * hundredths of luminance wide. Both of those can be true at once for exactly one
 * reason: **`luminance` is a weighted mean of the three channels, so chroma is
 * free.** Swing a colour away from its own grey and the number the contrast
 * budget is denominated in does not move at all.
 *
 * That is what this suite pins. Not the values of the dials — those are taste, and
 * a future round will retune them — but the invariant that lets them be turned:
 * every hundredth of vibrancy this round bought came out of chroma or out of the
 * *floor*, and none of it came out of the alarms' band.
 */
describe('the vibrancy dials, and the ceiling they do not touch (#157)', () => {
  /** How far a colour is from grey, in the crude units a byte triple has. */
  const chromaOf = (rgb: Rgb): number => Math.max(...rgb) - Math.min(...rgb)

  it('saturates without moving the number the budget is spent in', () => {
    // The whole justification for the chroma dial, as one assertion. `saturate`
    // pivots on the luminance weighting itself, so a mark can be made visibly more
    // itself without spending a hundredth against `CALM_CEILING`.
    for (const hue of [WORKING, DONE, WAITING_BENIGN, NOTICE, TISSUE_400]) {
      const richer = saturate(hue, 1.4)
      const before = luminance(ink(hue, 1))
      const after = luminance(ink(richer, 1))
      expect(chromaOf(richer)).toBeGreaterThan(chromaOf(hue))

      // The direction is the load-bearing half, and it is exact rather than
      // approximate: the pivot *is* the luminance weighting, so the only thing
      // that can move the mean is a channel hitting the edge of the byte range —
      // and a clamp can only pull a channel back toward grey. Saturating is
      // therefore never a way to buy brightness the budget did not grant.
      expect(after, `${cssColour(ink(hue, 1))} gained luminance`).toBeLessThanOrEqual(
        before + 1 / 255,
      )
      // …and it does not quietly cost much either: a cyan whose blue clips loses
      // about a hundredth, which is under a fifth of the alarm band.
      expect(after).toBeGreaterThan(before - 0.02)
    }
  })

  it('keeps a saturated colour in its own family and in the byte range', () => {
    // A gain, not a mix: hue survives because all three channels move along one
    // ray from the grey point, and the bytes clamp rather than wrapping.
    expect(hueGap(saturate(WORKING, 1.4), WORKING)).toBeLessThan(12)
    for (const byte of saturate(NEEDS_YOU, 6)) {
      expect(byte).toBeGreaterThanOrEqual(0)
      expect(byte).toBeLessThanOrEqual(255)
    }
    // Below 1 walks toward grey, which is what makes it a dial and not a switch.
    expect(chromaOf(saturate(WORKING, 0.5))).toBeLessThan(chromaOf(WORKING))
    expect(saturate(WORKING, 1)).toEqual(WORKING)
  })

  it('raises the calm world from its floor, not from its ceiling', () => {
    // The floor moved (this is the "richer thread body" half) and the ceiling did
    // not: a thread with nothing going on at all is drawn at `CALM_BODY_FLOOR`,
    // and a maximally fresh, maximally hot one is still held at `CALM_CEILING` by
    // the budget exactly as it was before the dial existed.
    expect(activityInk('working', 0, 0).alpha).toBe(CALM_BODY_FLOOR)
    expect(CALM_BODY_FLOOR).toBeGreaterThan(CALM_FLOOR)
    expect(CALM_BODY_FLOOR).toBeLessThan(1)

    const calm = { spotlightId: null, hoverId: null }
    const hottest = spend(activityInk('working', 1, 1), calm, 'a-lane', false)
    expect(luminance(hottest)).toBeLessThanOrEqual(CALM_CEILING + 1e-9)
    // …and the ceiling is genuinely binding, which is what makes the sentence
    // above worth writing: the ramp overshoots and `spend` is what holds it.
    expect(luminance(activityInk('working', 1, 1))).toBeGreaterThan(CALM_CEILING)
  })

  it('wears more of its family than the ice it is mixed into, at every activity', () => {
    // The chroma half, and the layman bar it is for: a stranger has to be able to
    // guess "green means productive" off the thread body alone. Each living family
    // keeps most of its own chroma after the tint, rather than most of the ramp's.
    const families = { working: WORKING, waiting: WAITING_BENIGN, done: DONE } as const
    for (const [activity, hue] of Object.entries(families)) {
      const drawn = activityInk(activity as keyof typeof families, 1, 0)
      expect(chromaOf(drawn.rgb), `${activity} read as ice`).toBeGreaterThan(chromaOf(hue) * 0.35)
    }
  })

  it('keeps an apical tuft vivid rather than washed out', () => {
    // `TUFT_WASH` is the wash toward white a growing tip starts from. Small, and
    // the assertion is what "small" has to mean: the branchlet keeps most of its
    // family's chroma, and still sits under the calm ceiling at full opacity —
    // which is the amendment's own bound, untouched by this dial.
    const vivid = hotter(WORKING, TUFT_WASH)
    expect(chromaOf(vivid)).toBeGreaterThan(chromaOf(WORKING) * 0.7)
    expect(luminance(ink(vivid, 1))).toBeLessThanOrEqual(CALM_CEILING)
    // …and it is a real wash rather than a no-op: the apex is still hotter than
    // the family colour a resting mark wears.
    expect(TUFT_WASH).toBeGreaterThan(0)
    expect(luminance(ink(vivid, 1))).toBeGreaterThan(luminance(ink(WORKING, 1)))
  })

  it('lifts an ambient ink in both channels, and a veil in neither', () => {
    const spore: Ink = ink(TISSUE_400, 0.2)
    const lifted = ambientLift(spore, REPLAY_VIBRANCY)
    expect(lifted.alpha).toBeGreaterThan(spore.alpha)
    expect(chromaOf(lifted.rgb)).toBeGreaterThan(chromaOf(spore.rgb))

    const veil: Ink = ink(TISSUE_900, 0.28)
    const relaxed = ambientVeil(veil, REPLAY_VIBRANCY)
    expect(relaxed.alpha).toBeLessThan(veil.alpha)
    // A veil is not tinted on its way out of the picture's way.
    expect(relaxed.rgb).toEqual(veil.rgb)

    // Live is exactly the identity, in both directions — which is what makes "the
    // live scene is unchanged by the replay dial" true by construction.
    expect(ambientLift(spore, 1)).toBe(spore)
    expect(ambientVeil(veil, 1)).toBe(veil)
  })
})
