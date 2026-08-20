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
  { token: '--text-title', rem: '1rem', pxEq: 16 }, // a page's own name — the h1 register (loop 10)
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

  it('has exactly these seven sizes and no eighth', () => {
    // The failure S1 names: "a `text-xs`-versus-`text-[12px]` pair returning".
    // An eighth token is how 13 px gets spelled two ways again, so the set is
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
 * allowlist". Landing that today would need a 226-entry allowlist, because
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
// 227 -> 225, by two independent retirements landing in the same wave. #549
// retired one as the nav and the window floor replaced hand-spelled sizes; #553
// retired another when `theme/kind.ts` gave the trace's kind tag and the
// activity ledger one spelling instead of two (`text-[10px]` among six
// utilities). Both branches wrote 226 independently, so git merged the number
// with no conflict at all — agreement is not correctness, and taking it would
// have pinned the ratchet one slot above the truth. Recomputed from the tree.
//
// 225 -> 85: the orphan half of the wave-4 sweep (#575), 140 literals retired
// across the nineteen files no other cluster claims — `connect/`, `why/`,
// `panels/{ledger,burn,collisions}/`, `concierge/`, `recordings/`, `replay/`,
// `tide/`, `index.css`. The 85 that survive are the contested files, and they
// fall in the second half of the sweep. Recomputed from the tree, not
// subtracted from the diff: the number this line pins has to be the number the
// walk finds.
//
// 85 -> 69: prd-36 wave 2/3 (#562). The fleet table, the peek (formerly the
// four-tab drawer, minus `Tabs.tsx` and `Trace.tsx` outright), `PanelFrame`,
// `PanelGrid`, `FleetSurface` and the focus-trace panel all went through the
// ramp as they were restructured — retiring a literal while a file is already
// open beats a sweep that reopens it later. Recomputed from the tree, not
// subtracted from the diff.
//
// 69 -> 67: the dock (#552). The activity feed went through the ramp as its
// frame and its collapsed peek came off.
//
// 67 -> 65: the walkthrough repairs. `Shell.tsx`'s wordmark and the retired
// `app/SceneSlot.tsx` (dead since #555's merge, deleted here) took the last two.
// 65 -> 0: the sweep's second half (loop 12). Every surviving literal mapped
// onto the ramp it was approximating - 9->inst-floor, 10->inst-dense,
// 11->inst, 13->read-floor - and the three genuine 12px sites (conversation
// prose, a lane-page mono detail) were judged, not mapped: all three are
// READ, so all three took read-floor. The off-ramp Tailwind spellings
// (text-xs/text-sm) went in the same pass, with the same judgment. The
// ratchet is now a wall: S1's original law finally exists in the form it
// first asked for.
const RAW_PIXEL_SIZES = 0

/** Everything the sweeps own: the app, less `lab/` (prd-28's territory). */
function sweepable(): { name: string; text: string }[] {
  return sourceFiles().filter((file) => !file.name.startsWith('lab/'))
}

describe('no new pixel literal after the ramp exists (S1)', () => {
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

  it("spells no size from Tailwind's default scale either — the ramp is the whole vocabulary", () => {
    // text-xs is 12px and text-sm is 14px: the exact off-ramp the pixel census
    // cannot see, found carrying eight sites the day the ratchet hit zero.
    const offenders = sweepable().flatMap((file) =>
      [...withoutComments(file.text).matchAll(/\btext-(xs|sm|base|lg|xl|2xl)\b/g)].map(() => file.name),
    )
    expect(offenders, 'an off-ramp text size — use a --text-* ramp token').toEqual([])
  })
})

/**
 * THE COLOUR CENSUS — the pixel ratchet's twin, and the reason an early sweep
 * is safe (#597).
 *
 * S2 said "no consumer names a luminance directly" and nothing counted. So on
 * 2026-08-16 the instrument shipped a complete, lawful light theme that could
 * not be seen: `theme.css` had the warm-paper block, `index.css` painted the
 * body warm — and the app's own root class was
 * `bg-ice-1000 … text-ice-300`, which repainted the void straight back over
 * it. Choosing Light produced a dark instrument with a sliver of cream at the
 * edges, and read as a rendering bug rather than a theme. The walk below
 * counted 753 rung references across 56 consumer files that morning, against
 * 32 files consuming a role at all. Success criterion 4 — "light mode is real,
 * lawful and switchable" — was unmet, and no test in the repo could say so.
 *
 * This is the same ratchet `RAW_PIXEL_SIZES` is, aimed at the other half of the
 * substrate: pinned, exact, and it may only go down. **It is what makes the
 * sweep hard to undo.** Once the number is written, a later wave that reaches
 * for `bg-ice-950` instead of `bg-(--surface-panel)` turns the suite red on the
 * commit that does it, rather than a walkthrough finding it a PRD later.
 *
 * `theme/theme.css` is excluded, and only it. That file *is* the ice ramp: it
 * declares the thirteen rungs and derives every role from them with a `var()`,
 * which another law in this file requires. Counting the definition site would
 * pin the ratchet's floor at 24 and make "may only go down" a sentence with an
 * asterisk. Excluding it means the floor is genuinely zero: this number is
 * consumers, and a consumer has no business naming a rung.
 */
// 399 at the end of the orphan half of the sweep (#597) — the nineteen
// directories no other cluster claims. It was 753 the moment before, which is
// the 777 the same walk finds with `theme.css` counted, less that file's own
// 24. The 399 that remain are the contested files, and they fall in the second
// half. Recomputed from the tree rather than subtracted from the diff.
//
// 399 -> 375: `settings/` swept whole (#574), so the directory leaves the
// contested half entirely rather than being handed to it 13 sites larger.
// Thirty-seven rung references went; 24 of them were on these books, and the
// other 13 were this branch's own — wave 2's controls and its telemetry block,
// written against the rung idiom of the file they extended, on a lane whose
// brief pre-dated the ratchet and fenced it out of `theme/`. The law caught
// them on the merge, which is the thing it was built to do; taking the
// pre-existing 24 in the same commit is what makes light mode real on that
// surface instead of pending. Recomputed from the tree.
//
// 375 -> 285: prd-36 wave 2/3 (#562). Every surface prd-36's waves 2 and
// 3 rewrote now reaches for a role — `bg-(--surface-panel)`, `text-(--ink-body)`,
// `border-(--line-hair)` — rather than a rung, so the fleet's own list, the
// peek and the grid's chrome are lawful in light for the first time. The two
// deleted files (`drawer/Tabs.tsx`, `drawer/Trace.tsx`, plus
// `trace/FocusPanel.tsx`) took 12 of these with them; the rest were converted.
//
// **285 is neither branch's number.** `settings/` (#574) and this lane's
// directories are disjoint, so the merged tree is lower than main's 375 AND
// lower than the 309 this branch pinned before the rebase. Taking either would
// have pinned the ratchet above the truth and left the difference free to be
// spent silently — the exact mistake the 227->225 note above records costing
// this project once, when two branches wrote 226 independently and git merged
// the agreement with no conflict to notice.
//
// The pixel ratchet above is the same hazard wearing the opposite face: main
// said 85, this branch said 69, and the two lines did not conflict at all, so
// git simply took one. Both numbers below were therefore RUN rather than
// reasoned — resolve the conflict, execute the law, write down the figure its
// own self-correcting message reports. 69 is what the walk finds for pixels on
// the merged tree, unchanged; 285 is what it finds for rungs.
//
// 285 -> 258: the dock (#552). `PanelGrid` and the activity feed reach for
// roles; the ledger and collisions panels lost their own frames to the dock's
// one border. Run, not subtracted.
//
// 258 -> 129: the walkthrough's repairs, in one move because they landed in
// one commit — pinning an intermediate figure would be inventing a tree that
// never existed. Two causes, both named:
//
// (a) `Shell.tsx` reaches for roles, and `app/SceneSlot.tsx` — nine rungs of
// it, unmounted since #555 — is deleted.
//
// (b) the colour repair. A browser pass
// over the built instrument found the FLEET SURFACE rendering as a black slab
// on warm paper — `fleet/TwoRepresentations.tsx` painted the frame
// `bg-ice-950`, so in light mode the hero of the main screen was the void with
// dark-on-dark rows in it, and the peek's vitals were `text-ice-200`
// (near-white) on cream. That is exactly the bug this ratchet was created for
// (#597's "a dark instrument with a sliver of cream at the edges"), and no test
// could see it: every law in this file reads the DARK table.
//
// So every surface this lane restructured is swept onto roles — the fleet
// frame, the peek's four regions, the trace's rows and gantt, the attention
// chips, the panel chrome and the replay bar.
//
// **129 is the figure the law reported on the rebased tree, not this branch's
// own.** Before the rebase this line read 153; `settings/` was swept in
// parallel by #574 on a disjoint set of directories, so the merged truth is
// lower than either branch knew. Every pin in this file was re-derived the same
// way after the rebase — resolve, run the law, write down what its own message
// says — because the one thing this ratchet must never be is a number somebody
// worked out.
//
// 129 -> 98: the light-mode finish begins (the sweep the 2026-08-20 walkthrough
// demanded — "greyish and ugly" was mostly these sites rendering cold blue ink
// at 1.2-3.7:1 on cream). The app cluster goes first: WindowFloor (a black
// panel with 2.4:1 text in light mode — the below-minimum voice, unreadable
// exactly when someone is already squinting), Nav, ConnectionBadge, StatusBar
// (a near-black slab across the bottom of a warm page), ModeContext. StatusBar's
// two hand-rolled status-hue rings move to the `focus-ring` utility, which is
// what finally empties STATUS_RING_ALLOWLIST below.
//
// 98 -> 44: the lane-page cluster (LanePage, PageHeader, SpendDetail,
// TraceColumn) — every panel there was border-ice-850 bg-ice-950, a set of
// black slabs on the warm page, with text-ice-400 bodies at 3.7:1.
//
// 44 -> 32: kind.ts (every trace/ledger span ink) and the fleet sigils move to
// the three ink roles — three ordered lightnesses in BOTH themes, so no themed
// sub-ramp was needed; kind.test.tsx's INK_ALLOWED now names the roles.
//
// 32 -> 0: the scene's chrome (SceneView.tsx — the motion, finished-lanes and
// camera controls, and the host's ground and focus ring), and the ratchet
// RETIRES. From here the census is not a countdown, it is a ban: the empty
// array below is the end state #597 was opened for, and a single new rung
// anywhere outside theme.css fails the build by name. The history above is
// kept because the numbers are the story of how light mode became real.
const ICE_RUNG_SITES = 0

describe('no consumer names a luminance rung — the colour ratchet (S2)', () => {
  /** The sweep's own files, less the one that defines the ramp being counted. */
  function consumers(): { name: string; text: string }[] {
    return sweepable().filter((file) => file.name !== 'theme/theme.css')
  }

  it('has files to count at all — an empty walk proves nothing', () => {
    expect(consumers().length).toBeGreaterThan(50)
  })

  it('still walks the ramp definition it excludes — a stale exclusion hides a file', () => {
    // The exclusion is by exact name, so a rename would silently turn it into a
    // no-op *and* start counting 24 sites that are not consumers. Either way
    // the number moves for a reason that is not the sweep, which is the one
    // thing a ratchet must not do quietly.
    expect(sweepable().map((file) => file.name)).toContain('theme/theme.css')
  })

  it('names NO ice rung outside theme.css — the ban the ratchet retired into', () => {
    // `toEqual([])` rather than a length check, so a violation fails NAMING the
    // offending file(s) — and unlike the countdown this replaced, there is no
    // pin to "update": a new rung has no legal move except becoming a role.
    expect(
      countRungSites(consumers()),
      'a consumer named a luminance rung — reach for a role (`bg-(--surface-panel)`, `text-(--ink-body)`, `border-(--line-hair)`) instead, or light mode paints the void on that surface',
    ).toEqual([])
    expect(ICE_RUNG_SITES).toBe(0)
  })

  it('would catch a rung coming back — the mutation, run rather than argued', () => {
    // Without this, the assertion above passes for the same reason a `TTL - 1`
    // assertion passes at any TTL: it would be equally green if `countRungSites`
    // matched nothing at all. So the counter is handed a file that has just
    // regressed, and has to say so.
    const clean = [{ name: 'why/WhySurface.tsx', text: 'className="bg-(--surface-panel) text-(--ink-body)"' }]
    const regressed = [{ name: 'why/WhySurface.tsx', text: 'className="bg-ice-950 text-ice-300"' }]

    expect(countRungSites(clean)).toEqual([])
    expect(countRungSites(regressed)).toEqual(['why/WhySurface.tsx', 'why/WhySurface.tsx'])
  })

  it('counts the code and not the prose about the code', () => {
    // `withoutComments` is why this file can explain `bg-ice-950` in the
    // paragraph above without adding two to its own census — the same reason
    // the pixel ratchet blanks comments. A ratchet that counted its own
    // rationale would be off by however many words its author wrote.
    expect(countRungSites([{ name: 'a.tsx', text: '/* bg-ice-950 */ // text-ice-400\n' }])).toEqual([])
  })
})

/** Every `ice-<rung>` a set of files names, once per occurrence, comments blanked. */
function countRungSites(files: { name: string; text: string }[]): string[] {
  return files.flatMap((file) =>
    [...withoutComments(file.text).matchAll(/ice-[0-9]/g)].map(() => file.name),
  )
}

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
 * ROLE PARITY — the one thing every other law in this file is blind to (#597).
 *
 * Everything above reads `themesOf(THEME)[0]`: dark, and dark only. That is not
 * an oversight so much as a trap, because of how CSS actually layers the two
 * blocks. `[data-theme='light']` does not replace `:root`, it *overrides* it —
 * so a role declared in `:root` and forgotten in the light block does not go
 * undefined in light. It keeps the **dark** value, and paints a void-black
 * panel onto warm paper.
 *
 * Every check in this file stays green through that. `resolve()` finds the
 * token. `themesOf` reports two themes and hands the light one the inherited
 * dark value, faithfully, because that is what the browser does. The
 * contrast law computes a ratio — a *correct* ratio, for a colour nobody
 * intended. `definedTokens` sees the name. There is no assertion anywhere that
 * fails, and the only way to find it is to open the app in light and look,
 * which is exactly how the first version of this bug was found and exactly what
 * a law is for.
 *
 * So the assertion is made one level below the resolved table, on what each
 * block **declares in its own body**: every custom property `:root` names, every
 * theme block has to name again. Not equality in both directions — light
 * legitimately declares more (`--color-paper-*`, the re-inked status hues,
 * the tissue ramp), because dark declares those in `@theme` instead. The
 * containment is the claim, and it is the whole of the bug.
 */
describe('every theme declares every role, not just the one the laws read', () => {
  it('has a second theme to check at all — one theme proves nothing', () => {
    // With only `:root` present this whole describe passes vacuously, and would
    // go on passing if `[data-theme='light']` were deleted outright.
    expect(themesOf(THEME).map((theme) => theme.name)).toEqual(['dark', 'light'])
  })

  it('leaves no role behind in a theme block', () => {
    expect(
      rolesMissingFromThemes(THEME),
      'a token is declared in :root and not re-declared per theme — it silently keeps dark’s value on paper',
    ).toEqual([])
  })

  it('would catch a role added to :root and forgotten in light — the mutation', () => {
    // Run, not argued, and against a synthetic sheet rather than the real one so
    // the proof does not depend on breaking the file every other law reads.
    // `--surface-sunk` exists in `:root` only; light inherits dark's `#04060c`
    // and every other law in this file is satisfied by that.
    const rigged = `
      :root { --surface-floor: #04060c; --surface-sunk: #04060c; }
      [data-theme='light'] { --surface-floor: #faf6ef; }
    `
    expect(rolesMissingFromThemes(rigged)).toEqual(['light → --surface-sunk'])

    // And the same sheet with the light declaration present is clean, so the
    // helper is discriminating rather than merely pessimistic.
    expect(
      rolesMissingFromThemes(`
        :root { --surface-floor: #04060c; --surface-sunk: #04060c; }
        [data-theme='light'] { --surface-floor: #faf6ef; --surface-sunk: #ebe3d6; }
      `),
    ).toEqual([])
  })
})

/**
 * `theme → token` for every custom property `:root` declares that a
 * `[data-theme='…']` block does not declare back.
 *
 * Comments are blanked before the theme blocks are discovered, for the reason
 * `blockBody` gives: `theme.css` explains `[data-theme='light']` in a paragraph
 * three lines above the rule that opens it, and a scan that matched the
 * paragraph would read a theme out of the prose about the theme.
 */
function rolesMissingFromThemes(css: string): string[] {
  const source = withoutComments(css)
  const base = declarationsOf(blockBody(source, ':root') ?? '')
  const gaps: string[] = []

  for (const match of source.matchAll(/\[data-theme\s*=\s*['"]([a-z-]+)['"]\]/gi)) {
    const name = match[1] as string
    const body = blockBody(source, match[0])
    if (body === null) {
      gaps.push(`${name} → the block itself is missing`)
      continue
    }
    const declared = declarationsOf(body)
    for (const token of base.keys()) {
      if (!declared.has(token)) gaps.push(`${name} → ${token}`)
    }
  }

  return gaps
}

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
  // EMPTY, at last (2026-08-20): the two `StatusBar` entries this carried since
  // prd-32 w1 were swept onto the `focus-ring` utility — the wave-4 sweep their
  // own reasons promised. The array stays declared rather than deleted so the
  // next status-hue ring has to argue its way into a named, reasoned exception
  // instead of just existing.
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
  ['--duration-settle', '1750ms'], // bud 350 + reach 1400 — the growth class's own budget (prd-33 r9)
  ['--duration-breath', '5400ms'],
  ['--duration-age-pulse-seam', '6800ms'],
  ['--duration-touch', '150ms'], // hover/press micro-transitions — the de facto value at every swept site (loop 10)
  ['--duration-reveal', '240ms'], // overlays arriving — under the 620ms event floor, so chrome stays quieter than the picture
]

describe('every duration in the app is in the theme', () => {
  it.each(DURATIONS)('%s is %s', (token, value) => {
    expect(resolve(token, DARK)).toBe(value)
  })

  it('has exactly these six and no seventh', () => {
    const declared = [...definedTokens(THEME)].filter((name) => name.startsWith('--duration-'))
    expect(declared.sort()).toEqual(DURATIONS.map(([token]) => token).sort())
  })
})

/**
 * THE LADDER CENSUSES (loop 10) — three bans that land at zero, because the
 * sweeps ran in the same change that declared the tokens.
 *
 * Each of these is the pixel census's stronger sibling: not a ratchet from a
 * pinned count but a flat zero, possible only because the offending sites
 * (nine raw z-indexes, ten `duration-150`s, one raw drop shadow) were migrated
 * before the law landed. A new raw value is how two surfaces end up disagreeing
 * about which of them is on top, how fast chrome moves, or what colour a
 * shadow casts on paper — each a decision `theme.css` now owns.
 */
/**
 * THE MATERIALS HAVE CONSUMERS (loop 13) — the age-pulse-seam bug inverted.
 *
 * A token nothing reads is a decision the theme claims and the page does not
 * make — --scrim lived three loops that way before being deleted for exactly
 * this. Each named material must be reached for somewhere outside theme.css;
 * when one stops being, delete it rather than let it lie.
 */
describe('every declared material is consumed', () => {
  const MATERIALS = ['--elev-raised', '--elev-overlay', '--elev-sheet', '--duration-touch', '--duration-reveal']

  it.each(MATERIALS)('%s has a consumer outside theme.css', (token) => {
    const consumers = sourceFiles().filter(
      (file) => file.name !== 'theme/theme.css' && file.text.includes(token),
    )
    expect(consumers.length, `${token} is declared but never used — delete it or use it`).toBeGreaterThan(0)
  })
})

describe('stacking, speed and shadow come from the theme', () => {
  const appSources = () => sourceFiles().filter((file) => /\.tsx?$/.test(file.name))

  it('no raw z-index utility outside the five-rung ladder', () => {
    // z-(--z-sticky) 10 · z-(--z-focus) 30 · z-(--z-peek) 40 · z-(--z-card) 50
    // · z-(--z-plate) 60. An eleventh-hour `z-[9999]` is a fight, not a rung.
    const offenders = appSources().filter((file) => /z-(\d|\[)/.test(withoutComments(file.text)))
    expect(offenders.map((file) => file.name), 'a raw z-index utility — use the z ladder').toEqual([])
  })

  it('no raw transition-duration utility — the table above is the durations', () => {
    const offenders = appSources().filter((file) => /duration-(\d|\[)/.test(withoutComments(file.text)))
    expect(offenders.map((file) => file.name), 'a raw duration utility — use --duration-touch/-reveal').toEqual([])
  })

  it('no shadow literal in a component — elevation is a token in both themes', () => {
    // The drawer carried `rgba(0,0,0,0.9)` into the light theme for two PRDs:
    // a black smear on warm paper. `--elev-*` exists so a shadow is declared
    // once per theme, in the register's own material.
    const offenders = appSources().filter((file) => /shadow-\[/.test(withoutComments(file.text)))
    expect(offenders.map((file) => file.name), 'a literal box-shadow — use --elev-raised/-overlay/-sheet').toEqual([])
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
