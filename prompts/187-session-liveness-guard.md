You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

The finding is docs/research/2026-08-05-agnosticism-spike.md headline verdict 4 + section 3 adjacent-case — read both. The 2026-08-04 crash is your stale-lock regression case: a crashed writer must never strand its session.

YOUR ISSUE — #187:

## Direction

BUG, found by the 2026-08-05 agnosticism research spike
(`docs/research/2026-08-05-agnosticism-spike.md`, headline verdict 4 and §3
"adjacent case" — read both): **two rhizomorph instances started on the same
repo silently share one session file and one instance id.**

Mechanism: the OTLP receiver correctly refuses foreign instance ids
(`api/otel.ts`), but `decideSessionBoot`/`findResumableSession` has NO
liveness check — a second `rhizomorph` booted within the resume window
resumes the FIRST instance's live session file, and both processes append
to the same JSONL under the same id. Interleaved writes, double collectors,
one identity: the record's integrity story and everything federated (prd11,
the coming multi-orchestrator work) sit on top of this hole.

Fix direction:

1. **A boot-time liveness guard on resume.** Before resuming, probe whether
   the candidate session's writer is alive: a lockfile with PID + heartbeat
   mtime beside the session file (stale-lock tolerance for crashed writers —
   a crash must NOT strand the session unresumable; the 2026-08-04 crash is
   the regression case), or refusal to resume a file whose newest event is
   seconds old with a live lock.
2. **Refusal is loud and helpful**, boot-line + doctor voice: "session
   <id> is being written by a live instance (pid N) — starting a fresh
   session; use --fresh to silence, or stop the other instance." The #180
   `lastBootReason` vocabulary gains `writer-alive`.
3. **The crashed-writer path stays a resume** — a stale lock (dead pid /
   old heartbeat) resumes exactly as today. Test both directions: live
   writer → fresh session + voice; dead writer → resume, lock replaced.
4. Windows/WSL reality: pid probing must work where the instrument runs
   (WSL, macOS, Linux); state what you chose and its portability.

Laws, test-stated: two boots racing the same repo never share a session id;
a crash never strands a session; the guard writes ONLY beside the session
file (the observer's own data dir — constitution intact).

## Fence (may touch ONLY)

- `packages/server/src/log/` (all files)
- `packages/server/src/cli/index.ts`
- `packages/server/src/cli/doctor.ts`, `packages/server/src/cli/doctor.test.ts`
- `packages/server/src/api/meta.ts`, `packages/server/src/api/meta.test.ts`
  (the `lastBootReason` addition — additive only)

## Blocked by

Nothing. **Model:** sonnet. **Wave:** agnosticism-prereq.

## Definition of done

- Both directions test-stated (live→fresh+voice, stale→resume); boot line
  and doctor speak the new reason; root `npm test` + `npm run typecheck`
  green.
- Say what you would show the operator first.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
