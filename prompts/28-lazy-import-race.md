You are a worker agent on The Observatory. You own exactly one issue.

Context: the app is merged, green and pushed. This issue is about the test
suite's reliability under concurrent load — it guards every merge, and a
previous attempt (#27) only reduced the failure rate.

YOUR ISSUE — #28

**Fence (may touch ONLY):** `packages/web/src/App.test.tsx`, `packages/web/src/app/ConnectionBadge.test.tsx`, `packages/web/src/test/` (shared test helpers, new files allowed), `packages/web/vitest.config.ts`. **No production code.**
**Model:** sonnet

#27 shrank this but did not cure it. Measured, 12 runs per side at **4 concurrent
suites** (the real condition — several agents' gates running at once):

| branch | failures |
|---|---|
| main before #27 | **8 / 12** |
| after #27 (widened timeouts) | **3 / 12** |

The failure is always the same shape:

```
× renders the instrument shell — scene slot, panel grid, replay bar   1360–3957ms
  TestingLibraryElementError: Unable to find an element with the text: Worktrees
  (also seen: Collisions, Commit ticker, and in ConnectionBadge: replay)
```

Root cause: these tests assert on content that only exists **after a lazily
imported chunk resolves** (`React.lazy` panels behind the shell's Suspense slots).
The assertion races the dynamic import. Under CPU contention the import takes
longer than the matcher's window, so the test fails. **Widening the timeout only
moves the goalpost** — at 4x load it still loses one run in four, and a gate that
fails 25% of the time is not a gate.

Remove the race instead of out-waiting it. Either:
- **await the lazy modules before asserting** — resolve the same dynamic imports
  the component will use (e.g. `await import('./panels/worktrees/index.js')`, or a
  shared `preloadPanels()` helper in `src/test/`) so the chunks are already in the
  module cache when render happens; or
- **stub the lazy boundaries** for these tests so no dynamic import occurs at all,
  asserting the shell's composition rather than the panels' internals.

Pick one and say why. Do not solve this by raising timeouts further; if you find a
case that genuinely needs a longer timeout, justify it explicitly.

**DoD — measured, not asserted:**
1. Run the root suite **12 times with 4 running concurrently** (3 batches of 4,
   as above) and report failures: must be **0 / 12**.
2. Quiet run: root `npm test` + `npm run typecheck` green.
3. State which approach you chose and why the race is now impossible rather than
   merely unlikely.

No NUL bytes. Do not push or merge.

To reproduce the load condition, run four suites at once, e.g.:
  for c in 1 2 3 4; do ( npm test >/tmp/run-$c.log 2>&1; echo $? >/tmp/rc-$c ) & done; wait
then check each /tmp/rc-* for a non-zero exit.

RULES: stay strictly inside the FENCE (tests + test helpers + vitest config
only; NO production code); small conventional commits; never push or merge;
no NUL bytes; finish with a summary containing the 12-run measurement.
