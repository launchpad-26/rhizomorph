import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * THE LAWS THIS DIRECTORY IS HELD TO (prd-30 S1 acceptance · #554).
 *
 * Three source greps, because each of them polices something a behavioural
 * test cannot see: a component added tomorrow that draws its own card, reads
 * its own clock, or paints its own focus ring would pass every assertion in
 * `Disclosure.test.tsx` and still be the thing prd-30 exists to stop.
 *
 * **The first law says S1's whole sentence now (#221).** S1 asks for "a law test
 * asserts no other directory renders card chrome". Until #221 this file said
 * something narrower — it matched one string, `data-disclosure-card`, so it
 * caught a surface that *copied* this card and said nothing about a surface
 * that grew a different one. That narrowness was deliberate and is now paid.
 *
 * The three idioms prd-30 S1 named — *"`MarkHoverCard`, the loupe read-out and
 * every `title=`"* — resolved like this, and none of them is an exception:
 *
 * - **`title=`** was the third, and #220 retired all 50 of them. `app/
 *   title-residue-law.test.ts` is what keeps them gone.
 * - **The loupe read-out** (`tide/Loupe.tsx`) is not a disclosure at all. It has
 *   no `onMouseEnter` and no `onFocus`; it opens on zoom level
 *   (`tide/TideDock.tsx`, `{loupeOpen && <Loupe … />}`) and sits in the dock's
 *   grid flow rather than over anything. Nothing about it is hover chrome.
 * - **`MarkHoverCard`** (`tide/ChapterMarks.tsx`) *is* hover- and
 *   focus-triggered and *is* positioned — but every row inside it is a
 *   `<button>` that seeks to a timestamp. It is a menu of actions, and
 *   ADR-0043 rules that a menu is not card chrome: `DisclosureContent` is
 *   label/why/remedy, a vocabulary for conditions, and a list of places to jump
 *   to is not a condition.
 *
 * So the law below names nothing and needs no allowlist. That is the point —
 * an exception list is the allowlist this widening was written to end, and it
 * would silently cover the next hover panel someone adds in the same directory.
 *
 * **What "card chrome" means here**, in terms a later reader can apply to a
 * component that does not exist yet — three clauses, each doing work:
 *
 * 1. **A positioned panel.** Positioned (`absolute`/`fixed`, by class or by
 *    `style`) *and painting a surface* — a `--surface-*` background, or
 *    `role="dialog"`/`"tooltip"`. Both halves are needed: `ChapterMarks.tsx`
 *    is full of `absolute` mark glyphs that are positioned and are plainly not
 *    panels, so positioning alone would name the very file this law must leave
 *    standing.
 * 2. **Opened by hover or focus.** The file drives it with `onMouseEnter`,
 *    `onPointerEnter` or `onFocus`. This is what makes the law about
 *    *disclosure* rather than about overlays: a modal, a click-opened menu and
 *    a dock panel opened by a zoom level are all out.
 * 3. **Prose, not controls.** The panel contains no interactive element. This
 *    is the clause that lets a menu stand, and ADR-0043 records why it is a
 *    principled line rather than a carve-out: if you are showing someone words
 *    on hover, the instrument has one vocabulary for that and it is this card.
 *
 * The narrow marker law is **kept beside it**, not replaced. A file that copies
 * `data-disclosure-card` must still fail even if it renders no prose at all;
 * deleting that assertion in favour of the wider one would be weakening a law
 * rather than restating it (`CONTRIBUTING.md`).
 *
 * Every scanner here is a pure function over `{name, text}` pairs and is tested
 * against a rigged file that should trip it. A grep law that has never been
 * shown to fire is decoration: it passes on an empty walk, on a typo'd regex
 * and on a directory it never reached.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_SRC = path.resolve(HERE, '..')

interface SourceFile {
  name: string
  text: string
}

/** Every `.ts`/`.tsx` under `web/src`, recursively — tests included, so a test cannot host a second card either. */
function sourceFiles(root: string): SourceFile[] {
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

/**
 * Comments blanked rather than stripped, so a failure message's line count
 * still matches the file the reader opens. Copied in shape from
 * `theme/tokens.test.ts`, which needs it for the same reason: this file's own
 * prose names every pattern it forbids.
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_whole, lead: string) => lead)
}

/** Files that draw this card's chrome without being this card. */
export function cardChromeOutsideDisclosure(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => !file.name.startsWith('disclosure/'))
    .filter((file) => /data-disclosure-card/.test(withoutComments(file.text)))
    .map((file) => file.name)
}

/**
 * One component's source — a top-level `function X(…)` or `const X = (…) =>`
 * block, from its declaration to the next one.
 *
 * Per-block and not per-file because the clauses land on different scopes: the
 * trigger usually lives in a parent (`ChapterMarks` opens the card its child
 * `MarkHoverCard` draws), while "is a panel" and "has controls" are properties
 * of the panel itself. Judging controls file-wide would let any file with a
 * button anywhere escape, which is a far bigger hole than ADR-0043 admits to.
 */
export function componentBlocks(text: string): string[] {
  const lines = withoutComments(text).split('\n')
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (
      /^(export )?(export default )?(async )?function [A-Z]/.test(line) ||
      /^export default (async )?function/.test(line) ||
      /^(export )?const [A-Z]\w* = /.test(line)
    ) {
      starts.push(index)
    }
  })

  // **Every line lands in some block.** The declaration patterns above will
  // always miss something — `export default function` did, and a verify pass
  // caught it (#221): `starts` found only the *second* declaration, and the
  // whole component above it was sliced away. Not filtered, not rejected —
  // never scanned, which is the one failure a law must not have, because it is
  // silent and it looks like a pass.
  //
  // So the boundary is a floor, not a first match: anything before the first
  // recognised declaration is its own block. A pattern this misses now costs a
  // coarser split, never a blind spot.
  const boundaries = starts[0] === 0 ? starts : [0, ...starts]
  return boundaries.map((start, i) => lines.slice(start, boundaries[i + 1] ?? lines.length).join('\n'))
}

/** Positioned AND painting a surface — see clause 1 in the module note. */
function isPanel(block: string): boolean {
  const positioned =
    /className=(?:"|`|\{`)[^"`]*\b(?:absolute|fixed)\b/.test(block) ||
    /position:\s*['"](?:fixed|absolute)['"]/.test(block)
  const surface = /bg-\(--surface-/.test(block) || /role="(?:dialog|tooltip)"/.test(block)
  return positioned && surface
}

/** Anything a reader can operate. `onClick` counts: a div with a handler is a control wearing a div. */
function hasControls(block: string): boolean {
  return /<(?:button|a|input|select|textarea)[\s>]/.test(block) || /onClick=/.test(block)
}

/**
 * Files outside `disclosure/` that grow their own hover- or focus-triggered
 * explanation — prd-30 S1's sentence, at last (#221, ADR-0043).
 */
export function hoverExplanationsOutsideDisclosure(files: readonly SourceFile[]): string[] {
  return shipped(files)
    .filter((file) => !file.name.startsWith('disclosure/'))
    .filter((file) => {
      const text = withoutComments(file.text)
      // Clause 2 is file-scoped: the trigger is commonly in the parent.
      if (!/on(?:MouseEnter|PointerEnter|Focus)\s*=/.test(text)) return false
      return componentBlocks(file.text).some((block) => isPanel(block) && !hasControls(block))
    })
    .map((file) => file.name)
}

/**
 * What actually reaches a reader's screen. The two laws below scan this rather
 * than the whole directory, because a test file must be able to *name* the
 * thing it proves is absent — this file's own fixtures spell both forbidden
 * patterns out, and `Disclosure.test.tsx` asserts the trigger wears no ring
 * class by matching for one.
 */
function shipped(files: readonly SourceFile[]): SourceFile[] {
  return files.filter((file) => !/\.test\.tsx?$/.test(file.name))
}

/** Clock reads inside the card. Elapsed time is the caller's to compute — see `vocabulary.ts`. */
export function clockReads(files: readonly SourceFile[]): string[] {
  return shipped(files)
    .filter((file) => /\bDate\.now\s*\(|\bnew Date\s*\(|\bperformance\.now\s*\(/.test(withoutComments(file.text)))
    .map((file) => file.name)
}

/** Focus paint that is not the one token. */
export function handRolledFocus(files: readonly SourceFile[]): string[] {
  return shipped(files)
    .filter((file) => /focus-visible:|focus:ring|\bring-ice-|\boutline-\w/.test(withoutComments(file.text)))
    .map((file) => file.name)
}

describe('the walk reaches the tree it claims to', () => {
  it('sees the whole of web/src, not one directory of it', () => {
    // An empty or shallow walk is how all three laws below pass vacuously.
    const files = sourceFiles(WEB_SRC)
    expect(files.length).toBeGreaterThan(50)
    expect(files.map((file) => file.name)).toEqual(
      expect.arrayContaining(['disclosure/DisclosureCard.tsx', 'tide/ChapterMarks.tsx', 'app/StatusBar.tsx']),
    )
  })
})

describe('one card, and it lives here', () => {
  it('finds this card’s chrome nowhere outside `disclosure/`', () => {
    expect(cardChromeOutsideDisclosure(sourceFiles(WEB_SRC))).toEqual([])
  })

  it('would name a directory that copied the card instead of importing it', () => {
    // The mutation, run as a fixture: without this, the assertion above is
    // "no file matched a regex nothing was ever checked against".
    expect(
      cardChromeOutsideDisclosure([
        { name: 'panels/fleet/StateCell.tsx', text: '<div data-disclosure-card="">…</div>' },
        { name: 'disclosure/DisclosureCard.tsx', text: '<div data-disclosure-card="">…</div>' },
      ]),
    ).toEqual(['panels/fleet/StateCell.tsx'])
  })
})

/** A panel that opens on hover and says something — the shape the law is for. */
const A_HOVER_CARD = `function Mark() {
  const [open, setOpen] = useState(false)
  return (
    <span onMouseEnter={() => setOpen(true)}>
      mark
      {open ? <Panel /> : null}
    </span>
  )
}

function Panel() {
  return (
    <div className="absolute left-0 top-full bg-(--surface-panel) border">
      <p>no output for 6 minutes</p>
    </div>
  )
}`

describe('S1’s whole sentence: no directory grows its own hover explanation (#221, ADR-0043)', () => {
  it('finds none in the tree', () => {
    expect(hoverExplanationsOutsideDisclosure(sourceFiles(WEB_SRC))).toEqual([])
  })

  it('reaches the one file that could trip it, so the assertion above is not an empty set', () => {
    // `tide/ChapterMarks.tsx` is the only shipped file outside `disclosure/`
    // that opens a positioned panel on hover at all. A walk that stopped
    // reaching it would pass the law above having checked nothing, and would
    // look identical from the outside.
    const names = shipped(sourceFiles(WEB_SRC)).map((file) => file.name)
    expect(names).toContain('tide/ChapterMarks.tsx')
    expect(names).toContain('tide/Loupe.tsx')
  })

  it('names a hover-opened prose panel', () => {
    expect(hoverExplanationsOutsideDisclosure([{ name: 'panels/burn/Hint.tsx', text: A_HOVER_CARD }])).toEqual([
      'panels/burn/Hint.tsx',
    ])
  })

  it('names one opened by focus alone — the keyboard half is the whole point of charter §6', () => {
    const onFocusOnly = A_HOVER_CARD.replace('onMouseEnter', 'onFocus')
    expect(hoverExplanationsOutsideDisclosure([{ name: 'why/Hint.tsx', text: onFocusOnly }])).toEqual(['why/Hint.tsx'])
  })

  it('names one positioned through `style` rather than a class', () => {
    const styled = A_HOVER_CARD.replace(
      'className="absolute left-0 top-full bg-(--surface-panel) border"',
      `role="tooltip" style={{ position: 'fixed', left: 4, top: 8 }}`,
    )
    expect(hoverExplanationsOutsideDisclosure([{ name: 'trace/Hint.tsx', text: styled }])).toEqual(['trace/Hint.tsx'])
  })

  it('does not name a menu — the MarkHoverCard shape, written as a fixture rather than by naming the file', () => {
    // ADR-0043's third clause. Every row is a control, so it is a list of
    // places to jump to, not a condition with a why and a remedy.
    const menu = A_HOVER_CARD.replace(
      '<p>no output for 6 minutes</p>',
      '{rows.map((row) => (<button key={row.ts} onClick={() => onSeek(row.ts)}>{row.label}</button>))}',
    )
    expect(hoverExplanationsOutsideDisclosure([{ name: 'tide/ChapterMarks.tsx', text: menu }])).toEqual([])
  })

  it('does not name a panel nothing opens on hover or focus — the loupe shape', () => {
    const inFlow = A_HOVER_CARD.replace('onMouseEnter={() => setOpen(true)}', 'data-open={open}')
    expect(hoverExplanationsOutsideDisclosure([{ name: 'tide/Loupe.tsx', text: inFlow }])).toEqual([])
  })

  it('does not name a positioned mark that paints no surface', () => {
    // Clause 1's second half. `ChapterMarks.tsx` is full of these — `absolute`
    // glyphs on the timeline — and positioning alone would name the very file
    // this law exists to leave standing.
    const glyph = `function Marks() {
  return (
    <span onMouseEnter={show}>
      <span className="absolute bottom-0 left-1/2 h-2.5 w-0.5 bg-(--color-working)" />
    </span>
  )
}`
    expect(hoverExplanationsOutsideDisclosure([{ name: 'tide/ChapterMarks.tsx', text: glyph }])).toEqual([])
  })

  it('does not name the card itself', () => {
    expect(hoverExplanationsOutsideDisclosure([{ name: 'disclosure/Disclosure.tsx', text: A_HOVER_CARD }])).toEqual([])
  })

  it('does not name a hover card described in prose — comments are blanked, not read', () => {
    const inComment = `/*\n${A_HOVER_CARD}\n*/\nexport const x = 1`
    expect(hoverExplanationsOutsideDisclosure([{ name: 'app/notes.tsx', text: inComment }])).toEqual([])
  })

  it('reads the same twice — the scanner accumulates, and a stateful helper would not show up once', () => {
    const files = [{ name: 'panels/burn/Hint.tsx', text: A_HOVER_CARD }]
    expect(hoverExplanationsOutsideDisclosure(files)).toEqual(hoverExplanationsOutsideDisclosure(files))
    expect(hoverExplanationsOutsideDisclosure(files)).toEqual(['panels/burn/Hint.tsx'])
  })

  it('sees a card declared with `export default function`, above another declaration', () => {
    // The verify pass's finding (#221). `export default function` matched none
    // of the declaration patterns, so `starts` found only the LATER `function
    // Helper`, and everything above it — the whole card — was sliced off and
    // never scanned. Silent, and indistinguishable from a pass.
    const hidden = `export default function Card() {
  return (
    <span onMouseEnter={open}>
      <div className="absolute bg-(--surface-panel)"><p>no output for 6 minutes</p></div>
    </span>
  )
}

function Helper() {
  return null
}`
    expect(hoverExplanationsOutsideDisclosure([{ name: 'panels/x/Card.tsx', text: hidden }])).toEqual([
      'panels/x/Card.tsx',
    ])
  })

  it('never drops a line, whatever the declaration patterns miss', () => {
    // The invariant, and the reason the fix is a floor rather than one more
    // pattern: the patterns will always miss something, so what has to hold is
    // that missing one costs a COARSER SPLIT and never a blind spot. This test
    // survives a future syntax nobody has thought of; a list of patterns does
    // not.
    const odd = `const helper = 1

export default async function Weird() {
  return <div onMouseEnter={x} className="fixed bg-(--surface-panel)"><p>hi</p></div>
}

const lowercaseComponent = () => null

export const Named = () => null`

    const blocks = componentBlocks(odd)
    // Every line of the (comment-stripped) source appears in exactly one block.
    expect(blocks.join('\n')).toBe(odd)
  })

  it('splits a file into its component blocks, so a button elsewhere does not shield a card', () => {
    // The hole this avoids: judged file-wide, any file containing a control
    // anywhere would escape the law entirely.
    const both = `${A_HOVER_CARD}

function Unrelated() {
  return <button onClick={go}>go</button>
}`
    expect(componentBlocks(both).length).toBe(3)
    expect(hoverExplanationsOutsideDisclosure([{ name: 'panels/x/Both.tsx', text: both }])).toEqual([
      'panels/x/Both.tsx',
    ])
  })
})

describe('the card reads no clock', () => {
  it('reads none in `disclosure/`, so replay and live render identically', () => {
    // S1's *replay* state: elapsed times are relative to the scrub position,
    // which is only possible while the caller owns the subtraction. A clock in
    // here would silently report ages against a time the reader is not at.
    expect(clockReads(sourceFiles(HERE))).toEqual([])
  })

  it('would name a card that reached for the clock itself', () => {
    expect(
      clockReads([
        { name: 'DisclosureCard.tsx', text: 'const age = Date.now() - observedAt' },
        { name: 'Disclosure.tsx', text: 'const age = now - observedAt' },
      ]),
    ).toEqual(['DisclosureCard.tsx'])
  })

  it('does not count a clock named in prose — the scanner reads code, not comments', () => {
    expect(clockReads([{ name: 'a.ts', text: '// a card that called Date.now() would lie\nconst x = 1' }])).toEqual([])
  })
})

describe('one focus idiom, and it is not ours (prd-32 ruling 9, #548)', () => {
  it('paints no focus of its own anywhere in `disclosure/`', () => {
    // #548 deleted three hand-rolled idioms; this directory landed after it and
    // has no excuse to add a fourth. The token is `focus-ring`, from `theme.css`.
    expect(handRolledFocus(sourceFiles(HERE))).toEqual([])
  })

  it('would name a file that hand-rolled one', () => {
    expect(
      handRolledFocus([
        { name: 'Disclosure.tsx', text: 'className="outline-none focus-visible:ring-1 focus-visible:ring-notice"' },
        { name: 'DisclosureCard.tsx', text: 'className="focus-ring rounded"' },
      ]),
    ).toEqual(['Disclosure.tsx'])
  })

  it('confirms the trigger wears the token in the source, not only in a render', () => {
    const trigger = readFileSync(path.join(HERE, 'Disclosure.tsx'), 'utf8')
    expect(trigger).toContain("'focus-ring'")
  })
})
