# 0031. The recorder hands out a frozen fold

- **Status:** accepted
- **Date:** 2026-08-26

## Context and Problem Statement

prd-40 ruling 2 made the recorder maintain its fold incrementally, and #3's
identity law pins `foldSoFar()` to returning *the same object* on every read —
that identity is what makes "no re-fold on any route" hold regardless of how a
caller reaches it.

Returning the recorder's only fold by reference means a caller can mutate it.
Unlike `reduceAll()`, which hands every caller a private fold, there is exactly
one here, and `foldDesynced` is set only when `reduce` throws — never when a
caller writes. So a caller's mutation is silent, permanent for the session, and
has no repair path. `/api/meta` became the first such caller in #5.

## Considered Options

1. **Deep-freeze the fold on every assignment**, return type unchanged.
2. **`Readonly<SessionState>` on the return type.**
3. **A deep-readonly type on the return.**
4. **A freeze gated to non-production.**
5. **Copy on read.**

## Decision Outcome

**Option 1.** Every assignment to the recorder's fold goes through one private
setter that deep-freezes, so every fold handed out is frozen. A caller's write
throws instead of corrupting.

Options 2 and 3 lose on cascade, not on principle. `foldSoFar()`'s return is
assigned to `LadderManifest.folded: SessionState` (`api/meta.ts:143`) and flows
to `selectConnection(state: SessionState)` in `packages/core`; any readonly
return type breaks that chain and propagates into core's selector signatures.
Option 2 would pay that cost and still miss nested writes, which are the ones
that corrupt. Option 4 loses because the server senses no environment anywhere
today, and because the cost does not require a gate: freezing short-circuits on
already-frozen subtrees, so each event freezes roughly what `reduce` allocated
for it. Option 5 loses outright — it breaks #3's identity law and reintroduces
the per-read cost growing with session length that prd-40 ruling 2 removed.

## Consequences

- **The reducer is now held to its purity contract on this path.** `reduce`
  receives a frozen state as input. ADR-0002 already requires purity, and the
  audit for this decision found the fold's only in-place mutation is
  `indexUsageRecord`, which writes `UsageIndex` — kept outside `SessionState`
  by #179 precisely so the state slice stays copyable. If some arm is impure it
  now throws in strict mode rather than corrupting silently. That is a bug
  surfaced, not a cost introduced — but it surfaces as a test failure, and
  whoever hits it should read it that way.
- **A caller going through `as any` can still mutate.** The freeze makes the
  write throw; it does not make the type system stop someone who has opted out
  of it. This closes the silent-corruption failure mode, not every route to it.
- Freezing is not free. It is bounded by what each event allocates rather than
  by session length, and that bound is asserted as a count rather than trusted.
- The fold is frozen in production too, not only in tests. That is deliberate:
  a gate would buy a little speed and give up the guarantee exactly where the
  sessions are longest.
