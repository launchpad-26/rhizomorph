# Testing strategy and quality review

**Verdict**
- The suite is genuinely well-structured at the seams that matter: pure parsers are fixture-driven, the `Exec` injection seam lets collectors be tested without real tmux/git, and the lab module is exercised against **real git** (`fork.test.ts:25 execFileSync('git',…)`, `checkpoint.test.ts`, `restore.test.ts`, `namespace-law.test.ts:397 mkdtemp+realGit`). That split is the right answer to "core risk is parsing real-world output."
- But **main has been red on macOS CI for 20+ consecutive pushes** — every recent run fails only on `macos-latest, current` at `namespace-law.test.ts:657`, the exact `/var` vs `/private/var` defect already diagnosed. A chronically broken main on the project's primary dev platform quietly voids the green bar's meaning.
- The fixtures are **curated happy paths, not adversarial**: the single highest-risk surface — git's `core.quotePath` C-quoting of non-ASCII paths — has **zero coverage and a latent bug** (`parse-status.ts:23` does `line.slice(3)` with no unescape, so `ä.txt` lands in state as the literal `"\303\244.txt"`).

## 1. Real testing philosophy (read from the tests)
Three concentric layers, in rough line-volume order: (a) **pure parser unit tests** fed by captured fixtures (`collectors/*/fixtures/`, e.g. `list-panes.test.ts` reads `list-panes.real.txt`); (b) **real-git integration tests** in `packages/server/src/lab/*` that `execFileSync('git', …)` against `mkdtemp` roots — this is the only true end-to-end surface and it's where the macOS failure lives; (c) **web scene "property" tests** (`marks.test.ts`, 169 tests) asserting relational invariants ("frozen is dimmer than waiting") rather than pixel snapshots. There is **no end-to-end test of collector→reduce→SSE→web**; the CI boot-smoke (`ci.yml`) only hits `/api/meta` and `/`. For a tool whose failure mode is mis-parsing real `git`/`tmux` output, layer (a) is the load-bearing layer and it is the weakest.

## 2. The law-test pattern
The grep regex at `namespace-law.test.ts:78` *does* match `import('…')` and `require('…')` literal specifiers, so the "no observer reaches the lab" walk (`:152`) is not blind to plain dynamic imports. Two real holes remain:
- **Templated specifiers** (`import(\`../${x}.js\`)`) and re-export barrels evade the regex; renames of the lab directory evade `targetsLab`'s path-text heuristic.
- **The "sole importer" narrative is falsified in the repo right now.** `api/lab.ts:361` does `const { runCli } = await import('../cli/index.js')`, and `cli/index.ts` statically imports `lab`. Because `walkSourceFiles(SERVER_SRC, [LAB_DIR])` (`:152`) **excludes `LAB_DIR`**, this dynamic import is invisible to the law — yet it closes a real runtime cycle lab→cli→lab that the law's "cli is the one declared wiring point" story denies. The law asserts a static-graph topology as a runtime invariant.

Biome `noRestrictedImports` would handle the static-forbidden-specifier case deterministically and is already enforced in CI (`ci.yml` lint step), but it **cannot** express "only this one file may import X" nor detect cycles — so the law tests buy something Biome doesn't (the sole-importer topology + the "detector bites" self-tests at `:177` and `no-live-fleet-law.test.ts:55`). Verdict: keep the law tests, stop describing them as airtight, and add a comment acknowledging the `api/lab.ts:361` exclusion.

## 3. Fixture quality
Representative, not adversarial. `worktree-list/all.txt` decently covers detached/locked. **Real failure modes with zero fixture coverage:**
- **git porcelain v1 C-quoted/unicode paths** — `parse-status.ts:23` never unescapes `"\303\244"`. No fixture, no test. This is the bug.
- **paths containing a literal ` -> `** — `parse-status.ts:21` splits on the first ` -> `, mis-parsing a filename that contains it.
- **git binary ENOENT** — `tmux/collector.test.ts:84-107` tests the disabled-latch via injected `missingBinary()`; **`git-collector.test.ts` has no equivalent**. Asymmetry gap on the more dangerous collector.
- **malformed git raw diff lines** — `parse-log.ts:73 parseFile` throws, but no test feeds a bad `:…` line.
- **workmux multi-space titles/handles** — `parse.ts` comment claims column-slice robustness; only one `status-mixed.txt` fixture, no embedded-multi-space case.
- **git log `{a => b}` numstat shorthand** — `parseFile` zips raw/numstat by index, never parsing the shorthand; no fixture exercises it.

## 4. Over-tested vs untested
`marks.test.ts` (3772 lines, 169 tests) is over-invested for pure deterministic geometry with low blast radius, and contains tautologies: `expect(vibrancyOf(true)).toBe(REPLAY_VIBRANCY)` (`:3624`) asserts a constant accessor returns its constant; `expect(buds[0]?.laneId).toBe(LIVE)` (`:3376`) asserts a fixture's own input. Meanwhile `parse-status.ts`'s C-quoting — a user-facing data-corruption bug — is **untested**. Rebalance.

## 5. Suite health
Runtime ~3 min (CI). Flakiness is structural: lab tests resolve `os.tmpdir()` and `realpathSync.native` (`namespace-law.test.ts:308`, `paths.test.ts`), so they are path-spelling-sensitive — exactly the macOS failure. `gh run list --branch main -L 20`: every run is **failure**, all red on `build-test-boot (macos-latest, current)` at line 657; Linux legs (min + current) and all `pack-smoke` legs pass. The dev's local "1 failed" is the same defect. Matrix is good (ubuntu+macos × {current, 22.22.2}, macos×min excluded), but main is broken on macOS.

## 6. Mocking and seams
The `Exec` seam (`CollectorContext.exec`) is used well — tmux's disabled-latch is tested without tmux, `doctor.test.ts` stubs by command string, `fork.test.ts:74` uses "real git, stubbed everything else" — the right line. Nothing is over-mocked to the point of testing the mock. The gap is the *other* direction: parsers are tested only against hand-captured fixtures, never property/fuzzed against actual git/tmux versions, so "real-world output" coverage rests on whatever the author happened to capture.

## Top 10, prioritized
1. **Fix or skip the macOS CI leg** — 20+ red runs on main is the single biggest credibility problem.
2. **Add a C-quoted/unicode `git status` fixture** and unescape in `parse-status.ts:23` — latent data bug, zero coverage.
3. **Add a git-binary-ENOENT test** to `git-collector.test.ts` mirroring `tmux/collector.test.ts:84`.
4. **Document or fix** the `api/lab.ts:361` dynamic-import cycle that falsifies the namespace-law "sole importer" claim.
5. **Gate `reduce.bench.test.ts`** out of the pass/fail path (no `skip`/env guard) — measurement ≠ assertion.
6. **Add a literal-` -> `-in-path fixture** to `parse-status`.
7. **Add a malformed-raw-line test** for `parse-log.ts:73`'s throw.
8. **Right-size `marks.test.ts`**; drop tautologies at `:3624`/`:3376`.
9. **Property/fuzz the git/tmux parsers** against real binaries — the core risk is parser drift, not geometry.
10. **Add one collector→reduce→SSE integration test**; boot-smoke is too shallow.

**Genuinely good, keep:** the `Exec` injection seam and the real-git lab tests are the right architecture; the law tests' "detector bites" self-tests (`namespace-law.test.ts:177`, `no-live-fleet-law.test.ts:55`) guard against vacuous checks — retain even if Biome `noRestrictedImports` is adopted for the static case.
