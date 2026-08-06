# Code quality review

**Reviewer:** Fable seat 4 of 5 — code quality
**Date:** 2026-08-06
**Scope:** lint/typecheck/test runs, file and function sizing, over-engineering hunt, duplication, TypeScript rigor, naming, test suite shape

> **Correction applied after this report was filed:** this seat's diagnosis of the
> `namespace-law.test.ts` failure (below, "environment-dependent / git version") is
> wrong. See [README.md](./README.md) for the verified cause — a raw vs canonical
> path comparison at line 655. Do **not** apply the suggested version guard.

---

## Verdict
- Lint and typecheck are clean; strict mode is on. Test suite has **1 genuine failure** (investigated, not dismissed as flake).
- The 112k lines are mostly load-bearing: reducer/selector files are broken into many small (~30-line) single-purpose functions, not god-functions. Real bloat is concentrated in a handful of near-duplicate selectors and an oversized test file, not systemic over-engineering.
- No factories-for-one-product, no dead config layer, no `any` abuse (only 8 hits, all narrow). The `as` cast count (898) sounds alarming but sampled casts are legitimate boundary narrowing (JSON parsing, `NodeJS.ErrnoException`, DOM). Domain vocabulary (lane/thread/mark/tide/lab) is used consistently and mostly self-documenting from context, though a newcomer glossary doesn't exist.

## Actual results

- `npm run lint` — **pass**, 547 files, no issues.
- `npm run typecheck` — **pass** across core/server/web.
- `npm test` — **1 failed / 3411 passed** (227 files, 1 failed).
  - `packages/server/src/lab/namespace-law.test.ts:657` — "creates worktrees ONLY under the lab data dir, even though dataRoot is reached through a symlink" fails: `expected false to be true`.
  - *(This seat's original diagnosis — that the test checks an environment-dependent precondition about whether `git worktree add` canonicalizes, and that it should be made robust or version-guarded — was subsequently shown to be incorrect. See the correction note at the top of this file.)*

## Findings

1. **`packages/core/src/selectors/spend.ts:178-462`** — `selectLaneSpend`, `selectSpendByWorktree`, `selectSpendByBranch`, `selectModelSpend` each hand-roll the same create-Acc-map / loop-usage-costs-tools / finalise-and-sort pattern. A shared `groupSpendBy(state, filter, keyOf)` helper could collapse four of these into one generic plus thin wrappers. **Est. 150-200 lines saved**; the file is 956 lines. This is the most defensible cut in the repo.

2. **`packages/web/src/scene/marks.test.ts`** — 3,772 lines, 191 test cases, the single largest file in the repo, larger than the module it tests (`marks/node.ts` 1050 + `marks/thread.ts` 822 + `marks/root.ts` 788 ≈ 2,660 combined). Worth a pass to see whether visual-state combinations are being enumerated rather than parameterized — a likely candidate for `it.each` table consolidation.

3. **Test-to-source ratio ~1.16:1** (60,275 test lines vs 51,980 source lines) — higher than typical for this size of app. Some of this is deliberate and legitimate (4 separate `.bench.test.ts`/`perf.test.ts` files are genuine perf regression guards), but the panel/drawer `.test.tsx` files at 500-1400 lines each are worth confirming aren't testing implementation details rather than behavior. Not read line-by-line — flagged, not concluded.

4. **No interface/factory/provider over-abstraction found.** Checked explicitly for single-implementation interfaces and `*Factory` / `class *Provider` patterns; none stood out as speculative. No `config/` directory of never-changing values either. This part of the over-engineering hunt came up empty — genuinely not where the size went.

5. **`as` casts (898) and non-null assertions (34)** are low-risk on inspection — dominated by `err as NodeJS.ErrnoException`, `JSON.parse(...) as X`, and DOM-type narrowing. Not a rigor problem worth chasing.

6. **11 `@ts-ignore` / `@ts-expect-error`** — small enough to leave alone, but worth a sweep to confirm each still has a live reason:
   ```
   grep -rn "@ts-ignore\|@ts-expect-error" packages/*/src
   ```

## Net

This isn't a codebase that grew fat from speculative architecture — it grew from breadth (many selectors, many panel components, many pathology/mark states, each thoroughly tested). The most defensible cut is finding 1 (selector duplication). The most urgent action is the failing test, which is a bug to triage rather than a code-quality finding.
