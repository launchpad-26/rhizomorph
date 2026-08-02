You are a worker agent on The Rhizomorph. You own exactly one issue.

Read packages/web/src/App.test.tsx first — it contains the established
vi.mock treatment for exactly this class of flake (issues #28/#31).

YOUR ISSUE — #42

**Fence (may touch ONLY):** `packages/web/src/app/PanelGrid.test.tsx`, `packages/web/src/app/PanelFrame.test.tsx`, `packages/web/src/test/**` (helpers). **No production code.**
**Model:** sonnet

Issue #39's new tests reintroduced the lazy-import race that #28/#31 fixed
elsewhere. Measured at the landing gate, 4x concurrent suites: **4 failures / 8
runs**, always these tests, always timeouts (6.3s, 2.8s, 8.9s, 8.8s):

```
× can collapse and re-expand the scene slot
× renders every panel expanded by default, collisions included
```

Cause: `PanelGrid` mounted with every panel expanded resolves ALL the lazy
panel chunks; the assertions race those dynamic imports, and under CPU
contention the imports lose. These tests are on main now, so the merge gate is
flaky for everyone until this lands.

Fix per the house rule (no timeout widening): apply the #28 treatment —
`vi.mock` the lazy panel modules (see `packages/web/src/App.test.tsx` for the
existing precedent) or preload them before asserting. The tests must still
prove what they meant to prove: default-expanded state incl. collisions, and
collapse/re-expand round-trip.

**DoD — measured:** root suite 12 runs at 4x concurrency (3 batches of 4):
**0 failures**. Quiet root `npm test` + `npm run typecheck` green. State which
approach you used and why the race is now impossible. No NUL bytes; never
push/merge; no git in sibling worktrees.

Reproduce load: for c in 1 2 3 4; do ( npm test >/tmp/r-$c.log 2>&1; echo $? >/tmp/rc-$c ) & done; wait

RULES: fence is tests+helpers only; small conventional commits; no NUL
bytes; never push/merge; no git in sibling worktrees; STOP with a summary
containing the 12-run measurement.
