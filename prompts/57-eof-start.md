You are a worker agent on The Observatory (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — why this work exists — then
research/2026-07-31-prd2-audit-findings.md (file:line evidence) and
research/2026-07-31-prd2-live-baseline.md (what the dashboard showed
before your fix), then the files your issue names. Wave A goal: a
fresh boot starts at zero, timestamps are the source own, a restart
resumes instead of re-recording.

YOUR ISSUE — #57 (57. sessionlog: start at EOF on first sight; carry the line timestamp; backfill by config)

**Fence (may touch ONLY):** `packages/server/src/collectors/sessionlog/` (the whole directory: `collector.ts`, `parse-session-line.ts`, `tail.ts`, `types.ts`, tests, fixtures)
**Blocked by:** #56. **Model:** sonnet. **Wave: A**

The single biggest lie in the baseline: 896M tokens on the spend ticker at
boot with zero work dispatched. `collector.ts:249` starts every unseen file
at `offset: 0`, so the first poll ingests every line ever written — the git
collector already got this right (it only loads commits when a previous
snapshot exists; that asymmetry is the bug shape). And
`parse-session-line.ts` never extracts the line's own `timestamp`, so even
backfilled history is stamped "now".

- **Start at end-of-file on first sight.** A file with no persisted offset
  and no backfill request seeks to its current size and emits nothing for
  what came before. A file whose offset came from a rehydrated snapshot
  (#56's store, wired by #58) is *seen*, not new — it resumes from that
  offset. This must hold per-file, so a log that appears mid-run is also
  EOF-started.
- **Backfill is opt-in.** New `backfill?: boolean` on
  `SessionlogCollectorConfig` (default false) restores today's read-from-zero
  behaviour. CLI flag wiring is #58's — do not touch `cli/`.
- **Carry the line's real time.** Extract `timestamp` in
  `parseAssistantLine` (add it to `AssistantLineFacts`; check the fixtures —
  real captured lines carry an ISO timestamp) and emit `llm.usage` /
  `tool.activity` through #56's source-ts seam so a backfilled event is dated
  when it happened, not when it was read. A line with no parsable timestamp
  falls back to tick time.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Tests must prove: first
sight of a populated fixture file emits nothing without backfill and
everything with it; a rehydrated offset resumes exactly (no gap, no repeat);
emitted events carry the fixture line's own timestamp. Never push, merge, or
run git in a sibling worktree — committing on YOUR branch is required. Finish
with a short summary including any live evidence the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
