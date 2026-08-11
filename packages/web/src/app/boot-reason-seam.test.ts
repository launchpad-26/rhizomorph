import { describe, expect, it } from 'vitest'
// Deliberate, test-only cross-package edge — the same one
// `recordings/label-seam.test.ts` opens, and for the same reason: the seam
// this file exists to prove is web↔server, so the server's REAL list comes in
// by path. The law's sweep excludes test files; no non-test file under
// packages/web/src may import server source (ADR-0003).
import { SESSION_BOOT_REASONS } from '../../../server/src/log/session-log.js'
import { bootExplanation, KNOWN_BOOT_REASONS } from './StatusBar.js'

/**
 * THE BOOT-REASON SEAM (#384).
 *
 * `/api/meta` serves `lastBootReason` straight off `decideSessionBoot`
 * (`cli/run.ts`, `api/meta.ts`), and the provenance bar validates it against
 * its own local `KNOWN_BOOT_REASONS` — returning `null`, i.e. the whole
 * session voice reads *unavailable*, for anything that list doesn't hold
 * (`StatusBar.tsx`'s `parseBootFacts`). That fallback is deliberate and stays:
 * an unknown reason must never be half-trusted. What is NOT deliberate is a
 * reason the server can actually emit falling into it — the instrument saying
 * "I don't know" about something it does know, which this repo treats as the
 * worst failure it has.
 *
 * **Nothing else catches this.** The retarget spike (#265) checked, and found
 * zero compile-time forcing functions: the web declares its own union and
 * shadows the type name locally, so `bootExplanation`'s exhaustive switch is
 * exhaustive over a LOCAL union that no server-side widening reaches, and
 * `packages/web/src` cannot import `@rhizomorph/server` anyway. The rejected
 * alternative — hoist the union into browser-safe `core` and have both sides
 * read it — would trade away the forward-compat posture above and is a
 * layering change of its own. So: this test, not that refactor.
 *
 * The drift it exists to stop had already happened when it was written.
 * `writer-alive` has been emitted since #187 (`log/session-log.ts`, and
 * `api/meta.test.ts` pins that `/api/meta` carries it), and the bar never
 * learned it — so a boot that refused to resume because another live process
 * holds the session rendered as *unavailable* instead of explaining itself.
 * This file went red on exactly that before the bar was widened.
 */

/**
 * Reasons the bar can explain that the server cannot yet emit. Forward-compat
 * is legal in this direction ONLY — the bar knowing a word early costs
 * nothing, while the server saying a word the bar doesn't know costs the
 * whole session voice.
 *
 * Every entry is a standing debt, so each names the issue that will pay it,
 * and the second law below forces it out of this list the moment the server
 * can emit it — a graduated reason left here would let a real member hide
 * behind a comment about the future.
 *
 * - `retargeted`: prd20 ruling 5's repo switch closes the session in the old
 *   repo's directory and opens one here (#384 widened `SESSION_CLOSE_REASONS`
 *   to match). `SessionBootReason` learns it with the route that reports it,
 *   #390 — the bar learns it now so that boot is never the first one to
 *   discover the bar can't read it.
 */
const FORWARD_ONLY: readonly string[] = ['retargeted']

describe('the boot-reason seam: the bar can explain everything the server can say (#384)', () => {
  it('has both lists to compare at all — an empty sweep proves nothing', () => {
    expect(SESSION_BOOT_REASONS.length).toBeGreaterThan(5)
    expect(KNOWN_BOOT_REASONS.length).toBeGreaterThan(5)
  })

  it('LAW: every reason the server can emit is one the provenance bar knows', () => {
    const known = new Set<string>(KNOWN_BOOT_REASONS)
    const unexplainable = SESSION_BOOT_REASONS.filter((reason) => !known.has(reason))
    expect(
      unexplainable,
      `server boot reasons the provenance bar would render as "unavailable": ${unexplainable.join(', ')} — ` +
        'add them to KNOWN_BOOT_REASONS in StatusBar.tsx (and give each a bootExplanation case)',
    ).toEqual([])
  })

  it('LAW: a reason the bar knows early is declared forward-only, and graduates once the server can emit it', () => {
    const serverReasons = new Set<string>(SESSION_BOOT_REASONS)

    // Nothing in the bar's list is unaccounted for: it is the server's list
    // plus the declared forward-only entries, exactly.
    const undeclared = KNOWN_BOOT_REASONS.filter(
      (reason) => !serverReasons.has(reason) && !FORWARD_ONLY.includes(reason),
    )
    expect(
      undeclared,
      `KNOWN_BOOT_REASONS holds ${undeclared.join(', ')}, which the server cannot emit and FORWARD_ONLY does not claim — ` +
        'a typo looks exactly like this',
    ).toEqual([])

    // …and a forward-only entry the server has since learned must move out of
    // the list, or the list quietly becomes a lie about what is still pending.
    const graduated = FORWARD_ONLY.filter((reason) => serverReasons.has(reason))
    expect(
      graduated,
      `${graduated.join(', ')} is a real SessionBootReason now — drop it from FORWARD_ONLY here`,
    ).toEqual([])
  })

  it('LAW: a reason the bar knows is a reason it can put into words', () => {
    // Knowing a reason is only worth anything if it reaches a real sentence.
    // `bootExplanation`'s switch is exhaustive over this union, so a member
    // added without a case is a TypeScript error — but a case returning
    // something empty or placeholder-shaped is not, and that would pass the
    // `.includes()` check while telling the operator nothing.
    for (const lastBootReason of KNOWN_BOOT_REASONS) {
      const text = bootExplanation({ resumedCount: 0, resumeWindowMs: 4 * 60 * 60 * 1000, lastBootReason })
      expect(text.length, `${lastBootReason} has no explanation`).toBeGreaterThan(20)
      expect(text, `${lastBootReason} explains itself with a placeholder`).not.toMatch(/TODO|FIXME/i)
    }
  })
})
