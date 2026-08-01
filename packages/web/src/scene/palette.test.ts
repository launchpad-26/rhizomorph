import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
  WAITING_BENIGN,
  WORKING,
  activityInk,
  cssColour,
  hotter,
  incandescent,
  ink,
  luminance,
  mix,
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
