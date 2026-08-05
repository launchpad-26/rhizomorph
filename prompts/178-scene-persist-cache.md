You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened. Tests HERMETIC under 4x concurrency.

The fix lane #175's measurements justified — its specs are LANDED in scene/perf.test.ts and are your measuring stick. Read them and docs/research/2026-08-05-adversarial-audit.md (scene finding) first. The operator is FEELING this bug: the field's regrowth must never again cost the framerate.

YOUR ISSUE — #178:

## Direction

Sequel to #175, whose measurements (landing with its gate, in
`scene/perf.test.ts`) turned the audit P2 scene finding from [Hypothesis] to
[Ran], worse than predicted:

- A 100-retired field costs 2.6–2.8x a living-only frame and **exceeds the
  16.67ms budget outright**; 200 retired is 4.2–4.7x.
- **HIDE FINISHED only skips paint.** `layoutScene` builds a retired lane's
  full spine (Catmull-Rom fit, release deformation, homeward-flow resample)
  BEFORE `persistence()` sets the hidden flag — proven by #175's
  deterministic byte-identity assertion. hidden-200 still sits at 80.6% of
  budget while showing 30 lanes' worth of visible result.

Two fixes, one lane, both inside the scene fence:

1. **Cache retired-strand geometry.** A finished strand is still, by law
   (prd10 rulings 13–16: thin, luminous, unmoving) — its spine never changes
   after retirement completes. Build once at retirement, reuse per frame.
   `heart.ts` models the caching style. State the cache key explicitly and
   what invalidates it (resize? camera?) — say which stages are world-space
   and prove the cache is safe there. If the dissolve transition still
   animates, cache only AFTER it completes.
2. **Hidden means skipped.** When HIDE FINISHED is on, retired lanes skip
   layout too, not just paint. #175's byte-identity assertion flips meaning:
   hidden retired lanes now produce NO geometry — restate it as the stronger
   law.

Laws that must survive, test-stated:

- Every prd10 persistence law (rulings 13–16) — no visual change whatsoever
  when visible: the cached field renders byte-identically to the uncached
  one (assert on marks/geometry output, the #175 method).
- The return beat (motes, ring) is unaffected — caching begins only once a
  strand is fully at rest.
- Perf: re-run #175's specs interleaved; the target is 200-retired WITHIN
  budget when visible, and near-living-only cost when hidden.

## Fence (may touch ONLY)

- `packages/web/src/scene/` (all files)

## Blocked by

#175 (its specs must be on main — they are this lane's measuring stick).
**Model:** sonnet. **Wave:** audit-fix.

## Definition of done

- 200-retired within budget visible; hidden ~= living-only; byte-identity
  law restated stronger; all scene laws green; interleaved before/after
  reported at 100 and 200.
- Root `npm test` + `npm run typecheck` green.


RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
