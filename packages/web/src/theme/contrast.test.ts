import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BODY_TEXT_MINIMUM, contrastRatio } from './contrast.js'
import { rgbFromHex, type Rgb } from './oklch.js'
import { resolve, themesOf, type Theme } from './tokens.js'

/**
 * THE CONTRAST LAW (prd-32 ruling 3, ruling 9, S2 acceptance).
 *
 * prd-32's third success criterion: *contrast is a calculation.* "Not met while
 * the documented ratios exist only as prose, or a token edit can cross the
 * legibility floor without a red suite — in either theme."
 *
 * The prose being replaced is prd9's operator ruling, which has sat in
 * `theme.css` since 2026-08-03: text may not wear anything dimmer than
 * `ice-400` (5.1:1 against the `ice-1000` floor); `ice-500` and `ice-600`
 * measure 3.3:1 and 2.4:1, under WCAG's 4.5:1 body threshold. Three numbers
 * nothing computed.
 *
 * **Computing them found one of them wrong.** `ice-600` against `ice-1000` is
 * 2.18:1, not 2.4:1 — and not 2.4 against any other ground in the ramp either
 * (`ice-950` 2.11, `ice-900` 2.01, `ice-850` 1.87). The ruling is unharmed: 2.18
 * is *further* below the threshold than 2.4, so "structure and disabled marks,
 * never text" holds harder than it was claimed to. But the figure was wrong for
 * twelve days in the one file every colour decision is made from, and this is
 * the machinery that would have said so on the day it was written.
 *
 * **PER THEME** is ruling 9's word, and the shape of this file rather than a
 * detail of it. Every law below runs over `themesOf(theme.css)` — discovered,
 * not listed. Only dark exists today. When #551 lands `[data-theme='light']`,
 * every assertion here doubles with no edit to this file, and a light-theme
 * regression fails the same suite a dark-theme one does. `the law is already
 * shaped for the theme that does not exist yet` below proves that now, against
 * a synthetic light theme, rather than promising it.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const THEME = readFileSync(path.join(SRC, 'theme', 'theme.css'), 'utf8')

const THEMES = themesOf(THEME)

/** A role token's literal colour, in the theme that is active. */
function colourOf(theme: Theme, token: string): Rgb {
  const literal = resolve(token, theme.tokens)
  expect(literal, `${theme.name} has no ${token}`).toMatch(/^#[0-9a-f]{6}$/i)
  return rgbFromHex(literal as string)
}

/**
 * The grounds text is actually set on. `--surface-line` is deliberately absent:
 * it is an edge, never a plate, and holding ink to a hairline would be asserting
 * a pairing the instrument does not make.
 */
const GROUNDS = ['--surface-floor', '--surface-panel', '--surface-raised'] as const

/**
 * The inks that carry text. `--ink-inverse` is deliberately absent: it is the
 * reversal — ink for a bright plate — so it is measured against `--ink-primary`
 * as its ground, below, rather than against the surfaces it never sits on.
 */
const TEXT_INKS = ['--ink-primary', '--ink-body', '--ink-dim'] as const

describe('every theme the stylesheet declares is covered', () => {
  it('finds dark, and finds it as the unqualified source of truth', () => {
    // Dark is `:root` with no attribute — the theme you get before anybody has
    // chosen one — because prd-32's non-goals say so: "dark remains the source
    // of truth, and role tokens derive from the dark ramp, never beside it".
    expect(THEMES.map((theme) => theme.name)).toContain('dark')
    expect(THEMES[0]?.name).toBe('dark')
  })

  it('holds every theme it finds, so a new one cannot land unpoliced', () => {
    // The discovery is the mechanism. If this ever reads 1 while `theme.css`
    // carries a `[data-theme]` block, the parser has stopped seeing a theme and
    // every law below is quietly running on one world.
    // Comments out first — `theme.css` explains that #551 will add a
    // `[data-theme='light']` block, and a theme that a paragraph *predicts* is
    // not a theme the stylesheet declares.
    const declared = new Set(
      [...THEME.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/\[data-theme\s*=\s*['"]([a-z-]+)['"]\]/gi)].map(
        (m) => m[1] as string,
      ),
    )
    expect(new Set(THEMES.map((t) => t.name))).toEqual(new Set(['dark', ...declared]))
  })
})

describe.each(THEMES)('the legibility floor, computed — $name', (theme) => {
  it.each(TEXT_INKS.flatMap((ink) => GROUNDS.map((ground) => [ink, ground] as const)))(
    '%s on %s clears WCAG body text',
    (ink, ground) => {
      // The floor as arithmetic rather than as an allowlist of class names.
      // `legibility.test.ts` polices which token text may wear; it cannot police
      // what that token measures, because the answer lives in the hexes.
      const ratio = contrastRatio(colourOf(theme, ink), colourOf(theme, ground))
      expect(ratio, `${ink} on ${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        BODY_TEXT_MINIMUM,
      )
    },
  )

  it('reverses legibly too — inverse ink on the brightest plate', () => {
    const ratio = contrastRatio(colourOf(theme, '--ink-inverse'), colourOf(theme, '--ink-primary'))
    expect(ratio).toBeGreaterThanOrEqual(BODY_TEXT_MINIMUM)
  })

  it('keeps the rules below the floor, where a rule belongs', () => {
    // The other direction, and it is a real law rather than a formality: a
    // hairline that measured like body text would be a divider competing with
    // the sentence beside it. Both rules sit under the threshold on every
    // ground, which is what makes them structure.
    for (const rule of ['--line-hair', '--line-strong']) {
      for (const ground of GROUNDS) {
        expect(
          contrastRatio(colourOf(theme, rule), colourOf(theme, ground)),
          `${rule} on ${ground} is bright enough to be mistaken for ink`,
        ).toBeLessThan(BODY_TEXT_MINIMUM)
      }
    }
  })
})

/**
 * THE THREE DOCUMENTED RATIOS — prd9's ruling, finally computed.
 *
 * Dark only, and on purpose: these are claims about the *ice ramp*, which is
 * dark's own register. Light re-derives its band beside it rather than
 * inheriting these numbers (ruling 7), so asserting them per theme would be
 * asserting that light is dark inverted — the alternative prd-32 explicitly
 * rejects.
 */
describe('prd9’s three numbers, as arithmetic', () => {
  const dark = THEMES[0] as Theme
  const floor = colourOf(dark, '--color-ice-1000')

  it.each([
    ['--color-ice-400', 5.13, 'the legibility floor: no text goes dimmer'],
    ['--color-ice-500', 3.3, 'structure and disabled marks, never text'],
    ['--color-ice-600', 2.18, 'structure and disabled marks, never text'],
  ])('%s measures %s:1 against the page floor', (step, expected) => {
    expect(contrastRatio(colourOf(dark, step), floor)).toBeCloseTo(expected, 2)
  })

  it('puts the floor above the threshold and the two below it', () => {
    // The shape of the ruling, not just its three numbers: `ice-400` is legal
    // ink and the next two steps down are not. A retune that lifted `ice-500`
    // over 4.5 would not be a nicer palette, it would be a floor with two floors.
    expect(contrastRatio(colourOf(dark, '--color-ice-400'), floor)).toBeGreaterThan(BODY_TEXT_MINIMUM)
    for (const step of ['--color-ice-500', '--color-ice-600']) {
      expect(contrastRatio(colourOf(dark, step), floor)).toBeLessThan(BODY_TEXT_MINIMUM)
    }
  })

  it('is the floor the role token actually points at', () => {
    // The join between the ruling and the roles. `--ink-dim` is the floor's
    // *name*; if it ever stopped resolving to `ice-400` the three numbers above
    // would go on passing while the app's dimmest legal ink moved.
    expect(resolve('--ink-dim', dark.tokens)).toBe(resolve('--color-ice-400', dark.tokens))
  })
})

/**
 * THE LAW IS ALREADY SHAPED FOR LIGHT (#551), and this is the proof rather than
 * the promise.
 *
 * "Dark exists now; the law must already be shaped for light." A law that has
 * only ever run against one theme has never been shown to *be* per-theme — it
 * has been shown to work on dark. So a synthetic light theme is fed to the same
 * machinery: warm off-white ground, deep plum-grey inks (ruling 7's character,
 * not its final values, which are #551's to decide), and the law reads it as a
 * second world and computes its ratios.
 *
 * The failing half matters more than the passing one. A light theme whose dim
 * ink is too pale against warm paper has to come out red here, or the whole
 * "per theme" claim is decoration.
 */
const SYNTHETIC_LIGHT = `
:root {
  --color-ice-1000: #04060c;
  --surface-floor: var(--color-ice-1000);
  --ink-dim: #6a81a8;
}
[data-theme='light'] {
  --surface-floor: #faf7f2;
  --ink-dim: #5a5266;
}
[data-theme='dusk'] {
  --surface-floor: #faf7f2;
  --ink-dim: #cfc8d8;
}
`

describe('the law is already shaped for the theme that does not exist yet', () => {
  const discovered = themesOf(SYNTHETIC_LIGHT)

  it('reads a data-theme block as a second world, layered over the first', () => {
    expect(discovered.map((theme) => theme.name)).toEqual(['dark', 'light', 'dusk'])
    // Layered, not replaced: a theme that overrides two tokens still inherits
    // the ramp underneath, or every light block would have to restate the world.
    expect(resolve('--color-ice-1000', (discovered[1] as Theme).tokens)).toBe('#04060c')
    expect(resolve('--surface-floor', (discovered[1] as Theme).tokens)).toBe('#faf7f2')
  })

  it('passes a lawful light theme', () => {
    const light = discovered[1] as Theme
    expect(
      contrastRatio(colourOf(light, '--ink-dim'), colourOf(light, '--surface-floor')),
    ).toBeGreaterThanOrEqual(BODY_TEXT_MINIMUM)
  })

  it('fails an unlawful one — the half that makes the passing half mean anything', () => {
    // `dusk` is the mutation: the same warm ground with dark's dim ink dropped
    // onto it unchanged, which is exactly what "deriving light arithmetically
    // from dark" produces and exactly what ruling 7 refuses. 1.5:1 on paper.
    const dusk = discovered[2] as Theme
    expect(
      contrastRatio(colourOf(dusk, '--ink-dim'), colourOf(dusk, '--surface-floor')),
    ).toBeLessThan(BODY_TEXT_MINIMUM)
  })
})
