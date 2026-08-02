You are a worker agent on The Observatory. You own exactly one issue.

Context: the whole app is merged and green on main; this issue is about the
reliability of the test suite itself, which guards every merge.

YOUR ISSUE — #27 The test suite is intermittently red

**Fence (may touch ONLY):** `*.test.ts` / `*.test.tsx` files under `packages/server/src/` and `packages/web/src/`, plus `packages/server/vitest.config.ts` and `packages/web/vitest.config.ts` if isolation needs configuring. **Do not change production code** — if a test cannot be made deterministic without a production change, say so in your summary and stop rather than editing it.
**Model:** sonnet

The suite is **intermittently red**. Observed once on `main` immediately after
issue #26 merged: `Tests 1 failed | 329 passed (330)` — then 5 consecutive clean
runs of the same suite on the same commit, so it is a race, not a break. Earlier
today a different flake (an unawaited state transition in
`StreamContext.test.tsx`) blocked a merge outright, so this class of problem is
already costing real time.

A flaky suite is worse than a failing one here: the merge gate is the only thing
standing between a swarm of agents and `main`, and a gate that fails at random
trains everyone to ignore it.

Find and remove the nondeterminism. Likely sources, in order of suspicion:
- tests that bind a **real port** (a live `observatory` server runs on 4400 on
  this machine, and the dev may run more) — use port 0 / ephemeral ports, or
  inject a listener instead of binding.
- tests that read or write the **real** session-log location under `$HOME`
  (`~/.local/share/observatory/...`) while a live server is writing there — point
  them at a temp directory (e.g. `XDG_DATA_HOME` or an injected base path) and
  clean up.
- tests depending on **wall-clock timing** (`setTimeout`, `Date.now()`,
  arbitrary waits) — use fake timers or await an explicit condition.
- shared module-level state between test files running in the same worker.

**DoD:**
1. Name each nondeterminism you found and what you did about it.
2. Prove it: run the **root** suite **10 times consecutively** and report the
   pass count — it must be 10/10 — and do at least 3 of those runs *while a live
   observatory server is running on port 4400* (it already is; leave it alone),
   since that is the condition under which the failure appeared.
3. `npm run typecheck` green.

No NUL bytes. Do not push or merge.

RULES: stay strictly inside the FENCE (tests + vitest configs only); small
conventional commits; never push or merge; no NUL bytes; finish with a summary
that includes the 10-run evidence.
