You are a worker agent on The Rhizomorph (prd2: anyone, anywhere).
You own exactly one issue.

FIRST read docs/prd2.md — why this work exists — then
research/2026-07-31-prd2-audit-findings.md (file:line evidence) and
research/2026-07-31-prd2-live-baseline.md (what the dashboard showed
before your fix), then the files your issue names. Wave A goal: a
fresh boot starts at zero, timestamps are the source own, a restart
resumes instead of re-recording.

YOUR ISSUE — #58 (58. Resume the run: continue the recent session, persist offsets, --fresh/--backfill)

**Fence (may touch ONLY):** `packages/server/src/cli/index.ts`, `packages/server/src/cli/args.ts`, `packages/server/src/server/recorder.ts`, `packages/server/src/log/session-log.ts`, `packages/server/src/log/paths.ts`, plus the colocated `.test.ts` for each
**Blocked by:** #56, #57. **Model:** opus. **Wave: A**

The baseline's session dropdown lists 24 recorded sessions — one per past
boot, each holding its own copy of history, because `cli/index.ts:91-93`
mints a new session file every start and nothing survives the process. The
prd ruling: **resume the run** — persist offsets, continue the recent
session; no duplicates, no gap.

- **Resume by default.** On boot, find the latest session file for this repo.
  If its last event is younger than 4 hours, adopt it: same session id, the
  `SessionRecorder` rebuilds its in-memory buffer from the file and appends
  from there (no second `session.started`). Otherwise start a new session as
  today. The 4-hour boundary is a conductor default, not sacred — put it in
  one named constant with a comment.
- **Flags** (in `args.ts`): `--fresh` forces a new session; `--backfill`
  plumbs through to the sessionlog collector's `backfill` config (#57).
- **Offsets survive.** Wire #56's snapshot store into `createPollLoop`,
  storage under the session's data dir keyed by session id: resuming a
  session rehydrates its collector snapshots (sessionlog byte offsets
  included); a fresh session starts with none — #57's EOF-start makes that
  safe. Snapshots from an abandoned session are simply unused.
- The recorder's buffer rebuild must tolerate a trailing half-written line
  (crash mid-append): drop it, keep the rest.

**DoD:** root `npm test` + `npm run typecheck` green; deterministic tests (no
waitFor racing an async boundary — inject the clock); no NUL bytes. Tests
must prove: boot → record → stop → boot resumes the same file with no
duplicate events and continuing offsets; `--fresh` starts a new file; the 4h
boundary flips behaviour under an injected clock; a truncated final line is
survived. Never push, merge, or run git in a sibling worktree — committing on
YOUR branch is required. Finish with a short summary including any live
evidence the issue asks for.


RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits; committing on YOUR branch is REQUIRED; never push,
merge, or run git in a sibling worktree; no NUL bytes; STOP when done.
