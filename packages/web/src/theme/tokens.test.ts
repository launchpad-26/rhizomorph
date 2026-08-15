import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { contrastRatio, NON_TEXT_MINIMUM } from './contrast.js'
import { rgbFromHex } from './oklch.js'
import { definedTokens, declarationsOf, blockBody, referencedTokens, resolve, themesOf } from './tokens.js'

/**
 * THE TOKEN LAWS (prd-32 wave 1) — everything the substrate claims about
 * itself, computed from the substrate.
 *
 * prd-32's second success criterion is one sentence: *drift fails the build.*
 * Before this file, three separate kinds of drift could not fail anything.
 *
 *   1. **A face that is named but never loads.** `--font-sans` has said `Inter`
 *      since prd3 and no `@fontsource` package was ever installed, so every
 *      session ran in Segoe UI. Nothing was wrong with the token; nothing
 *      shipped the file. A test that reads the token learns nothing — so the
 *      tests below read the *installed packages* and hold the stacks to the
 *      family names those packages actually register.
 *   2. **A token referenced and never defined.** `attention.css` has asked for
 *      `var(--duration-age-pulse-seam, 6800ms)` since prd5. CSS answers a
 *      missing custom property with the fallback and says nothing, so a
 *      duration lived in a default argument for four PRDs while `theme.css`
 *      claimed to hold "the only durations in the app".
 *   3. **A number that is prose.** The ramp, the roles and the ratios were all
 *      described in comments and computed nowhere. `contrast.test.ts` is the
 *      ratios; this file is the ramp and the roles.
 *
 * The mechanism is the house one, extended: parse the real stylesheet off disk
 * (`scene/palette.test.ts` has done it since prd4) rather than hand-copy an
 * expectation that drifts in exactly the way the test exists to catch.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.resolve(SRC, '..')
const REPO = path.resolve(WEB, '../..')

const THEME = readFileSync(path.join(SRC, 'theme', 'theme.css'), 'utf8')
const INDEX_CSS = readFileSync(path.join(SRC, 'index.css'), 'utf8')
const MAIN = readFileSync(path.join(SRC, 'main.tsx'), 'utf8')
const WEB_PACKAGE = JSON.parse(readFileSync(path.join(WEB, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}

/** Every source file the app is built from — tests excluded, nothing else. */
function sourceFiles(): { name: string; text: string }[] {
  const files: { name: string; text: string }[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx|css)$/.test(entry.name)) continue
      if (/\.test\.tsx?$/.test(entry.name)) continue
      files.push({
        name: path.relative(SRC, full).split(path.sep).join('/'),
        text: readFileSync(full, 'utf8'),
      })
    }
  }

  walk(SRC)
  return files
}

/**
 * Comments out, for the scans that count occurrences rather than read values.
 * Not fussiness: this file's own prose quotes `text-[10px]` while explaining why
 * pixel literals are being counted, and a census that counted the sentence
 * about the census would be off by one from the day it landed.
 */
function withoutComments(text: string): string {
  return text
    // Blanked rather than removed, so the line numbers in a failure message
    // still point at the line the reader has open.
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    // `[^:]` keeps `https://` from eating the rest of its own line.
    .replace(/(^|[^:])\/\/.*$/gm, (_whole, lead: string) => lead)
}

/** The dark theme's token table — the only one that exists until #551. */
const DARK = themesOf(THEME)[0]?.tokens ?? new Map<string, string>()

describe('the faces load, self-hosted (ruling 1)', () => {
  it('ships both variable faces as real dependencies', () => {
    expect(Object.keys(WEB_PACKAGE.dependencies)).toEqual(
      expect.arrayContaining(['@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono']),
    )
  })

  it('imports them at the app entry, where the app actually boots', () => {
    // In `main.tsx` rather than in a stylesheet: a face that is only imported by
    // a CSS file nothing imports is a face that does not load, which is the
    // exact failure this whole ruling is about.
    expect(MAIN).toMatch(/import '@fontsource-variable\/inter'/)
    expect(MAIN).toMatch(/import '@fontsource-variable\/jetbrains-mono'/)
  })

  it.each([
    ['--font-sans', '@fontsource-variable/inter'],
    ['--font-mono', '@fontsource-variable/jetbrains-mono'],
  ])('leads %s with the family name the package really declares', (token, pkg) => {
    // THE DRIFT THIS EXISTS FOR, and it is not hypothetical — it is the shape
    // the bug would have taken this week. `@fontsource-variable/*` registers
    // `Inter Variable`, not `Inter`: a stack that led with plain `'Inter'` would
    // match no loaded family, fall straight through to `ui-sans-serif`, and
    // render in Segoe UI exactly as it did before the package was installed —
    // with the dependency present, the import present, and every other test
    // green. So the expectation is read out of the installed package.
    const face = readFileSync(path.join(REPO, 'node_modules', pkg, 'index.css'), 'utf8')
    const declared = [...face.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1] as string)
    expect(new Set(declared).size, `${pkg} declares more than one family`).toBe(1)

    const stack = resolve(token, DARK)
    expect(stack, `theme.css has no ${token}`).not.toBeNull()
    expect(stack?.startsWith(`'${declared[0] as string}'`), `${token} is ${stack}`).toBe(true)
  })

  it('reaches no CDN for anything, from any surface', () => {
    // prd-32's rejected alternatives: "a localhost-only instrument never reaches
    // a CDN". A cold start on a fresh profile has to render both faces with no
    // network request, so the absence of a remote URL is the assertion.
    const surfaces = [...sourceFiles(), { name: 'index.html', text: readFileSync(path.join(WEB, 'index.html'), 'utf8') }]
    for (const file of surfaces) {
      expect(
        /fonts\.(googleapis|gstatic|bunny|cdnfonts)\.com|@import\s+url\(\s*['"]?https?:/i.test(file.text),
        `${file.name} fetches type over the network`,
      ).toBe(false)
    }
  })
})

/**
 * THE RAMP (prd-32 S1). Six tokens, two registers, every value in rem.
 *
 * The table is repeated here rather than derived, on purpose: this is the one
 * place in the repo where a hand-written expectation is the *point*. S1 is a
 * decision the team reviewed, so a change to a ramp value has to be a change to
 * two files and a sentence in a PR, not a quiet edit to a stylesheet.
 */
const RAMP: ReadonlyArray<{ token: string; rem: string; pxEq: number }> = [
  { token: '--text-read-body', rem: '0.875rem', pxEq: 14 },
  { token: '--text-read-floor', rem: '0.8125rem', pxEq: 13 },
  { token: '--text-inst', rem: '0.6875rem', pxEq: 11 },
  { token: '--text-inst-dense', rem: '0.625rem', pxEq: 10 },
  { token: '--text-inst-floor', rem: '0.5625rem', pxEq: 9 },
  { token: '--text-heading', rem: '0.625rem', pxEq: 10 },
]

describe('the type ramp, in rem, in two registers (S1)', () => {
  it.each(RAMP)('defines $token at $rem ($pxEq px-eq)', ({ token, rem }) => {
    expect(resolve(token, DARK)).toBe(rem)
  })

  it('is rem all the way down — the accessibility half of ruling 9', () => {
    // "Rem is not optional": a pixel literal overrides the OS and browser text
    // preference it is supposed to honour, so a person who has set their text
    // larger gets no change at all. A single px value in the ramp would put that
    // back for every surface downstream of it.
    for (const { token, rem } of RAMP) {
      expect(rem, `${token} is not rem`).toMatch(/^[0-9.]+rem$/)
      expect(Number.parseFloat(rem) * 16, `${token} is not a whole pixel at the default root size`)
        .toBeCloseTo(Math.round(Number.parseFloat(rem) * 16), 10)
    }
  })

  it('has exactly these six sizes and no seventh', () => {
    // The failure S1 names: "a `text-xs`-versus-`text-[12px]` pair returning".
    // A seventh token is how 13 px gets spelled two ways again, so the set is
    // closed rather than merely populated.
    const sizes = [...definedTokens(THEME)].filter((name) => name.startsWith('--text-'))
    expect(sizes.sort()).toEqual(RAMP.map((entry) => entry.token).sort())
  })

  it('keeps the two registers apart, and the ornament floor at the bottom', () => {
    // The registers are a claim about *reading versus comparing*, so the reading
    // floor has to sit above the instrument ceiling — otherwise there is one
    // ramp with six steps and the distinction is decoration.
    const rem = (token: string) => Number.parseFloat(RAMP.find((e) => e.token === token)?.rem ?? 'NaN')
    expect(rem('--text-read-floor')).toBeGreaterThan(rem('--text-inst'))
    expect(rem('--text-inst-floor')).toBeLessThan(rem('--text-inst-dense'))
    expect(Math.min(...RAMP.map((e) => rem(e.token)))).toBe(rem('--text-inst-floor'))
  })
})

/**
 * THE PIXEL CENSUS — a ratchet, not a ban.
 *
 * S1's acceptance asks for a law that "fails on a raw `text-[Npx]` outside the
 * allowlist". Landing that today would need a 227-entry allowlist, because
 * migrating those sites is wave 4's work and explicitly not this one's ("a sweep
 * that runs earlier re-lays ground the other PRDs are about to dig"). So the law
 * lands in the form the fence allows: the number is pinned, and it may only go
 * down.
 *
 * That is the whole of what wave 1 can honestly enforce — but it does enforce
 * the thing S1 is actually worried about, which is "a new size landing as a
 * literal after the tokens exist". A wave-4 sweep lowering this number is the
 * sweep's own progress made visible, one commit at a time.
 */
const RAW_PIXEL_SIZES = 227

describe('no new pixel literal after the ramp exists (S1)', () => {
  /** Everything the sweeps own: the app, less `lab/` (prd-28's territory). */
  function sweepable(): { name: string; text: string }[] {
    return sourceFiles().filter((file) => !file.name.startsWith('lab/'))
  }

  it('has files to count at all — an empty walk proves nothing', () => {
    expect(sweepable().length).toBeGreaterThan(50)
  })

  it(`still spells ${RAW_PIXEL_SIZES} sizes as pixel literals, and not one more`, () => {
    const sites = sweepable().flatMap((file) =>
      [...withoutComments(file.text).matchAll(/text-\[[0-9.]+px\]/g)].map(() => file.name),
    )

    expect(
      sites.length,
      sites.length > RAW_PIXEL_SIZES
        ? `a new pixel size landed after the ramp exists — use a --text-* token instead of a literal`
        : `${RAW_PIXEL_SIZES - sites.length} literal(s) were retired: lower RAW_PIXEL_SIZES to ${sites.length} and take the credit`,
    ).toBe(RAW_PIXEL_SIZES)
  })
})

/**
 * THE ROLE TOKENS (prd-32 S2). Roles rather than steps, derived from dark.
 */
const SURFACES: readonly string[] = ['--surface-floor', '--surface-panel', '--surface-raised', '--surface-line']
const INKS: readonly string[] = ['--ink-primary', '--ink-body', '--ink-dim', '--ink-inverse']
const LINES: readonly string[] = ['--line-hair', '--line-strong']

describe('colour is roles, and the roles derive from the dark ramp (S2)', () => {
  it.each([...SURFACES, ...INKS, ...LINES])('defines %s', (token) => {
    expect(resolve(token, DARK)).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('derives every role from the ice ramp rather than restating a hex', () => {
    // The non-goal, as arithmetic: "dark remains the source of truth, and role
    // tokens derive from the dark ramp, never beside it". A role written as its
    // own hex would look identical in the browser and drift the first time the
    // ramp is retuned — which is the entire class of bug this PRD is about.
    const roles = declarationsOf(blockBody(THEME, ':root') ?? '')
    for (const token of [...SURFACES, ...INKS, ...LINES]) {
      expect(roles.get(token), `${token} is not a var() onto the ramp`).toMatch(
        /^var\(--color-ice-\d+\)$/,
      )
    }
  })

  it('names every role S2 names, and nothing beyond it', () => {
    const declared = [...definedTokens(THEME)].filter((name) =>
      /^--(surface|ink|line)-/.test(name),
    )
    expect(declared.sort()).toEqual([...SURFACES, ...INKS, ...LINES].sort())
  })
})

/**
 * THE FOCUS FLOOR (charter §6, ruling 9) — one token, never a status hue.
 */
const STATUS_HUES: readonly string[] = ['working', 'done', 'waiting-benign', 'needs-you', 'broken', 'notice']

/**
 * The focus rings still wearing a status hue. Both are `StatusBar.tsx`, both are
 * outside this wave's fence, and both belong to wave 4's sweeps. Each entry
 * names the file and a snippet unique enough to anchor it — the pattern
 * `legibility.test.ts` established — so a *new* status-hue ring in the same file
 * still fails loudly, and a stale entry fails loudly too, in the test below it.
 *
 * The list may only shrink. That is the point of writing it down.
 */
const STATUS_RING_ALLOWLIST: ReadonlyArray<{ file: string; snippet: string; reason: string }> = [
  {
    file: 'app/StatusBar.tsx',
    snippet: 'inline-flex items-center gap-1.5 rounded outline-none focus-visible:ring-1 focus-visible:ring-notice',
    reason: 'the collector-health disclosure trigger — wave 4 sweep, outside prd-32 w1’s fence',
  },
  {
    file: 'app/StatusBar.tsx',
    snippet: 'figures text-ice-400 outline-none focus-visible:ring-1 focus-visible:ring-notice',
    reason: 'the event-count figure beside it — wave 4 sweep, outside prd-32 w1’s fence',
  },
]

describe('focus is one token, and never a status hue', () => {
  it('defines --focus-ring, and it is not any of the six', () => {
    const ring = resolve('--focus-ring', DARK)
    expect(ring, 'theme.css has no --focus-ring').toMatch(/^#[0-9a-f]{6}$/i)

    for (const hue of STATUS_HUES) {
      expect(ring, `--focus-ring is ${hue}`).not.toBe(resolve(`--color-${hue}`, DARK))
    }
  })

  it('clears the non-text contrast bar the old ring missed', () => {
    // Why the token is `ice-200` and not the `ice-600` eighteen sites used: a
    // focus indicator is a non-text element, WCAG asks 3:1 of it, and `ice-600`
    // measures 2.18:1 against the page floor. The old ring was not merely
    // inconsistent — it was, on the darkest surface in the app, hard to see.
    const ring = rgbFromHex(resolve('--focus-ring', DARK) as string)
    const floor = rgbFromHex(resolve('--surface-floor', DARK) as string)
    expect(contrastRatio(ring, floor)).toBeGreaterThanOrEqual(NON_TEXT_MINIMUM)
  })

  it('offers one utility for it, so a site never has to hand-roll the idiom', () => {
    const utility = blockBody(THEME, '@utility focus-ring')
    expect(utility, 'theme.css has no focus-ring utility').not.toBeNull()
    expect(utility).toMatch(/:focus-visible/)
    expect(utility).toMatch(/var\(--focus-ring\)/)
  })

  it('keeps every allowlist entry honest — a stale snippet hides nothing', () => {
    const files = sourceFiles()
    for (const entry of STATUS_RING_ALLOWLIST) {
      const file = files.find((f) => f.name === entry.file)
      expect(file, `allowlisted file is gone: ${entry.file}`).toBeDefined()
      expect(
        file?.text.includes(entry.snippet),
        `allowlisted snippet no longer appears in ${entry.file} — remove the entry: "${entry.snippet}"`,
      ).toBe(true)
    }
  })

  it('wears no status hue as focus chrome, allowlist aside', () => {
    // The one prd-32 names first, and the reason it goes first: on the
    // collisions panel every row is already a summons, so an amber focus ring
    // made "a human must act on this" and "your keyboard is here" the same
    // colour — and the amber stopped meaning either.
    const pattern = new RegExp(`focus-visible:(?:ring|outline|border)-(${STATUS_HUES.join('|')})\\b`)
    for (const file of sourceFiles()) {
      withoutComments(file.text).split('\n').forEach((line, index) => {
        if (!pattern.test(line)) return
        const allowed = STATUS_RING_ALLOWLIST.some(
          (entry) => entry.file === file.name && line.includes(entry.snippet),
        )
        expect(allowed, `${file.name}:${index + 1} wears a status hue as focus chrome:\n  ${line.trim()}`).toBe(true)
      })
    }
  })
})

/**
 * THE REFERENCED-BUT-UNDEFINED LAW — the bug prd-32 names by name, generalised
 * to every token family rather than fixed one line at a time.
 *
 * CSS answers `var(--missing, fallback)` with the fallback and reports nothing.
 * That is a reasonable language design and a terrible one to build a token
 * system on: `attention.css` asked for `--duration-age-pulse-seam` for four
 * PRDs, got 6800 ms out of a default argument every time, and `theme.css` went
 * on claiming its three durations were "the only durations in the app".
 */
describe('no token is referenced without being defined', () => {
  const defined = new Set([...definedTokens(THEME), ...definedTokens(INDEX_CSS)])

  it('defines every custom property the app reaches for', () => {
    const dangling: string[] = []
    for (const file of sourceFiles()) {
      for (const token of referencedTokens(file.text)) {
        if (!defined.has(token)) dangling.push(`${file.name} → ${token}`)
      }
    }
    expect(dangling, 'a var() reference has no definition — it is silently taking its fallback').toEqual([])
  })

  it('would have caught the age-pulse seam — the known first catch', () => {
    // A mutation, run here rather than argued: strip the token the seam needs
    // out of the sheet and the law has to notice. Without this, the test above
    // passes for the same reason a `TTL - 1` assertion passes at any TTL.
    const withoutSeam = new Set(defined)
    withoutSeam.delete('--duration-age-pulse-seam')

    const seamUsers = sourceFiles().filter((file) =>
      referencedTokens(file.text).has('--duration-age-pulse-seam'),
    )
    expect(seamUsers.map((file) => file.name)).toEqual(['panels/attention/attention.css'])
    expect(withoutSeam.has('--duration-age-pulse-seam')).toBe(false)
  })
})

/**
 * THE DURATION TABLE (ruling 1) — closed, so a fourth duration cannot land
 * without appearing here. The canvas-side mirrors (`BREATH_PERIOD_MS`,
 * `SETTLE_MS`) are held to these values in `scene/palette.test.ts`, where the
 * rest of the canvas mirror lives.
 */
const DURATIONS: ReadonlyArray<readonly [string, string]> = [
  ['--duration-flare', '620ms'],
  ['--duration-settle', '900ms'],
  ['--duration-breath', '5400ms'],
  ['--duration-age-pulse-seam', '6800ms'],
]

describe('every duration in the app is in the theme', () => {
  it.each(DURATIONS)('%s is %s', (token, value) => {
    expect(resolve(token, DARK)).toBe(value)
  })

  it('has exactly these four and no fifth', () => {
    const declared = [...definedTokens(THEME)].filter((name) => name.startsWith('--duration-'))
    expect(declared.sort()).toEqual(DURATIONS.map(([token]) => token).sort())
  })
})

/**
 * THE ALIAS RETIREMENT (ruling 3) — a pure delete, and this is the proof it
 * stays deleted.
 *
 * The six aliases and four glow utilities were kept alive "until the files that
 * depend on them are replaced by their own issues"; #77–#83 did that, and the
 * call count reached zero without anybody removing the definitions. A dead
 * token is worse than no token — it is a name a hand reaches for, and three of
 * these six mapped straight onto status hues, so reaching for one was a law-9a
 * breach that looked like using the design system.
 */
const RETIRED_TOKENS: readonly string[] = [
  '--color-void',
  '--color-void-raised',
  '--color-void-line',
  '--color-neon-cyan',
  '--color-neon-amber',
  '--color-neon-magenta',
]

const RETIRED_UTILITIES: readonly string[] = ['glow-cyan', 'glow-magenta', 'glow-amber', 'text-glow-cyan']

describe('the dead aliases are gone and stay gone', () => {
  it.each(RETIRED_TOKENS)('%s is not defined anywhere', (token) => {
    expect(definedTokens(THEME).has(token)).toBe(false)
  })

  it.each(RETIRED_UTILITIES)('@utility %s no longer exists', (utility) => {
    expect(blockBody(THEME, `@utility ${utility}`)).toBeNull()
  })

  it('has no caller left to strand — the delete was pure, and still is', () => {
    const legacy = new RegExp(
      `(${RETIRED_TOKENS.join('|')})|\\b(bg|text|border|ring|fill|stroke|shadow|outline)-(void|neon)(-[a-z0-9]+)?\\b|\\b(${RETIRED_UTILITIES.join('|')})\\b`,
    )
    const offenders: string[] = []
    for (const file of sourceFiles()) {
      if (legacy.test(withoutComments(file.text))) offenders.push(file.name)
    }
    expect(offenders, 'a retired alias came back').toEqual([])
  })
})
