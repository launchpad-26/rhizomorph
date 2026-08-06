# Code quality review

- **Verdict 1:** A 23.5k-line visual flourish (`scene` dir) for a localhost dev tool is massive over-engineering. The app is bloated by bespoke WebGL/Canvas rendering when simple DOM would suffice.
- **Verdict 2:** TypeScript rigor is defeated by pervasive `as` casting (2,298 instances), `any` (648), and `!` assertions (627). Strict mode is a mirage.
- **Verdict 3:** Rampant use of whimsical domain language ("balcony", "tide", "mark") and archaeological PRD citations ("prd10 ruling 13-15") creates an impenetrable lexicon for new readers.

## Actual CI results

- **Lint (`npm run lint`)**: Passed in 142ms (547 files, 0 fixes).
- **Typecheck (`npm run typecheck`)**: Passed (no emit).
- **Test (`npm run test`)**: 1 Failed, 3411 Passed.
  - Failure: `packages/server/src/lab/namespace-law.test.ts:657` (`creates worktrees ONLY under the lab data dir...`).
  - **Investigation:** Fails on macOS because `os.tmpdir()` yields `/var/...` but `git worktree list` returns the fully canonicalized `/private/var/...`. The test does not apply `fs.realpathSync.native()` to `realDataRoot` before comparing `worktree.startsWith(realDataRoot)`, making the symlink mapping diverge.

## Findings

- `packages/web/src/scene/`:1 — Over-engineering — A local dashboard spends 23,513 lines drawing a 3D visualization canvas (`geometry.ts`, `marks.test.ts`, `motion.ts`) rather than using standard DOM trees. — Action: Delete the custom scene layer and replace with basic HTML/CSS. (Est. lines saved: ~23,000)
- `packages/web/src/scene/marks.test.ts`:1 — Over-engineering — A massive 3,772-line test suite purely asserting visual rendering edge cases ("apical tufts", "pathology-free lanes"). — Action: Delete alongside the scene rewrite. (Est. lines saved: 3,772)
- `packages/server/src/cli/sessions.ts`:25 — Duplication — Hand-duplicates `formatTokens` and `formatCost` from `web/src/lib/format.ts`, explicitly noting it's to "avoid importing from web". — Action: Extract shared formatters to `@rhizomorph/core/src/format.ts` and import in both. (Est. lines saved: 30)
- `packages/server/src/lab/namespace-law.test.ts`:657 — Sloppiness — String-prefix comparison fails on symlinked temp dirs without resolving native paths first. — Action: Wrap the `os.tmpdir()` output for `realDataRoot` in `fs.realpathSync.native()`. (Est. lines saved: 0)
- `packages/web/src/app/router.ts`:10 — Whimsical naming — The main dashboard view is pervasively called the `balcony`, forcing readers to learn bespoke poetry for standard patterns ("Esc returns to the balcony"). — Action: Rename `balcony` routing and components to `dashboard` or `home`. (Est. lines saved: 0)
- `packages/web/src/tide/index.ts`:1 — Whimsical naming — Timeline event rendering is abstracted into a domain concept called `tide`, obfuscating a simple activity feed. — Action: Rename `tide` to `timeline` or `feed`. (Est. lines saved: 0)
- `packages/web/src/scene/marks/node.ts`:44 — Archaeological comments — Code is littered with external citations like `(prd10 ruling 4)` and `(prd7 ruling 3)` instead of explaining the rationale in-place. — Action: Replace opaque PRD rulings with inline domain logic explanations. (Est. lines saved: 0)
- `packages/core/src/state.ts`:667 — Hand-rolled stdlib — Re-implements `basename` with a custom regex to avoid depending on Node's `path` module. — Action: Consolidate string/path utils properly or use standard platform packages. (Est. lines saved: 15)
- `packages/*/src/**/*.ts`:1 — TypeScript sloppiness — 2,298 uses of `as` casts and 627 uses of `!` non-null assertions blindly override `tsconfig` strictness across the monorepo. — Action: Audit top offenders and enforce correct discriminated unions or runtime assertions. (Est. lines saved: 0)
- `packages/server/src/collectors/sessionlog/collector.ts`:1 — Over-engineering — At ~24KB, local log-tailing is heavily stateful and complex, vastly over-designed for a dev harness log stream. — Action: Simplify log collection to standard `fs.watch` and line-buffering. (Est. lines saved: ~400)
