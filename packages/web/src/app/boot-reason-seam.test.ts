import { describe, expect, it } from 'vitest'
// Deliberate, test-only cross-package edge — the same one
// `recordings/label-seam.test.ts` opens, and for the same reason: the seam
// this file exists to prove is web↔server, so the server's REAL list comes in
// by path. No non-test file under packages/web/src may import server source,
// which is exactly why the two lists below cannot be one list.
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
 * and the second law below holds this list to it from both sides: an entry
 * here must actually be in `KNOWN_BOOT_REASONS` (or the declaration is a
 * promise the bar never kept), and it must leave this list the moment the
 * server can emit it (or a real member hides behind a comment about the
 * future). Neither direction is optional — the first was missing until review
 * of #392 walked the hole.
 *
 * Empty since #389, and that is the mechanism working rather than the list
 * going away. `retargeted` was its one entry: the bar learned prd20 ruling 5's
 * word ahead of any server that could say it, and the graduation law above
 * turned red the moment `SESSION_BOOT_REASONS` learned it too. The fix was
 * deleting one string. (#384's note named #390 as the issue that would pay the
 * debt; #390 turned out to be the client's fold reset, and `POST /api/retarget`
 * — #389 — is the route that actually reports the boundary.)
 */
const FORWARD_ONLY: readonly string[] = []

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

    // …and the promise is kept in the first place. Review of #392 walked the
    // three checks above over a bar with `retargeted` deleted outright,
    // FORWARD_ONLY still claiming it, and found all of them green: the first
    // skips it (the server cannot emit it yet), the second iterates the bar's
    // list, which no longer holds it, and the third finds it is not a server
    // reason. Every check passed over a bar that had dropped the exact
    // forward-declared promise this list exists to make. The window is bounded
    // — once #390 lands, law 1 catches the absence — but that window is
    // precisely what FORWARD_ONLY is for, so it is the one place the guarantee
    // has to be airtight.
    const known = new Set<string>(KNOWN_BOOT_REASONS)
    const missing = FORWARD_ONLY.filter((reason) => !known.has(reason))
    expect(
      missing,
      `${missing.join(', ')} is declared forward-only but the bar does not actually know it — ` +
        'either add it to KNOWN_BOOT_REASONS in StatusBar.tsx, or stop claiming it here',
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
