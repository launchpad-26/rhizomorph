import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE LAW THAT BITES (prd-30 S1 · #220).
 *
 * #220 retired every native `title=` in the instrument's own surfaces. This is
 * what stops the next one arriving. The issue asked for it by name: *"Re-add a
 * single native `title=` to a converted surface. Nothing currently goes red …
 * if this sweep can leave behind a law that bites, say so on the PR."* It can,
 * and this is it.
 *
 * **Why a `title=` is not an acceptable disclosure**, so a later reader does
 * not have to go and find prd-30 to know what this is defending: it is
 * OS-delayed by about a second, invisible to a keyboard, absent on touch, and
 * unstyleable. Charter §6 is binding — whatever hover discloses, focus
 * discloses — and a native tooltip fails that on its own terms. The
 * replacement is `disclosure/Disclosure.tsx`, which opens on hover, on focus
 * and on tap, out of one state machine.
 *
 * **It lives in `app/` rather than beside the card it defends.** #220's fence
 * did not reach `disclosure/`, which is prd-30 wave 2's (#221). If that ever
 * stops being true, this file belongs next to `one-card-law.test.ts`, whose
 * scanners it is modelled on.
 *
 * ---
 *
 * **The distinction this law exists to get right, and the one the issue itself
 * got wrong.** `title=` is both a DOM attribute and an ordinary prop name.
 * #220's body counted 97 "native `title=`" from a bare grep; 26 of those were
 * props on local components — `<Vital title=…>`, `<Figure title=…>` — and two
 * were `<PanelFrame title="Fleet">`, which renders a *visible heading* and has
 * nothing to do with tooltips at all. A law that repeats that miscount would
 * fail on a legitimate heading prop, and the first person it lied to would
 * disable it. So {@link nativeTitleSites} resolves the element each attribute
 * actually sits on, and only lowercase intrinsic elements count.
 *
 * The subtle case is `drawer/index.tsx`, which passes a whole element as the
 * prop's value:
 *
 * ```tsx
 * <DrawerFrame title={<h2 className="…">{label}</h2>} />
 * ```
 *
 * A scanner that takes the last `<tag` on the line finds `<h2` — inside the
 * *value* — and reports a native attribute on a heading that does not have
 * one. That is why the walk below only considers text *before* the attribute.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(HERE, '..')

interface SourceFile {
  name: string
  text: string
}

/**
 * Directories this law does not reach, each with the reason and the issue that
 * owns it. **The list may only shrink.** An entry here is a promise that
 * someone else is retiring those tooltips, not permission to add more.
 */
const NOT_YET_SWEPT: ReadonlyArray<{ dir: string; reason: string }> = [
  { dir: 'scene/', reason: "#39 holds scene/palette.ts and theme/theme.css; the scene's three tooltips move once it lands" },
  { dir: 'replay/', reason: '#216 owns replay/mutating-calls-law.test.ts, which reads the surfaces a sweep here would edit' },
  { dir: 'concierge/', reason: '#216 owns concierge/explicit-invocation-law.test.ts, same coupling' },
  { dir: 'lab/', reason: "#235 owns lab/'s two law tests; lab/ is prd-28's territory besides" },
  { dir: 'tide/', reason: 'MarkHoverCard and the loupe are prd-30 wave 2 (#221) — they re-seat onto the card rather than being swept' },
]

/**
 * Comments blanked rather than stripped, so a failure message's line number
 * still matches the file the reader opens — the idiom
 * `disclosure/one-card-law.test.ts` established, and this file needs it for the
 * same reason: the prose above spells out the pattern it forbids, and several
 * of the swept files now carry a comment explaining what their `title=` used
 * to be.
 */
export function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_whole, lead: string) => lead)
}

/**
 * Every `title=` that is a real DOM attribute — the element it sits on resolved
 * by walking back from the attribute, never by taking the last tag on the line.
 *
 * Pure over `{name, text}` pairs so the rigged fixtures below can drive it
 * without touching the filesystem. `one-card-law.test.ts:28-31` states the
 * standard this is meeting: a grep law that has never been shown to fire is
 * decoration — it passes on an empty walk, on a typo'd regex, and on a
 * directory it never reached.
 */
export function nativeTitleSites(files: readonly SourceFile[]): string[] {
  const sites: string[] = []

  for (const file of files) {
    const lines = withoutComments(file.text).split('\n')

    lines.forEach((line, index) => {
      // `(?<![\w.])` so `subtitle=`, `entry.title=` and `chartTitle=` are not
      // attributes named `title`.
      const at = line.search(/(?<![\w.])title=/)
      if (at === -1) return

      // Only what precedes the attribute can be the element carrying it —
      // the value may itself contain markup (`title={<h2>…</h2>}`).
      let tag: string | null = null
      for (let cursor = index; cursor >= 0 && tag === null; cursor -= 1) {
        const text = cursor === index ? line.slice(0, at) : lines[cursor]
        const opens = text?.match(/<([A-Za-z][\w.]*)/g)
        if (opens !== null && opens !== undefined && opens.length > 0) {
          tag = opens[opens.length - 1]!.slice(1)
        }
      }

      // A capitalised (or dotted) tag is a component, and `title` is then an
      // ordinary prop — a heading, a label, anything its author meant.
      if (tag === null || !/^[a-z]/.test(tag)) return

      sites.push(`${file.name}:${index + 1} <${tag}>`)
    })
  }

  return sites
}

/**
 * Every shipped file that renders the card, and every test file that opens one.
 *
 * The second law below pairs them. It exists because the first one cannot see
 * the failure it is paired against: a surface can retire its `title=`, adopt
 * `<Disclosure>` — and have no test that ever opens the card. The residue law
 * stays green throughout, because there is no `title=` left to find.
 *
 * That is not hypothetical. It is what #220 shipped to review: nine of the
 * adopting surfaces had no test opening their card, while the build report
 * claimed focus parity was asserted for every one of them, and `Nav.test.tsx`
 * carried a comment pointing at a test that did not exist. The verify pass
 * caught it. This is what makes the next one fail out loud instead.
 */
function allFiles(root: string): SourceFile[] {
  const files: SourceFile[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      files.push({ name: path.relative(root, full).split(path.sep).join('/'), text: readFileSync(full, 'utf8') })
    }
  }

  walk(root)
  return files
}

/** Shipped files that render the card — the component, not merely its type. */
export function adoptingSurfaces(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => !/\.test\.tsx?$/.test(file.name))
    .filter((file) => !file.name.startsWith('disclosure/'))
    .filter((file) => /<Disclosure[\s/>]/.test(withoutComments(file.text)))
    .map((file) => file.name)
}

/** Directories holding a test that actually opens a card, via the shared helper. */
export function directoriesWithParityTests(files: readonly SourceFile[]): Set<string> {
  const dirs = new Set<string>()
  for (const file of files) {
    if (!/\.test\.tsx?$/.test(file.name)) continue
    if (!/\bdisclose(Text|TextOf)\s*\(/.test(withoutComments(file.text))) continue
    dirs.add(path.posix.dirname(file.name))
  }
  return dirs
}

function shippedFiles(root: string): SourceFile[] {
  const files: SourceFile[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry.name)) continue
      // Tests are excluded, and only tests: a law test must be able to WRITE
      // the pattern it forbids — this file does, twice, in the fixtures below.
      // `one-card-law.test.ts` draws the same line for the same reason.
      if (/\.test\.tsx?$/.test(entry.name)) continue

      const name = path.relative(root, full).split(path.sep).join('/')
      if (NOT_YET_SWEPT.some((entry) => name.startsWith(entry.dir))) continue
      files.push({ name, text: readFileSync(full, 'utf8') })
    }
  }

  walk(root)
  return files
}

describe('no surface explains itself with a native title attribute (prd-30, #220)', () => {
  it('finds none, anywhere the sweep reached', () => {
    const sites = nativeTitleSites(shippedFiles(WEB_SRC))

    expect(
      sites,
      `#220 retired all 50 of these. A native title= is OS-delayed, keyboard-invisible and absent on touch — charter §6 asks that whatever hover discloses, focus discloses.\nWrap the mark in <Disclosure> (disclosure/Disclosure.tsx) instead; if the mark is already a control, pass trigger="inline" (ADR-0040).\nFound:\n  ${sites.join('\n  ')}`,
    ).toEqual([])
  })

  it('actually reaches the files it claims to — the walk is not empty', () => {
    const files = shippedFiles(WEB_SRC)

    // A count would rot on every added file; what matters is that the walk got
    // into the directories the sweep touched, since a walk that silently
    // reached none would pass the law above having proved nothing.
    for (const dir of ['panels/', 'drawer/', 'recordings/', 'lane-page/', 'app/', 'why/', 'trace/', 'interaction/']) {
      expect(
        files.some((file) => file.name.startsWith(dir)),
        `the walk never reached ${dir} — this law is vacuous`,
      ).toBe(true)
    }
  })

  it('fires on a native attribute — the mutation the issue asked for', () => {
    const rigged: SourceFile[] = [
      { name: 'panels/fleet/index.tsx', text: '<td className="figures" title={costCellTitle(lane)}>{text}</td>' },
    ]

    expect(nativeTitleSites(rigged)).toEqual(['panels/fleet/index.tsx:1 <td>'])
  })

  it('does not fire on a prop named title, including one whose value is an element', () => {
    const rigged: SourceFile[] = [
      { name: 'app/PanelGrid.tsx', text: '<PanelFrame title="Fleet" onFocus={focus}>' },
      { name: 'drawer/index.tsx', text: '      title={<h2 className="truncate">{label}</h2>}' },
      { name: 'panels/burn/index.tsx', text: '<Figure testId="burn-rate" title={rate}>' },
      { name: 'lib/chart.ts', text: 'const subtitle= "x"; const chartTitle= "y"; el.title= "z"' },
    ]

    expect(nativeTitleSites(rigged)).toEqual([])
  })

  it('does not fire on the prose that explains it — comments are blanked, not read', () => {
    const rigged: SourceFile[] = [
      { name: 'drawer/Vitals.tsx', text: '/**\n * The native `title=` was here.\n */\n<div className="min-w-0">' },
      { name: 'panels/burn/index.tsx', text: '// was: title={outputHoverTitle(burn.tokens)}\n<span>{children}</span>' },
    ]

    expect(nativeTitleSites(rigged)).toEqual([])
  })

  it('names a reason for every directory it skips, and skips none it cannot name', () => {
    for (const entry of NOT_YET_SWEPT) {
      expect(entry.reason, `${entry.dir} is skipped with no reason`).not.toBe('')
      // Each reason names the issue or PRD that owns the residue, so this list
      // can be audited rather than trusted.
      expect(entry.reason, `${entry.dir}'s reason names no owner`).toMatch(/#\d+|prd-\d+/)
    }
  })
})

/**
 * THE SECOND HALF (#220, added after the verify pass).
 *
 * Retiring a tooltip and adopting the card is only half the promise. The other
 * half is charter §6 — whatever hover discloses, focus discloses — and the only
 * thing that proves it for a given surface is a test that opens that surface's
 * card. `disclosure/testing.ts`'s `discloseText` does exactly that: it opens by
 * mouse, closes, opens by focus, and throws unless the two markups are
 * identical. So "this directory has a test that calls it" is a real property,
 * not a proxy for one.
 *
 * **Directory granularity, and why not per file.** A test file's name does not
 * reliably name the component it renders — `lane-page/PageHeader.tsx` is
 * covered by `LanePage.test.tsx`, and `drawer/Vitals.tsx` by
 * `drawer/index.test.tsx`. A per-file rule would need a hand-maintained map,
 * which is a second place to forget. The directory rule is weaker but it is
 * honest about what it checks, and it catches the failure that actually
 * happened: a whole directory adopting the card with nothing opening it.
 */
describe('every surface that discloses has a test that opens it (charter §6)', () => {
  it('leaves no adopting directory unproven', () => {
    const files = allFiles(WEB_SRC)
    const covered = directoriesWithParityTests(files)

    const unproven = [
      ...new Set(
        adoptingSurfaces(files)
          .map((name) => path.posix.dirname(name))
          .filter((dir) => !covered.has(dir)),
      ),
    ].sort()

    expect(
      unproven,
      `these directories render <Disclosure> and no test in them opens a card, so nothing proves a keyboard user sees what a mouse user sees there.\nAdd one: import { discloseText } from '<...>/disclosure/testing.js' and assert on discloseText(mark) — it opens the card both ways and throws unless they match.\nUnproven:\n  ${unproven.join('\n  ')}`,
    ).toEqual([])
  })

  it('finds the adopting surfaces at all — the scan is not vacuous', () => {
    const surfaces = adoptingSurfaces(allFiles(WEB_SRC))

    // The sweep converted marks across eight directories; if this scan ever
    // returns a handful, it has stopped seeing them and the law above is
    // passing on an empty set.
    expect(surfaces.length).toBeGreaterThanOrEqual(12)
    expect(surfaces).toContain('panels/fleet/index.tsx')
    expect(surfaces).toContain('drawer/Vitals.tsx')
  })

  it('does not count a mention of the card in prose as an adoption', () => {
    const rigged: SourceFile[] = [
      { name: 'app/notes.tsx', text: '/** Wrap it in <Disclosure> one day. */\nexport const x = 1' },
      { name: 'app/real.tsx', text: '<Disclosure disclosure={d}>{children}</Disclosure>' },
    ]

    expect(adoptingSurfaces(rigged)).toEqual(['app/real.tsx'])
  })

  it('does not count a test that merely imports the helper without calling it', () => {
    const rigged: SourceFile[] = [
      { name: 'panels/x/index.test.tsx', text: "import { discloseText } from '../../disclosure/testing.js'\n// unused" },
      { name: 'panels/y/index.test.tsx', text: 'expect(discloseText(mark)).toContain("x")' },
    ]

    expect([...directoriesWithParityTests(rigged)]).toEqual(['panels/y'])
  })
})
