You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened.

YOUR ISSUE — #148:

## Direction

prd12 keystone (rulings 1–2): the `fork.checkpoint` event and the
laboratory's first module. Read docs/prd12.md IN FULL — ruling 1's
two-hands amendment governs every line — then
docs/research/2026-08-04-fork-checkpoint-spike.md (its [Ran] recipes are
the implementation).

1. **Additive event** — `fork.checkpoint` in a NEW
   `packages/core/src/events/lab.ts` (source: a new `lab` source value —
   the second hand is a distinct actor and the envelope says so). Payload:
   `lane`, `checkpointId`, `eventIndex` (the log index at capture),
   `sessionFile` + `sessionCutByte` + `sessionDigest`, `snapshotRef`
   (`refs/rhizomorph/checkpoints/<id>`), `snapshotSha`, `headSha`,
   `capturedBy` (`dispatch | gate | operator`). Full census/fixture/reduce
   fan-out (the scar); old logs replay unchanged.
2. **The capture module** — new `packages/server/src/lab/checkpoint.ts`:
   the spike's proven temp-index recipe (`GIT_INDEX_FILE` add -A →
   write-tree → commit-tree -p HEAD → ref under
   `refs/rhizomorph/checkpoints/`), 0.037s-class, working tree untouched
   (assert before/after `git status` identical in the test). Session cut:
   record current byte offset + digest of the lane's session file. Emits
   the event through the existing recorder path.
3. **The explicit hand** — CLI: `rhizomorph lab checkpoint <lane>`
   (the `lab` subcommand namespace makes the second hand visible in every
   invocation). No observer code path may call the lab module — enforced
   by the NEW namespace law test (ruling 1): grep-style, observer sources
   contain no import from `server/src/lab/`, and every write in `lab/`
   targets only the amended namespaces.
4. Capture hooks at dispatch/gate come LATER (they live in conduct
   tooling, not the product) — this keystone ships the event, the module,
   the command, the law test.

## Fence (may touch ONLY)

- `packages/core/src/events/lab.ts` (new)
- `packages/core/src/events/lab.test.ts` (new)
- `packages/core/src/events/index.ts`
- `packages/core/src/events/events.test.ts`
- `packages/core/src/fixtures.ts`
- `packages/core/src/fixtures.test.ts`
- `packages/core/src/state.ts`
- `packages/core/src/reduce.ts`
- `packages/core/src/reduce.test.ts`
- `packages/server/src/lab/` (new)
- `packages/server/src/cli/args.ts`
- `packages/server/src/cli/args.test.ts`
- `packages/server/src/cli/index.ts`
- `packages/server/src/cli/index.test.ts`

## Blocked by

#145 and #146 (their fences overlap this one — both landed before
dispatch). **Model:** sonnet. **Wave:** prd12-keystone.

## Definition of done

- Capture proven non-mutating by test; event fan-out complete; namespace
  law test green and biting (a deliberate bad-import fixture proves it
  fails); `lab checkpoint` works end-to-end on a real worktree in the
  test.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
