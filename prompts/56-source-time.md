You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — why this work exists — then
research/2026-07-31-prd2-audit-findings.md (file:line evidence) and
research/2026-07-31-prd2-live-baseline.md (what the dashboard showed
before your fix), then the files your issue names. Wave A goal: a
fresh boot starts at zero, timestamps are the source own, a restart
resumes instead of re-recording.

YOUR ISSUE — #56 (56. Keystone A: events carry the source real time; snapshots survive restarts)

**Fence (may touch ONLY):** `packages/core/src/collector.ts`, `packages/core/src/collector.test.ts`, `packages/core/src/events/index.ts`, `packages/server/src/server/poll-loop.ts`, `packages/server/src/server/poll-loop.test.ts`, `packages/server/src/server/snapshot-store.ts` (new), `packages/server/src/server/snapshot-store.test.ts` (new)
**Blocked by:** — . **Model:** opus. **Wave: A (keystone)**

The live baseline (`research/2026-07-31-prd2-live-baseline.md`) showed 896M
tokens minutes after boot, every ledger row "first seen 2m ago". Two root
causes live in this fence (audit: `research/2026-07-31-prd2-audit-findings.md` §A):

- `poll-loop.ts:51` — the `emit` closure stamps every event with `tickNow`,
  the poll wall-clock. A collector reading a week-old log line has no way to
  say when the fact actually happened, so history lands inside the 5-minute
  rate window and `$/hr` spikes on boot.
- `poll-loop.ts:35` — collector snapshots (which hold sessionlog's byte
  offsets) live in a process-local Map and die with the process. Every
  restart re-reads everything.

Build the two seams the rest of wave A stands on:

1. **Source timestamps.** `CollectorContext.emit` accepts an optional source
   time (e.g. `emit(type, payload, { ts })`). Default stays `tickNow` —
   existing collectors change zero lines. The poll loop honours the override.
   The event envelope already has `ts`; nothing new in the schema.
2. **A snapshot store.** New `snapshot-store.ts`: persist each collector's
   snapshot as JSON after a tick, rehydrate on demand. Atomic write (tmp +
   rename), keyed by collector name, storage dir injected by the caller. A
   missing or corrupt file yields "no snapshot" (fresh start) — never a
   crash. `createPollLoop` accepts an optional `snapshotStore`; when present
   it loads initial snapshots on start and saves after each tick. Do NOT wire
   it into the CLI — #58 owns `cli/index.ts` and does the wiring.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary); no NUL bytes. Tests must prove: an event
emitted with a source ts keeps it while default emits keep tick time; the
store round-trips a snapshot; a corrupt store file means fresh start, not a
crash. Never push, merge, or run git in a sibling worktree — committing on
YOUR branch is required. Finish with a short summary including any live
evidence the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
