You are a worker agent on rhizomorph (prd9: the trace era). You own
exactly one issue — a dogfooding fix with the diagnosis embedded.
Read the files your issue names before changing anything; import
from @rhizomorph/core; laws restated stronger, never weakened.

YOUR ISSUE — #138:

## Direction

Dogfooding-born: the conductor is unreachable from the lane page.
`/lane/main` and `/lane/conductor` both render the honest gap, while the
drawer reaches the conductor as the MAIN pseudo-lane (prd6) and the spend
ledger knows the telemetry lane `conductor`. The deepest lane in the
product — the one running the fleet — is the only one without a page.

Fix, keeping ONE canonical name:

1. `/lane/main` becomes the conductor's page — canonical, matching the
   drawer's MAIN pseudo-lane and the transcript API's `:lane = main`.
   The page resolves it through the SAME sources the drawer uses
   (conductor transcript; the conductor telemetry lane's spend; no
   worktree/branch — the header says what it is instead: the conductor,
   role glyph, no branch chip rather than an invented one).
2. `/lane/conductor` redirects (client-side) to `/lane/main` — the
   telemetry lane name should find the same page, not a gap.
3. The honest gap stays for genuinely unknown handles; add its test twin:
   `main` resolves, `conductor` redirects, `no-such-lane` gaps.
4. Trace column: the conductor has no spans until its CLI is relaunched
   with the env block — the EXISTING EmptyTrace honest-gap copy must
   show, not a blank (this is the common state; make it read as
   deliberate).

## Fence (may touch ONLY)

- `packages/web/src/lane-page/` (all files + tests)

## Blocked by

Nothing. **Model:** sonnet. **Wave:** dogfood (parallel with
`branch.removed` — fences disjoint).

## Definition of done

- `/lane/main` shows the conductor's conversation + spend (+ EmptyTrace
  gap until instrumented); `/lane/conductor` lands on the same page;
  unknown handles still gap — all three test-stated.
- No new route machinery — the existing `/lane/:handle` route serves it.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; if you
cannot proceed print "BLOCKED: <need>" and stop; DoD is root
'npm test' + 'npm run typecheck' green, then STOP with a short summary.
