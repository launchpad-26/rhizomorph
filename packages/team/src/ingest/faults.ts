/**
 * THE FAULT-POINT ROSTER (prd-51 ruling 4).
 *
 * Ruling 4 states two orderings and the issue's Definition of done requires
 * *"each clause is a test with an injected fault at that exact point"*. This
 * module declares the injection points and nothing else, so the roster is one
 * greppable list rather than four `options` bags scattered across the modules
 * that honour them.
 *
 * **These are a declared test seam, not an escape hatch.** Every point is
 * `undefined` on every production path — `startTeamServer` never sets one — and
 * they exist because the Definition of done forbids mocking the syscall
 * boundary: `writeSync` and `fsyncSync` are the real calls against a real file
 * in a real `mkdtempSync` directory, and only the *timing* is injectable. The
 * injected `Exec` behind `packages/core/src/collector.ts` is the same idea one
 * subsystem over.
 *
 * A hook throws to simulate the process dying at that instant. Nothing catches
 * one inside the module that calls it; `handleIngest` and `runOnce` turn it
 * into a refusal at their own boundary, which is what makes "no 202 was sent"
 * an observable fact rather than a claim.
 */

/** One injection point. Always `undefined` in production. */
export type FaultPoint = (() => void) | undefined

/**
 * The three points inside `journal.ts`'s `append`, in the order it calls them.
 *
 * Declared here rather than in `journal.ts` so the whole roster is one list;
 * `journal.ts` imports this type back, which is the one edge that runs from
 * `journal/` towards `ingest/` and is deliberate.
 */
export interface JournalFaults {
  /** Before a single byte is written. A death here must leave the journal untouched. */
  readonly beforeWrite?: FaultPoint
  /** After `writeSync` returns and before `fsyncSync`. The point the measured mutation loses a batch at. */
  readonly afterWriteBeforeFsync?: FaultPoint
  /** After `fsyncSync` returns. The record is durable; anything that fails from here is a retry, not a loss. */
  readonly afterFsync?: FaultPoint
}

/** Ordering 1's points: the journal's three, plus the gap between notifying the fold and writing the 202. */
export interface IngestFaults extends JournalFaults {
  /** After the fold queue is notified and before the response is produced. */
  readonly afterNotifyBeforeRespond?: FaultPoint
}

/** Ordering 2's points, in the order `../fold/worker.ts` calls them. */
export interface FoldFaults {
  /** After the journal is read and before the transaction opens. Nothing may have been written. */
  readonly afterReadBeforeBegin?: FaultPoint
  /** Inside the transaction, after the inserts and before the commit. Must ROLLBACK. */
  readonly afterInsertBeforeCommit?: FaultPoint
  /** After COMMIT and before the cursor moves. The rewind ruling 4 permits: costs time, not rows. */
  readonly afterCommitBeforeCursor?: FaultPoint
  /** After the cursor's temporary file is written and before the rename. The tmp file is not the cursor. */
  readonly afterCursorWriteBeforeRename?: FaultPoint
}
