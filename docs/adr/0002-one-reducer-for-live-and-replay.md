# 0002. One event log, one reducer, serving both live and replay

- **Status:** accepted
- **Date:** 2026-08-06

## Context and Problem Statement

> **Reconstructed.** Written 2026-08-06 from git history, `docs/architecture.md`
> and code comments. The decision was blessed 2026-07-30 (`9d32c5b`) before any
> code and landed the same day (`b635da6`, `b936e23`). Decision and rejected
> alternatives are both cited, including one alternative that was tried in
> production code and reverted.

The instrument has to show a live fleet *and* let an operator scrub back through
a finished session. The obvious construction — a live path that accumulates
state as events arrive, and a separate replay path that reads a file — means two
implementations of the same meaning. They drift. When they drift, the replay is
quietly lying about what the operator saw at the time, and there is no way to
notice.

`docs/architecture.md:18` calls this *"the one structural decision that
matters."*

## Considered Options

- **A — Separate live and replay code paths.** Each optimised for its own case.
- **B — One append-only JSONL log, folded by a single pure
  `reduce(state, event)` used by both.**
- **C — B, plus a state library (Redux/Zustand) in the web app.**

## Decision Outcome

Chosen: **B**. Every fact is an event in one append-only log. A single pure
reducer folds it. Live and replay are the same function over the same data, so
replay is not a feature that can drift — it is the same code with a different
source.

**A** was rejected because the identity *is* the point, not an implementation
convenience. `reduce.ts:31` states it in the code itself.

**C** was rejected as redundant: with one tree and one fold there is nothing for
a store to add (`architecture.md:139`, *"no state library — one tree, one
store"*).

**A variant of A was actually tried and reverted.** The ledger panel called
`reduceAll(state.events)` and threw away the shell's incremental state — a second
fold of the same log, in production. `b8655e5` fixed it, `4ac72fb` proved the two
paths were bit-identical, and `abfac99` banned re-folding with a source-grep law
so it could not come back. That the mistake was made *after* the decision is the
argument for having written it down.

## Consequences

**Good.** Replay came free. The portable record (ADR-0009) is verifiable because
there is exactly one definition of what a log means. Selectors over the folded
state are pure and shared by server and web.

**Bad — the fold became a hot spot.** Folding the whole log per event does not
scale, forcing keyframed incremental folding across four commits (`8dd0e12`,
`f12b4b3`, `e587639`, `b6ec6ab`).

**Bad — an open correctness defect the decision created.** Live folds in *arrival*
order; replay folds in *timestamp* order. For a log where those differ, one
recording yields two states — and the whole point of the decision was that it
could not. Pinned by a fixture but unresolved in either direction (`18c8d1a`,
issue #205, `architecture.md:1888`). No document in this tree states or implies a
guarantee about fold order, and none should be inferred until #205 is ruled.

**Bad — the identity is narrower than it reads.** Three surfaces read state the
log never sees: `/api/lanes` (reads `.swarm/lanes.json` per request),
`/api/transcript/:lane` (reads the agent's own JSONL) and the OTel collector's
attribution path. Replay returns `available: false` for these honestly, so the
code does not lie — but "live and replay are the same reducer" is true of the
fold, not of the whole dashboard.

## Amendment — the fold-order defect is resolved (2026-08-24)

The second Bad consequence is history: the operator ruled #205 as option 1, "append order
is the truth", and replay now folds the log's own order unconditionally —
`packages/web/src/replay/replayFold.ts` (`buildSessionIndex`, `foldFrom`, `foldUpTo`)
keeps its ts-sort for time navigation only, and `replayFold.test.ts` proves the divergence
gone against the era-1 recording that exposed it. `docs/record-format.md` carries the
per-actor append-order law. The consequence's closing sentence — "none should be inferred
until #205 is ruled" — no longer binds: the guarantee exists and is stated. The original
divergence fixture in `core/src/reduce.test.ts` still describes the pre-ruling world in
its prose; correcting that witness is named follow-up work in prd17's 2026-08-24
amendment.

## Note — that follow-up is done (2026-09-04)

Appended rather than folded into the section above, per `README.md`: a dated
record says what was true on its date, and the sentence about the stale witness
was true on 2026-08-24. It is no longer.

> The witness named in the closing sentence — the prose and local `foldReplay`
> helper of `core/src/reduce.test.ts`'s divergence fixture — has been corrected
> under #268. That fixture now states the ruled law: core owns the reducer's
> half (the reducer is order-sensitive on three axes, so the fold-order choice
> is load-bearing, and the committed era-1 snapshot is the append-order fold),
> while `replayFold.test.ts` owns the implementation's. The `ts`-sorted fold
> survives only as the named counterexample that keeps the law from being a
> rule about nothing — mutation-proven: making `reduceAll` ts-sort reddens
> twelve tests, nine of them in that block.
>
> An earlier attempt at this note rewrote the 2026-08-24 section in place,
> putting 2026-09-04 work inside a dated record. Review caught it. This is what
> `README.md` asks for instead, and the mistake is recorded here because the
> log is the only place it would otherwise be invisible.

