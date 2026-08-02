You are a worker agent on The Observatory (prd2 follow-up, operator-approved).
You own exactly one issue.

Context: the #72 stranger audit found doctor reports tools as ok/absent
only; a tool that exists but errors needs a truthful third state. Read
the DoctorCheck contract in doctor.ts before changing it; the fix in
exec.ts from #72 (errorMessage = missing-binary only) is your upstream.

YOUR ISSUE — #73 (73. Doctor: a third state for present-but-erroring tools)

Filed by the #72 stranger audit. `observatory doctor` reports tools as ok/absent; a tool that exists but errors (broken tmux on PATH) needs a truthful third state ("found but erroring: <reason>"). That is a DoctorCheck contract change, not a minimal fix — needs grooming. **Fence (may touch ONLY):** `packages/server/src/cli/doctor.ts`, `packages/server/src/cli/doctor.test.ts`. **Model:** sonnet. Unscheduled backlog — operator prioritizes.

DoD: root npm test + npm run typecheck green; deterministic tests; a
test proving a present-but-erroring tool reports "found but erroring:
<reason>" while absent stays absent and healthy stays ok.

RULES: stay strictly inside the FENCE; build for a stranger machine —
no personal paths, machine-specific behavior degrades loudly; small
conventional commits; committing on YOUR branch is REQUIRED; never
push, merge, or run git in a sibling worktree; no NUL bytes; STOP when
done.
