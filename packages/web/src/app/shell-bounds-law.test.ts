import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * #655's law — the document never scrolls SIDEWAYS; a descendant's own
 * overflow does, or it clips.
 *
 * `prd-04`'s amendment 3 originally said the document never scrolls on either
 * axis. That was enforced on the vertical axis by `Shell`'s
 * `grid-rows-[auto_minmax(0,1fr)_auto_auto]` and not enforced at all on the
 * horizontal one: the grid declared no columns, so the single implicit column
 * sized to `auto`, and a grid item's automatic minimum width is its CONTENT.
 * One over-wide descendant — the attention strip's `shrink-0` retrospective
 * region — grew the track, the grid and the document to 1758px inside a
 * 1225px viewport, carrying the nav off the left edge.
 *
 * **The vertical half was reversed live (2026-08-24)** at an operator's
 * explicit request — `PanelGrid.tsx`'s own comment has the full account: the
 * dock now grows with its content and the document scrolls vertically on
 * purpose. The horizontal half is untouched and stays a hard law: nothing
 * about wanting a taller page argues for a wider one, and the 1758px bug had
 * nothing to do with vertical space — it was one `shrink-0` descendant with
 * no floor, the same failure mode this file's third test still guards.
 * `Shell`'s row and column bounds no longer need to move together; they
 * always protected two different failure modes that happened to share one
 * fix at the time this file was written.
 *
 * Why a grep law and not a render test: jsdom has no layout engine. It reports
 * every width as 0, so no `@testing-library` assertion in this repo can
 * distinguish a bounded grid from an unbounded one — which is precisely how
 * ~6,000 green tests had nothing to say about a defect a human saw in one
 * glance. The same reasoning `target-size-law.test.ts` gives for asserting the
 * WCAG 2.5.8 class string rather than a measured box applies here, and the
 * same limit applies too: this law proves the DECLARATION is present, not that
 * the rendered page fits. The browser pass is still the arbiter.
 *
 * Kept deliberately narrow. It reads two facts, each one the direct cause of a
 * measured symptom, rather than trying to police flex minimums tree-wide — a
 * law that fired on every `shrink-0` in the codebase would be noise, and would
 * be deleted the first week it cost someone an afternoon.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url))
const SHELL = path.join(dirname, 'Shell.tsx')
const STRIP = path.join(dirname, '..', 'panels', 'attention', 'AttentionStripView.tsx')

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

describe('shell bounds law: the document does not scroll, a panel does', () => {
  it('reads the files it claims to read — a law over a moved file passes vacuously', () => {
    expect(read(SHELL)).toContain('export function Shell()')
    expect(read(STRIP)).toContain('data-testid="waited-chips"')
  })

  it("Shell's grid still bounds its COLUMN — the row bound moved on purpose, this one has not", () => {
    const shell = read(SHELL)
    // Horizontal overflow was never wanted for any reason, including this
    // one — #655's actual bug (one over-wide descendant, nothing to do with
    // page length) still needs this. The row track deliberately no longer
    // matches it (`auto` there now, so PanelGrid's content sets the page's
    // height) — see this file's own header comment for why the two bounds
    // stopped needing to move together.
    expect(shell).toContain('grid-cols-[minmax(0,1fr)]')
    expect(shell).not.toMatch(/grid-cols-\[\d+fr/)
  })

  it('the strip\'s retrospective region can yield — it is memory, not a summons', () => {
    const strip = read(STRIP)
    const marker = 'data-testid="waited-chips"'
    const at = strip.indexOf(marker)
    expect(at).toBeGreaterThan(-1)
    // The container's own className, not the whole file: `shrink-0` is correct
    // on plenty of other nodes here (the age counter, the duration), and a
    // file-wide ban would be wrong.
    //
    // The FIRST className after the marker, with no fixed window. A window was
    // the first version, and it failed on its own commit: the explanatory
    // comment added beside the attribute pushed `className` past a 700-char
    // slice, so the law reported an empty string and read as a violation of
    // the very fix it shipped with. A guessed span over source text is a
    // measurement that breaks when the prose around it grows.
    const className = /className="([^"]*)"/.exec(strip.slice(at))?.[1] ?? ''
    expect(className, `waited-chips className was: ${className}`).toContain('min-w-0')
    expect(className, 'the quiet region must be the first thing to give way').not.toMatch(/\bshrink-0\b/)
    expect(className, 'it still clips rather than wrapping the docked strip taller').toContain('overflow-hidden')
  })

  /**
   * #464 — the `+N` marker must not live INSIDE the element that clips.
   *
   * It used to be the clipping row's last child, which made it the first thing
   * an overflowing row pushed out: the one element whose entire job is to say
   * that something is hidden. Measured in Chromium on fixture 3 before the fix,
   * at 1440x900, the row had 563px for 1522px of chips and the marker sat at
   * x=2381 — 941px past the right edge of the viewport.
   *
   * Asserted on the source for the reason this whole file exists, stated in its
   * header: jsdom has no layout engine, so no render assertion in this repo can
   * see a clipped box. This proves the DECLARATION — that the marker is a
   * sibling of the clipping element and not its descendant. **The browser pass
   * is still the arbiter**, and #464's PR records one at 1440x900 and at the
   * 1100px WINDOW_MIN_WIDTH floor.
   */
  it('the attention strip\'s +N marker is a SIBLING of the clipping row, never inside it', () => {
    const strip = read(STRIP)
    const marker = 'data-testid="chip-overflow"'
    const clip = strip.indexOf('overflow-hidden">')
    const at = strip.indexOf(marker)
    expect(clip, 'the chip row no longer declares overflow-hidden').toBeGreaterThan(-1)
    expect(at, 'the +N marker is gone entirely').toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(clip)

    // The clipping element must CLOSE before the marker opens. If the marker
    // were still a child there would be no `</div>` between the two, which is
    // exactly the shape that shipped the defect.
    const between = strip.slice(clip, at)
    expect(
      between,
      `no closing tag between the clipping row and the marker — the marker is inside it again. Between was: ${between}`,
    ).toContain('</div>')
  })
})
