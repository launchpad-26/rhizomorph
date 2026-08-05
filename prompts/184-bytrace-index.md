You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

Read #179's LANDED diff first — it is the pattern (derived index, laws verified against broken implementations, byte-diffed selectors). You are its sequel across the trace slice.

YOUR ISSUE — #184:

## Direction

The other eleven seconds. #179's re-measurement found that after its index
landed, ~90% of the remaining full-mix fold cost is ONE line in the
`trace.span` fold:

```ts
{ ...traces.byTrace, [traceId]: [...] }
```

— an object spread of the ENTIRE byTrace map on every span event. Standalone
cost at N = 5k/15k/30k/55k: **50 / 518 / 2,367 / 8,866 ms** (#179's bench,
three passes each). This was ~70% of what #174 originally measured — the
audit's P2 was right about the super-linear shape and only partly right about
the mechanism. At the measured session mix this is ~11s of a day-long
session's boot recovery and the dominant remaining term in the replay index
build.

Why #179 did not fix it, correctly: `TraceState`'s key set is pinned by an
out-of-fence oracle, and moving the `byTrace` index out of recorded state is
a prd9 contract question, not a drive-by. So this lane inherits the decision
deliberately:

1. **Give `byTrace` the #179 treatment** — a derived index that is carried
   forward structurally instead of re-spread per event. Options to argue in
   your summary: persistent-map-style structural sharing on the existing
   shape, or moving `byTrace` out of the value shape into a derived table
   with an index-is-derived law (the #179 precedent — it wrote exactly this
   pattern for the telemetry slice; read its landed diff first).
2. **The fold identity is the constitution.** Oracle tests stay green
   untouched; new laws follow #179's discipline — each law verified against
   a deliberately broken implementation before being kept; byte-identical
   serialisation of the traces slice old-vs-new.
3. **Selector compatibility proven**, not asserted: diff the outputs of every
   trace selector (the waterfall tree, span sums, exemplar picks) on the
   real-mix fixture.
4. **Re-run #174's bench before/after** — DoD is the full-mix lane finally
   flattening toward the spanless lane's curve.
5. No wire/disk migration: verify (as #179 did) that nothing serialises
   SessionState; if the shape moves, the JSON-round-trip pin in state.test.ts
   moves with it, stronger.

## Fence (may touch ONLY)

- `packages/core/src/reduce.ts`, `packages/core/src/reduce.test.ts`
- `packages/core/src/state.ts`, `packages/core/src/state.test.ts`
- `packages/core/src/reduce.bench.test.ts`
- `packages/core/src/traces/` (all files, if the trace fold lives there)
- `packages/core/src/selectors/` (all files) — compatibility only
- the trace oracle test file that pins TraceState's key set (name it in your
  first commit message; it is in-fence FOR STRENGTHENING ONLY — a law may be
  restated stronger, never loosened to admit the new shape)

## Blocked by

#179 landed on main (its diff is the pattern; its bench is the instrument).
**Model:** opus (same contract class as #179). **Wave:** audit-fix 2.

## Definition of done

- Full-mix curve flattened and reported; identity/oracle laws green; trace
  selectors byte-diffed identical; boot recovery of a 55k session reported
  before/after end-to-end.
- Root `npm test` + `npm run typecheck` green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
