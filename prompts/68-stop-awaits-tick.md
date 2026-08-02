You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own exactly one issue — a race found by the landing gate running
the suite at 4x concurrency. Read the issue carefully; the fix is in
the production stop() contract, never in test timeouts.

YOUR ISSUE — #68 (68. PollLoop.stop() must await the in-flight tick (unhandled ENOENT under load))

**Fence (may touch ONLY):** `packages/server/src/server/poll-loop.ts`, `packages/server/src/server/poll-loop.test.ts`, `packages/server/src/cli/index.ts`, `packages/server/src/cli/index.test.ts`
**Blocked by:** — . **Model:** sonnet. **Wave: B (load-gate find)**

Found by the landing gate's 4x load batch while gating #63 (1 failure in 8
runs; quiet runs green): an **unhandled rejection** out of
`cli/index.test.ts > "--fresh starts a new session, ignoring the abandoned
session's offsets"`:

```
Error: ENOENT: no such file or directory, open '…/session-1700000000000.jsonl'
  ❯ SessionLogWriter.append packages/server/src/log/session-log.ts:40
  ❯ SessionRecorder.record packages/server/src/server/recorder.ts:44
  ❯ tick packages/server/src/server/poll-loop.ts:108
```

Root cause: `PollLoop.stop()` clears the interval but does **not** await a
tick already in flight. The test awaits `handle.stop()`, tears down its temp
dir — and the still-running tick then writes into a deleted directory. Under
load the window opens reliably. This is a production defect, not test noise:
any real shutdown has the same race between the last tick and whatever
happens after "stopped".

- Make `stop()` honest: it returns a promise that resolves only when no tick
  is running (await the in-flight tick; the `ticking` flag already exists —
  hold the tick's promise instead of a boolean). Update `CliHandle.stop` to
  await it before closing the app.
- Do not fix this by having the test sleep, retry, or widen a timeout — the
  race must be removed, not dodged (standing rule).

**DoD:** root `npm test` + `npm run typecheck` green; then the discriminating
measurement: 2 batches of 4x concurrent `npm test` with ZERO failures and
ZERO unhandled errors (this is the gate's own load check — state the result
in your summary). No NUL bytes. Never push, merge, or run git in a sibling
worktree — committing on YOUR branch is required.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
