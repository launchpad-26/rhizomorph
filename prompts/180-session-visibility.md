You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

Server half of the sessions pair (#181 web half is blocked on your /api/meta fields). Read session-log.ts's own RESUME_WINDOW_MS docstring first — your job is making that boundary self-explaining and controllable.

YOUR ISSUE — #180:

## Direction

Operator ruling 2026-08-05: session boundaries must be obvious and
controllable. Today the ENTIRE boundary is one boot-time check —
`findResumableSession` resumes the newest session when its newest event is
under `RESUME_WINDOW_MS` (4h, `session-log.ts:138`) — and the only control is
`--fresh`. The current live session is multi-day and 55k+ events because
every restart landed inside the window; nothing says so anywhere. The
docstring already concedes: "a conductor default, not a law — this one
constant is the whole boundary." The lab (prd12) is about to bind fork
checkpoints to session positions, so the boundary graduates from bookkeeping
to meaning.

Server half (the web half is #181, blocked on this):

1. **The boot line states the decision AND the reason**:
   `resuming session <id> (newest event 2h04m old < 4h window; resumed 7 times; 55,049 events)`
   or `starting session <id> (previous session 9h13m stale > 4h window)` —
   the heuristic becomes self-explaining at the moment it acts.
2. **`/api/meta` carries the facts**: `startedAt` (already there), plus
   `resumedCount`, `eventCount` at boot, `resumeWindowMs`, and
   `lastBootReason` (`fresh-flag | resumed | stale | first-run`). Additive.
3. **`--resume-window <duration>`** joins `--fresh` (reuse the existing
   duration parsing the CLI already has), documented in `--help` and the
   README's run section IF that file is in your fence (it is not — note it
   for the conductor instead).
4. **`rhizomorph doctor` gains a session line**: current session id, age,
   size, window, and the exact flag to force a boundary. Doctor's honesty
   style (#126) applies.
5. `resumedCount` derivation must be cheap: derive from `session.started`
   events already recorded in the file (one per boot), not a new sidecar.

Laws, test-stated: the resume decision function states its reason as data
(not just a log string); meta's new fields agree with the recorder's actual
state; `--resume-window 0` === `--fresh` in effect.

## Fence (may touch ONLY)

- `packages/server/src/log/session-log.ts`, `session-log.test.ts`
- `packages/server/src/cli/args.ts`, `args.test.ts`
- `packages/server/src/cli/index.ts` (boot line + wiring)
- `packages/server/src/cli/doctor.ts`, `doctor.test.ts`
- `packages/server/src/api/meta.ts`, `meta.test.ts`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** sessions.

## Definition of done

- Boot line self-explains both paths; meta additive fields live; the flag
  works and `0` forces fresh; doctor line present; laws test-stated.
- Root `npm test` + `npm run typecheck` green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
