You are a worker agent building The Observatory. You own exactly one issue.

FIRST read docs/architecture.md, packages/server/src/api/stream.ts (what the
server really sends) and packages/web/src/hooks/useEventStream.ts (the bug).

YOUR ISSUE — #17

**Fence (may touch ONLY):** `packages/web/src/hooks/useEventStream.ts`, `packages/web/src/hooks/useEventStream.test.ts`
**Model:** sonnet. **Severity: this breaks the whole app in a real browser.**

The dashboard never shows live data. Panels sit on "Waiting for data…" and the
scene falls back to "DEMO DATA — AWAITING STREAM", even though the server is
streaming real events (verified with `curl -N http://localhost:4400/api/stream`:
`worktree.discovered`, `branch.updated`, `pane.activity`, `agent.status`).

Root cause — a mismatch across the server/web boundary:

- `packages/server/src/api/stream.ts` writes **named** SSE events: each frame has
  an `event: <type>` line (e.g. `event: worktree.discovered`).
- `packages/web/src/hooks/useEventStream.ts` subscribes with `source.onmessage`
  only. Per the SSE spec, `onmessage` fires **only for frames with no `event:`
  name** (default type `message`). Named frames require
  `addEventListener('<type>', …)`.

So every event is received by the browser and silently dropped.

Why the tests passed: `useEventStream.test.ts` drives a fake source by calling
`onmessage` directly, so the double does not behave like the real server. That is
the deeper defect — fix the double, not just the code.

**Fix:** make the hook consume the stream the server actually produces. Subscribe
by name for every event type in the core schema (derive the list from core — do
not hand-maintain a copy) and keep the unnamed `onmessage` path working too, so
either framing folds correctly. Keep `EventSourceLike` mockable, but widen it to
include `addEventListener`/`removeEventListener` and clean up listeners on unmount.

**DoD:**
1. A regression test where the fake source emits **named** frames exactly as the
   server does, and the reducer state proves they were folded. This test must fail
   against the current implementation.
2. Existing unnamed-frame behaviour still covered.
3. `npm test` and `npm run typecheck` green from the repo root.
4. Live proof: with the server already running on port 4400, run
   `curl -sN --max-time 5 http://localhost:4400/api/stream | head -20` and confirm
   the `event:` lines your listeners now match; paste it in your summary.

No NUL bytes. Do not push or merge.

RULES: stay in the fence; small conventional commits; never push or merge;
no NUL bytes; finish with a summary including the live evidence.
