You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests must be HERMETIC under 4x concurrency
(unique temp paths, no shared fixture state) — a recent lane was
held by exactly that.

YOUR ISSUE — #152:

## Direction

prd11 ruling 6b, phase 1: the SEMANTIC JUDGE's structural organ — the free
half, which needs no model calls and no operator ruling. Read
`docs/research/2026-08-04-semantic-judge-spike.md` IN FULL first; its
verdicts bind. Build ONLY what the spike graded as the cheap, high-signal
foundation:

1. **Symbol extraction** — new `packages/server/src/judge/symbols.ts`:
   from each lane's diff against main (read-only git plumbing —
   `git diff --unified=0 main...<branch>` style), extract the exported/
   declared symbol names each lane is touching (functions, consts, types,
   components — a pragmatic regex-per-language pass over TS/TSX is
   sufficient and must SAY it is heuristic in its doc comment). Facts
   only, no judgement.
2. **Speculative merge** — new `packages/server/src/judge/mergetree.ts`:
   pairwise `git merge-tree` between lane branches, IN MEMORY (the spike's
   one salvageable industry technique; `git merge-tree` writes nothing —
   assert that in the doc comment and keep it inside the OBSERVER's
   read-only law; no refs, no worktrees, no index writes).
3. **Additive event** — `judge.finding` in
   `packages/core/src/events/judge.ts` (source `judge` — a new source
   value; the organ is its own witness). Payload: `kind`
   (`symbol-overlap | speculative-conflict`), `lanes` (exactly two,
   ordered), `evidence` (the overlapping symbol names and/or the
   conflicting files — NEVER a bare claim), `severity` at the SILENT
   level only for now (`level: 'log'`), `detectedAt`. Full census/fixture/
   reduce fan-out.
4. **The ladder's first rung ONLY** (spike verdict + the Mission 04
   evidence): findings are LOGGED, never surfaced as a summons. No UI in
   this issue. No NOTICE, no needs-you. The surfacing rungs come after the
   validating replay experiment.
5. **The collector** — wire it as a polled collector
   (`packages/server/src/collectors/judge/`) at a LOW cadence (default
   every 60s, flag-adjustable), skipping when fewer than two lanes have
   branches. Graceful degradation like every other collector
   (`collector.disabled` on repeated failure).

## Fence (may touch ONLY)

- `packages/core/src/events/judge.ts` (new)
- `packages/core/src/events/judge.test.ts` (new)
- `packages/core/src/events/index.ts`
- `packages/core/src/events/events.test.ts`
- `packages/core/src/fixtures.ts`
- `packages/core/src/fixtures.test.ts`
- `packages/core/src/state.ts`
- `packages/core/src/reduce.ts`
- `packages/core/src/reduce.test.ts`
- `packages/server/src/judge/` (new)
- `packages/server/src/collectors/judge/` (new)
- `packages/server/src/server/collector-loader.ts`

## Blocked by

Nothing. **Model:** sonnet. **Wave:** judge-phase-1.

## Definition of done

- Symbol extraction and merge-tree proven against fixture repos (create
  them in a temp dir per test — HERMETIC, the #148 lesson: unique paths,
  no shared fixture state, must survive 4x concurrency).
- `judge.finding` events emitted at log level only; nothing surfaces.
- Read-only law untouched (merge-tree writes nothing; assert in a test).
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
