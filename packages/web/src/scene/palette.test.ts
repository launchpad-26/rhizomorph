import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AMBIENT } from './motion.js'
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
  WAITING_BENIGN,
  WORKING,
  activityInk,
  cssColour,
  hotter,
  incandescent,
  ink,
  luminance,
  mix,
  returningInk,
  tissueAt,
  type Rgb,
} from './palette.js'
import { ALARM_FLOOR, CALM_CEILING, CALM_FLOOR, spend } from './salience.js'

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
