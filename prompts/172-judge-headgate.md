You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

The audit report is docs/research/2026-08-05-adversarial-audit.md — read its judge finding first.

YOUR ISSUE — #172:

## Direction

From the 2026-08-05 adversarial audit; **conductor-verified at code level**.

`packages/server/src/collectors/judge/collector.ts:105-134`: a nested loop
over all lane pairs runs `speculativeMergeTree` per pair, plus
`extractLaneSymbols` (a `git diff`) per lane, every 60s cadence tick
(`:18`). The `reported` snapshot dedups *emitting a finding* but is checked
AFTER the subprocess runs — so an idle 30-lane fleet costs ~435 merge-tree +
30 diff spawns per minute, on the same box the watched agents run on. The
docstring's promise ("a LOW-cost organ stays low-cost") is not kept.

Fix:

1. **Gate the sweep on head movement.** The `reported` map already keys on
   `@<head>` — the heads are in hand. Skip `extractLaneSymbols` for a lane
   whose head is unchanged since the last run; skip a pair when NEITHER head
   moved. First run after boot still sweeps everything.
2. **Law, test-stated with an injected exec recorder**: a cadence tick over an
   unchanged fleet spawns ZERO subprocesses; a single moved head re-checks
   exactly that lane's pairs; finding semantics are unchanged (same findings
   emitted for the same head states, proven on the existing fixtures).
3. Do not change mergetree.ts or the finding schema. If the gate needs a
   change there, `BLOCKED: <need>`.

## Fence (may touch ONLY)

- `packages/server/src/collectors/judge/` (all files)

## Blocked by

Nothing. **Model:** sonnet. **Wave:** audit-surgical.

## Definition of done

- Idle-fleet cadence spawns zero subprocesses, test-stated; moved-head
  behaviour proven unchanged; root `npm test` + `npm run typecheck` green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
