import type { RhizomorphEvent } from './index.js'

/**
 * THE UPCAST CHOKEPOINT — prd17 ruling 3, item 3: reserved between parse and
 * reduce so the day a migration is needed it has a home every event already
 * flows through, rather than one built after the fact.
 *
 * Retrofitting a chokepoint is the expensive half: by then there are folds in
 * the live stream, in replay, in the record reader, in the era corpus, and in
 * a hundred tests, and the migration has to find all of them. ADR-0011
 * rejected retrofitting for exactly that reason and chose this instead.
 *
 * **The seam is `reduce()` in `../reduce.ts`, and what it covers is the
 * `applyEvent`/`withEnvelope` half of the fold — all of it, live and replayed.**
 * `reduceAll` is `events.reduce(reduce, state)`, so every folding path bottoms
 * out in the one call; `upcast-chokepoint-law.test.ts` observes that rather
 * than asserting it, and pins that all three of `reduce()`'s own reads take the
 * upcast value.
 *
 * **The session-boundary question is asked OUTSIDE that seam, and this is the
 * sharp edge.** `opensNewSession` is exported, and three callers ask it
 * themselves — on the RAW event — before handing the same event to `reduce()`:
 * `packages/web/src/app/streamState.ts` (twice) and
 * `packages/app/src/host/stream-fold.ts`. It reads `payload.sessionId` and
 * `payload.repoPath`, which are among the likeliest fields a migration touches,
 * and the reset it decides is what discards state. So a migration that
 * canonicalises either field makes a replayed fold and a live fold disagree
 * about whether a session ended — breaking the "same function folds live and
 * replayed" identity `../reduce.ts` calls the whole reason replay is free.
 * Visit those three before anything else. Whether the boundary question should
 * move behind the seam is a design call, not something this comment decides.
 *
 * **Other raw readers are NOT enumerated here, on purpose.** Some surfaces read
 * a raw event's payload without folding it into `SessionState`, so they never
 * pass this function; a migration rewriting a payload leaves every one of them
 * reading the original. The first draft of this comment listed four such files
 * and review found ten; the second recorded a command scoped to one package and
 * review found nine more. A hand-kept list is the defect this issue exists to
 * close, one layer down, so what is recorded is the command — and its scope is
 * the part that was wrong twice:
 *
 * ```
 * grep -rl "event\.payload\|payloadOf(event)" packages \
 *   --exclude="*.test.*" --exclude-dir=node_modules --exclude-dir=dist
 * ```
 *
 * (Written without a `packages/<star>/src` glob on purpose: that spelling ends
 * in a close-comment and terminates this block. It did, once.)
 *
 * 21 files when this was written: 19 outside `packages/core`, plus two inside
 * it that are not readers at all — `../reduce.ts`, which IS the fold, and this
 * file, which only quotes the pattern. Re-run it on the day this stops being
 * identity; that, and confirming `reduce()` is still the only fold, are the two
 * things to check before trusting the paragraphs above.
 *
 * Identity today, deliberately: no migration is needed yet, and inventing a
 * shape for one that isn't would be guessing. `upcast-chokepoint-law.test.ts`
 * pins that — the day this stops being identity, its own assertion reddens and
 * the change has to argue itself in a diff, rather than drift in unnoticed the
 * way the reserved-but-unbuilt version of this file did for prd17's whole
 * lifetime.
 */
export function upcast(event: RhizomorphEvent): RhizomorphEvent {
  return event
}
