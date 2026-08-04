You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests must be HERMETIC under 4x concurrency
(unique temp paths, no shared fixture state) — a recent lane was
held by exactly that.

YOUR ISSUE — #153:

## Direction

prd12's laboratory, phase 2: the FORK ENGINE prototype. Read
`docs/prd12.md` IN FULL (ruling 1's two-hands amendment governs every
line) and `docs/research/2026-08-04-fork-checkpoint-spike.md` (its [Ran]
recipes are the implementation — do not re-derive them). #148 landed the
checkpoint event, the capture module and the namespace law; you build
restore and dispatch on top.

1. **Restore** — `packages/server/src/lab/restore.ts`:
   - Workspace: `git worktree add --detach <lab-worktree> <snapshotSha>`
     under a lab-owned path (outside the watched repo's tree, alongside
     the data dir — ruling 1's namespaces), then `npm install` (the
     spike's ~6s; do it, don't skip it).
   - Session: copy the parent's session JSONL truncated at the
     checkpoint's `sessionCutByte` into the FORK worktree's project slug
     under a new uuid; **rewrite parent-worktree absolute paths to the
     fork worktree** (prd12 ruling 5 — this is the corruption-prevention
     clause, test it explicitly); the existing sessionlog collector then
     discovers it with zero new code.
   - Verify the digest before use; refuse loudly on mismatch.
2. **Dispatch** — `rhizomorph lab fork <lane> [--at <checkpointId>]
   [--model <m>] [--prompt-file <f>] [--arms <n>]`:
   - n arms (default 3 per prd12 ruling 4), each its own restored
     worktree + session, each launched through the EXISTING workmux
     machinery (shell out to `workmux add` exactly as dispatch.sh does —
     the lab does not reinvent lane launching).
   - Emits `fork.dispatched` (new additive event in `events/lab.ts`):
     `forkId`, `parentLane`, `checkpointId`, `arm`, `treatment`
     (model/prompt digest), `laneHandle`. Forks are MARKED SYNTHETIC by
     this event's existence — the reducer marks those lanes
     `synthetic: true` in state (additive field; existing lanes stay
     exactly as they are).
3. **Comparison** — `rhizomorph lab compare <forkId>`: a TABLE (prd12
   ruling 6 — no visualization): arm, treatment, verified outcome (did
   its gate command pass — accept a `--verify <cmd>` flag, default
   `npm test`), cost, duration, commits. Distributions, never a single
   "winner" line (ruling 4): with n<3 the table prints runs and refuses
   to rank.
4. **Laws**: the lab's namespace test (from #148) EXTENDS to cover the
   new writes — nothing outside `refs/rhizomorph/`, lab worktrees, and
   the lab data dir; the observer still imports nothing from `lab/`.
   `rhizomorph lab` remains the only entry point (no background caller).

## Fence (may touch ONLY)

- `packages/server/src/lab/` (all files)
- `packages/server/src/cli/args.ts`, `args.test.ts`
- `packages/server/src/cli/index.ts`, `index.test.ts`
- `packages/core/src/events/lab.ts`, `lab.test.ts`
- `packages/core/src/events/index.ts`, `events.test.ts`
- `packages/core/src/fixtures.ts`, `fixtures.test.ts`
- `packages/core/src/state.ts`
- `packages/core/src/reduce.ts`, `reduce.test.ts`

## Blocked by

#148 (landed). **Model:** opus (this one has judgement in it).
**Wave:** lab-phase-2.

## Definition of done

- Restore proven end-to-end in a test against a temp fixture repo
  (hermetic, 4x-concurrency safe — the #148 lesson); path-rewrite test is
  MANDATORY; digest-mismatch refusal tested.
- `lab fork` dispatches n arms; `lab compare` prints the table and
  refuses to rank below n=3.
- Namespace law extended and biting; observer untouched.
- Root `npm test` + `npm run typecheck` green.
- Interactive workmux resume of a synthesized session is the spike's one
  unprobed link: if it fails, say so plainly in your summary rather than
  papering over it — a documented limit beats a false claim.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
