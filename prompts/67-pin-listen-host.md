You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — why this work exists — then the files your
issue names. This one was found by the first live CI run going red:
the workflow is correct, the bug is real.

YOUR ISSUE — #67 (67. Pin the server listen host: CI runner bound [::1] while everything promises 127.0.0.1)

**Fence (may touch ONLY):** `packages/server/src/cli/index.ts`, `packages/server/src/cli/index.test.ts`
**Blocked by:** #58 (same fence, in flight). **Model:** sonnet. **Wave: A (CI follow-up)**

The first-ever CI run (run 30595373931, on `fd0fe71`) failed 2/641 — and both
failures are one real portability bug, not test noise. The workflow did its
job.

On the GitHub runner, `app.listen({ port })` bound the IPv6 loopback and the
CLI reported `http://[::1]:39601`, while the test (and the README, and every
doc) promises `http://127.0.0.1:<port>`. The second failure is the same
cause: the "port in use" fixture bound 127.0.0.1, the CLI's listen went to
`::1`, no collision happened, so the clean-EADDRINUSE path never fired.
A stranger's machine can hit either behaviour depending on their IPv6 stack —
exactly the "anyone, anywhere" defect class.

- Pin the listen host explicitly (`host: '127.0.0.1'`) where `runCli` calls
  `app.listen` — the printed URL, the docs, and the EADDRINUSE detection then
  agree on every machine.
- Add/adjust a test asserting the reported URL is `127.0.0.1` (the existing
  assertions already expect this — they should pass unchanged once the bind
  is pinned; say so in your summary if any needed touching).
- Rebase on main AFTER #58 lands (your fence overlaps its work — that is why
  you are blocked).

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Never push, merge, or run
git in a sibling worktree — committing on YOUR branch is required. Finish
with a short summary including any live evidence the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
