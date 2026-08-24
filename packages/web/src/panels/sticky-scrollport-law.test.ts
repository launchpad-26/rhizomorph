import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * A `sticky top-*` is a claim about a SCROLLPORT, and #65 removed one.
 *
 * `position: sticky` resolves against the nearest scrolling ancestor. A panel
 * that owns a `overflow-auto` wrapper therefore sticks its table header to the
 * top of ITSELF; a panel with no such wrapper sticks it to the top of the
 * DOCUMENT instead. The declaration is identical in both cases, which is what
 * makes the failure silent.
 *
 * #65 made the dock's panels grow with their content — deliberately deleting
 * their `flex-1 overflow-auto` wrappers so the page scrolls instead (see
 * `PanelGrid.tsx`). `collisions` kept `sticky top-0 z-(--z-sticky)` on its two
 * `<th>`s through that change, so its column headings detached from their own
 * table, pinned to the viewport's top edge, and sat there invisible beneath
 * the shell's opaque sticky dock (`--z-header`, 20 — a higher rung than
 * `--z-sticky`'s 10). A scrolled collision matrix showed no headings at all.
 *
 * The pairing is the whole law: whoever deletes a panel's scrollport has to
 * decide what happens to that panel's sticky children, rather than leaving a
 * declaration whose meaning quietly changed underneath it.
 *
 * Why a grep law and not a render test: jsdom has no layout engine and never
 * computes `position: sticky` at all, so no `@testing-library` assertion in
 * this repo can tell a working sticky header from a broken one — the same
 * reasoning `shell-bounds-law.test.ts` gives for reading a class string. The
 * same limit applies too: this proves the DECLARATIONS are consistent, not
 * that the rendered page is right. The browser pass is still the arbiter.
 *
 * `Shell.tsx`'s own dock is deliberately document-sticky and is out of scope
 * here by construction — this law reads `panels/` only, where a surface is a
 * guest inside a share it does not own.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url))

/** Blanks comments so a file's own prose about `sticky top-` cannot satisfy —
 *  or trip — a law that is meant to read its CODE. Mirrors `tokens.test.ts`. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_whole, lead: string) => lead)
}

function panelSources(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        out.push({ name: path.relative(dirname, full), text: readFileSync(full, 'utf8') })
      }
    }
  }
  walk(dirname)
  return out
}

const VERTICAL_SCROLLPORT = /overflow-auto|overflow-y-auto|overflow-y-scroll/

describe('sticky scrollport law: a vertically-sticky child needs a scrolling ancestor', () => {
  it('reads the files it claims to read — a law over an empty sweep passes vacuously', () => {
    const files = panelSources()
    expect(files.length).toBeGreaterThan(5)
    // The two surfaces the law exists for must actually be in the sweep, by
    // what they ARE and not by what they are called: one that still owns a
    // scrollport, and the one #65 took a scrollport away from.
    expect(files.map((f) => f.name)).toEqual(
      expect.arrayContaining([path.join('fleet', 'index.tsx'), path.join('collisions', 'index.tsx')]),
    )
  })

  it('no panel declares `sticky top-*` without owning a vertical scrollport', () => {
    const offenders = panelSources()
      .map((file) => ({ ...file, code: withoutComments(file.text) }))
      .filter((file) => /sticky\s+top-/.test(file.code))
      .filter((file) => !VERTICAL_SCROLLPORT.test(file.code))
      .map((file) => file.name)

    expect(
      offenders,
      'a `sticky top-*` whose scrollport was removed now sticks to the DOCUMENT, ' +
        'behind the shell dock — either restore the panel\'s own overflow wrapper ' +
        'or drop the sticky (see this file\'s header for #65)',
    ).toEqual([])
  })
})
