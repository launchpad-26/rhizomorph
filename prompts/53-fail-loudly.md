You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — it explains why this work exists — then the
files your issue names. The acceptance test for this whole prd is that a
stranger on a fresh machine can run the app from the README alone, so
prefer being explicit and loud over being clever.

YOUR ISSUE — #53 (53. Fail loudly: missing build, port in use, non-git dir, invisible collectors)

**Fence (may touch ONLY):** `packages/server/src/server/build-app.ts`, `packages/server/src/server/build-app.test.ts`, `packages/server/src/collectors/git/git-collector.ts`, `packages/server/src/collectors/git/git-collector.test.ts`, `packages/web/src/app/StatusBar.tsx`, `packages/web/src/app/StatusBar.test.tsx`
**Model:** sonnet. **Wave: D**

> **Conductor regroom 2026-07-31:** the port-in-use fix moved to #52, which owns
> `cli/index.ts`. Do not touch that file.

Three silent failures a stranger will hit, each currently invisible:

1. **Missing web build → bare JSON 404.** `build-app.ts:12` skips the static
   route when `dist` is absent, with no log. The stranger opens the URL and gets
   Fastify's `{"message":"Route GET:/ not found"}`. Log a clear warning at boot
   naming the build command, and serve a minimal HTML page saying the same thing
   in the browser.
2. **Non-git directory → `collector.error` every 2 seconds, forever.**
   `git-collector.ts:32-41` reports and returns without latching, unlike every
   other collector (tmux, workmux and sessionlog all latch `disabled: true`).
   Latch it after the first report; unbounded JSONL growth is the current cost.
3. **Status bar shows 3 of 5 collectors.** `StatusBar.tsx:7-9` lists
   git/tmux/workmux; `sessionlog` and `otel` have no dot, so the most likely
   stranger failure (no Claude session logs) is invisible in the UI.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (this
web test family has been flaky three times — no `waitFor` racing an async
boundary); no NUL bytes. Never push, merge, or run git in a sibling worktree —
committing on YOUR branch is required. Paste terminal evidence for (1) and (2).

RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
