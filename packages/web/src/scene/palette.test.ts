import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BROKEN,
  ICE_050,
  ICE_1000,
  ICE_200,
  ICE_400,
  ICE_700,
  ICE_950,
  NECROTIC,
  NEEDS_YOU,
  NOTICE,
  cssColour,
  hotter,
  ink,
  luminance,
  mix,
  type Rgb,
} from './palette.js'

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

describe('the ice-neon register, mirrored for canvas', () => {
  it.each([
    ['ice-1000', ICE_1000],
    ['ice-950', ICE_950],
    ['ice-700', ICE_700],
    ['ice-400', ICE_400],
    ['ice-200', ICE_200],
    ['ice-050', ICE_050],
    ['notice', NOTICE],
    ['needs-you', NEEDS_YOU],
    ['broken', BROKEN],
    ['necrotic', NECROTIC],
  ])('%s still equals its theme token', (name, value) => {
    expect(value).toEqual(token(name))
  })

  it('builds the calm world out of one hue at several luminances (ruling 29)', () => {
    // "Neon is luminance, not saturation": the ice ramp must be monotonic in
    // brightness and share a hue, or the scene stops being one world.
    const ramp = [ICE_1000, ICE_950, ICE_700, ICE_400, ICE_200, ICE_050]
    const brightness = ramp.map((rgb) => luminance(ink(rgb, 1)))
    for (let i = 1; i < brightness.length; i += 1) {
      expect(brightness[i]).toBeGreaterThan(brightness[i - 1] as number)
    }
    // Cold: every step has more blue than red.
    for (const [r, , b] of ramp) expect(b).toBeGreaterThan(r)
  })

  it('reaches its white through the ramp, never through #ffffff', () => {
    // The brightest thing on screen still belongs to the palette — which is why
    // a blown-out EXPENSIVE thread reads as the same world as the chrome.
    expect(hotter(ICE_200, 1)).toEqual(ICE_050)
    expect(ICE_050).not.toEqual([255, 255, 255])
  })

  it('keeps the ladder hues out of the calm ramp (law 9)', () => {
    const calm = [ICE_1000, ICE_950, ICE_700, ICE_400, ICE_200, ICE_050]
    for (const hue of [NOTICE, NEEDS_YOU, BROKEN]) {
      expect(calm).not.toContainEqual(hue)
    }
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
