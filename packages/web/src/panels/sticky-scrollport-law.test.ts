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
 * declaration whose meaning quietly changed underneath it. Two decisions are
 * lawful, not one — the review that named this law offered both and left the
 * choice to the operator:
 *
 * - **own a scrollport** — `overflow-auto`/`overflow-y-auto`/
 *   `overflow-y-scroll` in the same file, so `top-*` sticks to the panel.
 * - **offset below the dock** — `top-(--dock-h)` instead of a bare `top-0`,
 *   so the element sticks to the DOCUMENT on purpose, landing exactly where
 *   the shell's sticky dock ends rather than fighting it for the same pixels.
 *   `--dock-h` is measured live in `Shell.tsx` (the dock's height is dynamic:
 *   the attention strip and the replay banner swap in and out) and published
 *   on the root, so any descendant can read it. `collisions/index.tsx` took
 *   this path (option B, the operator's own call, 2026-08-25).
 *
 * Coarse by the same measure the original law was: this reads a FILE, not a
 * single element, so a file mixing a lawful `top-(--dock-h)` sticky with an
 * unlawful bare `top-0` one elsewhere would pass wrongly — no worse than the
 * blind spot the scrollport check always had, and the same trade a grep law
 * over `.tsx` source makes everywhere in this repo.
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

/** The shell publishes the offset; `panels/` consumes it. This law reads both
 *  ends, because a `top-(--dock-h)` that resolves to nothing is not an error —
 *  it is `top: auto`, and a sticky element with `top: auto` silently does not
 *  stick at all. */
const SHELL = path.join(dirname, '..', 'app', 'Shell.tsx')
/** Option B (review of #65): stuck to the DOCUMENT on purpose, offset below
 *  the shell's own sticky dock rather than assuming a local scrollport. */
const DOCK_OFFSET_STICKY = /sticky\s+top-\(--dock-h\)/
const ANY_STICKY_TOP = /sticky\s+top-/

describe('sticky scrollport law: a vertically-sticky child needs a scrolling ancestor or a dock offset', () => {
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

  it('no panel declares `sticky top-*` without owning a scrollport or offsetting below the dock', () => {
    const offenders = panelSources()
      .map((file) => ({ ...file, code: withoutComments(file.text) }))
      .filter((file) => ANY_STICKY_TOP.test(file.code))
      .filter((file) => !VERTICAL_SCROLLPORT.test(file.code))
      .filter((file) => !DOCK_OFFSET_STICKY.test(file.code))
      .map((file) => file.name)

    expect(
      offenders,
      'a `sticky top-*` whose scrollport was removed now sticks to the DOCUMENT, ' +
        "behind the shell dock — either restore the panel's own overflow wrapper, " +
        'offset with `top-(--dock-h)`, or drop the sticky (see this file\'s header for #65)',
    ).toEqual([])
  })

  it('whoever offsets by `--dock-h` is answered — the shell still publishes it, measured', () => {
    /*
     * The sibling the law above cannot see (review of 13308c5). It pins the
     * CONSUMER's declaration; nothing pinned the PRODUCER's. Deleting the
     * `style={{ '--dock-h': ... }}` line from `Shell.tsx` left all 166 web
     * test files green, because an undefined custom property does not throw:
     * `top: var(--dock-h)` becomes invalid at computed-value time, `top` falls
     * back to its initial `auto`, and a `position: sticky` element with
     * `top: auto` simply never sticks. The headings would quietly go back to
     * scrolling away — the exact behaviour option B was chosen over — with no
     * test, no console error and nothing on screen to say so.
     *
     * Conditional on purpose: if no panel offsets by `--dock-h` any more, the
     * shell owes nobody a measurement and this stops applying.
     */
    const consumers = panelSources()
      .map((file) => ({ ...file, code: withoutComments(file.text) }))
      .filter((file) => DOCK_OFFSET_STICKY.test(file.code))
      .map((file) => file.name)
    if (consumers.length === 0) return

    const shell = withoutComments(readFileSync(SHELL, 'utf8'))
    expect(shell, 'Shell.tsx not found where this law expects it').toContain('export function Shell()')
    expect(
      shell,
      `${consumers.join(', ')} offset by --dock-h, so Shell must publish it — see this test's comment`,
    ).toContain('--dock-h')
    // Measured, not a constant: the dock's height changes when the attention
    // strip and replay banner swap. A hard-coded `--dock-h: 146px` would pass
    // the line above while being wrong in exactly the mode that motivated it.
    expect(shell, '--dock-h must be measured from the live dock, not hard-coded').toMatch(/ResizeObserver/)
    expect(shell, "the measured height must reach the dock's own element").toMatch(/ref=\{[^}]*[Rr]ef\}/)
  })

  it('the collisions table took the dock-offset path, not the scrollport one', () => {
    // Pins WHICH lawful answer #65's own follow-up chose, so a future edit that
    // silently swaps `top-(--dock-h)` back for a bare `top-0` still trips the
    // law above, but this test is the one that says the choice mattered.
    const file = panelSources().find((f) => f.name === path.join('collisions', 'index.tsx'))
    expect(file, 'collisions/index.tsx not found by the sweep').toBeDefined()
    const code = withoutComments(file?.text ?? '')
    expect(DOCK_OFFSET_STICKY.test(code), 'collisions lost its `top-(--dock-h)` offset').toBe(true)
    expect(VERTICAL_SCROLLPORT.test(code), 'collisions grew a scrollport back — the offset is no longer needed?').toBe(
      false,
    )
  })
})
