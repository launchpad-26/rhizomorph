import type { DisclosureContent } from '../disclosure/index.js'

/**
 * THE NEWER-ERA CAVEAT, IN ONE PLACE (#389, prd-30 w4).
 *
 * It was written out twice — in `Banner.tsx` and in `index.tsx` — as two
 * identical native `title=` strings kept in step by hand. One builder, two
 * readers: the banner over the panels discloses it, and so does the line under
 * the session picker. prd-30's whole problem statement is *two surfaces
 * phrasing one condition differently*, so the sentence lives here and both
 * surfaces read it rather than each carrying a copy.
 *
 * **A neutral module rather than a constant on either consumer.** Neither
 * `Banner.tsx` nor `index.tsx` imports the other today, and adding an edge in
 * either direction purely to reach a module-level value is the import-cycle
 * hazard `why/NearestEntry.tsx`'s `JUMP_TO_NEAREST` note already records — a
 * cycle around a module-level constant is how it ends up `undefined` at
 * evaluation time.
 *
 * **`elapsedMs: 0`**, in core's own register for a fact re-derived on every
 * render (`app/Nav.tsx`'s `disabledNavDisclosure` is the idiom): the condition
 * is read back out of the fold each time the surface draws, so it is confirmed
 * just now rather than a dated observation. No clock is read here — the
 * disclosure directory forbids it, and a card that called `Date.now()` in
 * replay would report an age against a clock the reader is not looking at.
 *
 * **The remedy is an action, not a `none`.** The events were *preserved*, not
 * dropped (ADR-0011 — recordings never rot), so a build that knows the newer
 * era folds them on the next read. That is a real next act, and saying "nothing
 * to do" would be false.
 */
export function unknownEraDisclosure(): DisclosureContent {
  return {
    label: 'events from a newer era',
    // Ported verbatim from the `title=` this retires, on both surfaces (#389).
    why: {
      reason:
        'this recording came from a newer instrument; these events were kept in the log but this build cannot fold them',
      evidence: {
        fact: 'the fold preserved them verbatim and no reducer in this build claims their type',
        elapsedMs: 0,
      },
    },
    remedy: {
      kind: 'action',
      action:
        'update this instrument to a build that knows the newer era — the events stay in the log until it does, and fold on the next read',
    },
  }
}
