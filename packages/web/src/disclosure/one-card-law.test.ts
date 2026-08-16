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
 * **On the first law's scope, stated plainly.** S1's acceptance asks for "a law
 * test asserts no other directory renders card chrome". The honest version of
 * that today is narrower than the sentence, and here is why: `MarkHoverCard`
 * (`tide/ChapterMarks.tsx`) and the loupe read-out are *shipped card chrome in
 * other directories right now*, and re-seating them is wave 3's work, fenced
 * away from this one deliberately (prd-30 *sequencing*: the sweep "touches 25
 * files and collides with everything otherwise"). A law written to the full
 * sentence would fail on landing, so wave 1 would have to disable it — and a
 * disabled law is worth less than a narrow one. So the law lands on **this
 * card's own markers**: a surface that reimplements *this* card instead of
 * importing it fails, which is the direction the risk actually runs in now
 * that the card exists. When wave 3 retires the three idioms, the same test
 * widens to the full sentence with the allowlist empty.
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
