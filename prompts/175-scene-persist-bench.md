You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

MEASUREMENT LANE — you change no production code. The audit report is docs/research/2026-08-05-adversarial-audit.md; read its scene finding first. perf.test.ts documents the interleaved method; extend it, do not fork it.

YOUR ISSUE — #175:

## Direction

From the 2026-08-05 adversarial audit. Since #161, finished strands persist
forever (prd10 rulings 13-16) — and `scene/marks/index.ts:54` walks ALL
threads per frame, routing retired ones through `persistentMarks`
(`thread.ts`), which builds ribbon geometry with no cache (only the heart
caches). Per-frame cost is therefore O(total strands ever dispatched), not
O(living lanes). The perf test pins 30 lanes + 2 cuts at ~6.4ms / 38% of
budget; a long-lived field of 100-200 landed strands is UNMEASURED.

**This lane MEASURES. It does not build the cache.**

1. Extend `scene/perf.test.ts` with retired-heavy specs (e.g. 30 living +
   100 retired, 30 + 200), using the interleaved before/after discipline the
   file already documents (#157). Report layout / marks / paint ms per spec.
2. **Verify the HIDE FINISHED path** (prd10 ruling 16): confirm whether
   hiding finished strands also skips their geometry build in `layoutScene`
   and their `persistentMarks` calls — or only their paint. Report which,
   with evidence.
3. If the budget is threatened at 200, STOP and say so — the cache design
   (finished strands never change shape; heart.ts models the caching style)
   is a separate groomed lane.

## Fence (may touch ONLY)

- `packages/web/src/scene/perf.test.ts`

## Blocked by

Nothing, but coordinate with the gate: this file is already in the gate's
timing exclusion list. **Model:** sonnet. **Wave:** audit-measure.

## Definition of done

- Frame numbers at 100/200 retired reported via the interleaved method; the
  HIDE FINISHED question answered with evidence; zero production-code changes.
- Root `npm test` + `npm run typecheck` green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
