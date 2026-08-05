You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

The audit report is docs/research/2026-08-05-adversarial-audit.md — read its P1 ledger finding first. The one-line identity is proven; your job is the proof, the law test, and the honest measurement.

YOUR ISSUE — #171:

## Direction

From the 2026-08-05 adversarial audit; **conductor-verified at code level**.

`packages/web/src/panels/ledger/index.tsx:43`:

```ts
const session = useMemo(() => reduceAll(state.events), [state.events])
```

`state.events` gets a fresh array identity on every event
(`streamState.ts:67`), so this memo misses every event and re-reduces the
WHOLE log from zero — while `state.session`, one line below in the same fold,
IS that fold, maintained incrementally. `reduceAll(events)` is
`events.reduce(reduce, initialSessionState())` — byte-identical to
`state.session` by construction, in live AND replay (replay's context state is
folded the same way over the same prefix). The census: every other surface
reads `state.session`; the ledger is the lone offender. `streamState.ts:12`'s
own docstring states the law this violates.

At the measured 55,049-event session this is ≥55k reduce calls on the main
thread per arriving event — and it re-inflicts the exact quadratic #166 just
fixed, on the same reconnect path (the fold trilogy's fourth member).

Fix:

1. `const session = state.session` — that's the fix. The `connected` guard at
   line 70 may stay on `state.events.length`.
2. **Prove the identity, then pin the class**: assert ledger rows are
   byte-identical before/after on fixtures and on a replay prefix; then add a
   law test that NO panel imports `reduceAll` — the shell owns the fold
   (grep-law over `panels/**` source, the same style as the drawer's
   readonly test).
3. Report the before/after cost the honest way: interleaved rounds under
   matched load (#157's lesson), sizes 5k/15k/55k.

## Fence (may touch ONLY)

- `packages/web/src/panels/ledger/` (all files, incl. the new law test)

## Blocked by

Nothing — disjoint from the TIDE lanes. **Model:** sonnet. **Wave:** audit-surgical.

## Definition of done

- Ledger reads `state.session`; identity proven; no-panel-refolds law
  test-stated; before/after reported.
- Root `npm test` + `npm run typecheck` green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
