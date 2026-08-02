You are a worker agent on The Rhizomorph. You own exactly one issue.

The app is fully built, merged and pushed; 336 tests green. Read
docs/architecture.md for context if you need it.

YOUR ISSUE — #31 (31. Finish the flake audit — one async race left (12% under load))

**Fence (may touch ONLY):** test files (`*.test.ts` / `*.test.tsx`) and `src/test/` helpers under `packages/web/`, plus `packages/web/vitest.config.ts`. **No production code.**
**Model:** sonnet

#28 removed the lazy-import race in `App.test.tsx` and the failure rate under
load fell from 8/12 to 0/12 for that test. The class of bug is not gone: the same
symptom has now surfaced in a different test.

Measured on main after #28, 8 runs at **4 concurrent suites**: **1 failure / 8**

```
× loads a session and folds state up to the scrubber position   1166ms
```

(previously: 8/12 before #27, 3/12 after #27, and the App.test.tsx case is now
0/12 — so this is the last known member of the family, not a regression.)

Do the audit rather than the single fix: find **every** web test whose assertion
depends on an async boundary it does not deterministically await — dynamic
imports, unawaited fetch stubs, promise chains resolved across microtask hops,
`waitFor` racing real work. Apply the #28 treatment: make the dependency resolve
before the assertion, or stub the boundary so no race exists. Raising timeouts is
not a fix.

**DoD — measured, not asserted:**
1. Root suite **16 runs with 4 concurrent** (4 batches of 4): **0 failures**.
2. Quiet run: root `npm test` + `npm run typecheck` green.
3. List every test you changed and which async boundary it was racing.

Reproduce load with:
`for c in 1 2 3 4; do ( npm test >/tmp/r-$c.log 2>&1; echo $? >/tmp/rc-$c ) & done; wait`

No NUL bytes. Do not push or merge. Do not run anything on port 4400 (live demo server).

RULES: stay strictly inside the FENCE (another agent works in parallel);
small conventional commits; NEVER switch branches, and never run git
commands in a sibling worktree — a previous worker accidentally committed
to main that way; never push or merge; no NUL bytes; finish with a short
summary containing your measurements/output.
