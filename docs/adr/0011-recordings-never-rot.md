# 0011. Recordings never rot: lenient parse, a reserved `upcast()`, and a golden era corpus

- **Status:** accepted
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06, the same day the decision landed
> (`6d5e9e4`, `da10e54`, `94f2c24`, `18c8d1a`, `2c99a5c`). All rejected options
> are cited, two of them from the code's own comments.

ADR-0009 makes a record portable, which means a record outlives the code that
wrote it. Today's reader will one day open a recording from an older schema, or
a stranger's recording carrying event types it has never seen.

Three failure modes follow, and the third was a verified defect rather than a
hypothetical: the parser **silently skipped** unknown event types, which made the
reducer's forward-compatibility arm unreachable in practice. The instrument would
have shown a confident, quietly incomplete replay.

## Considered Options

For the unknown-line problem:

- **A — Skip unknown lines silently** (the status quo).
- **B — Fail the whole record** on any unrecognised line.
- **C — Count and voice**: keep parsing, report what was not understood.

For future schema migration:

- **D — Add a migration chokepoint when the first migration is needed.**
- **E — Reserve an identity `upcast()` now**, on the path every fold takes.

For pinning the reducer's meaning:

- **F — `toMatchFileSnapshot`** for the golden corpus.
- **G — Plain string equality** against a committed snapshot.

## Decision Outcome

Chosen: **C**, **E** and **G**.

**A was rejected** as *"the silent skip this ruling exists to abolish"* — it is
the dishonest failure, and it disabled forward compatibility without anyone
noticing. **B** was rejected implicitly: one unknown line from a newer emitter
should not make a record unreadable, which is the whole point of reserving room
for strangers.

**D was rejected in `upcast.ts`'s own comment**, and the argument generalises:

> Retrofitting a chokepoint is the expensive half: by then there are folds in the
> live stream, in replay, in the record reader, in the era corpus, and in a
> hundred tests, and the migration has to find all of them.

So `upcast()` sits between parse and reduce, does nothing today, and is pinned as
an identity function by a law test. It costs one call now to avoid an archaeology
project later.

**F was rejected explicitly** so that `vitest -u` cannot silently re-bless a
regression. The corpus asserts plain string equality against committed bytes —
one real recording per era, folded and compared byte-for-byte in CI. A snapshot
tool that can update itself is not a law.

## Consequences

**Good.** An unrecognised event is now a counted, voiced fact rather than a
silent omission, so a replay's completeness is visible rather than assumed.

**Good.** The corpus pins the reducer's *meaning*, not just its shape. A change
that alters what a real recording folds to fails CI with a byte diff.

**Bad — `upcast()` is speculative by construction.** It does nothing, exists for
a migration that has not happened, and needs a test-only observer slot to be
assertable at all, since an identity function is otherwise indistinguishable from
no function. There is exactly one era. Deleting it is a live suggestion (#247),
and this ADR is the argument against: the cost of *not* having it is paid at the
worst possible moment.

**Bad — "era" overclaims.** The directory name reads like a versioning scheme; it
is a corpus of one, and no `era-2` exists or is scheduled. The migration story is
a designed placeholder, not a built system.

**Bad — one law of this ruling is unresolved.** Fold order (arrival vs
timestamp) is pinned by a fixture but decided in neither direction — see
ADR-0002 and issue #205.
