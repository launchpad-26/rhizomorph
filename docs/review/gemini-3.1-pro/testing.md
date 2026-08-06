# Testing strategy and quality review

* **Strategy is fixture-heavy but disconnected:** Fast, isolated unit tests parse captured text, but zero true end-to-end coverage exists to validate that real-world Git/Tmux edge cases match the fixtures.
* **Law tests are brittle theater:** Regex-grepping source files (`namespace-law.test.ts`) is easily evaded by dynamic imports. Standard AST-aware tooling (Biome) should enforce these boundaries.
* **Hidden OS couplings break tests:** The `namespace-law.test.ts` failure highlights a dev-vs-CI gap where tests rely on host `$TMPDIR` symlink behaviors that GitHub Actions silently masks.

### Top 10 findings

1. **Strategy: Missing end-to-end CLI validation**
   The testing philosophy is heavily integration-focused on mocked parsing. The `Exec` seam (`packages/server/src/server/exec.ts`) correctly isolates the collectors, but zero tests invoke `git` or `tmux` live against real repositories or sessions. Without real integration tests, the suite is blind to undocumented formatting behaviors of external binaries.

2. **Flaw: Zero coverage for C-quoted Git paths**
   Git explicitly wraps non-ASCII or whitespace-containing paths in C-style quotes by default (`core.quotePath`). Neither `parse-status.ts:24` nor `parse-worktrees.ts:34` unescape these quotes. They naively slice strings (e.g., `line.slice('worktree '.length)`). There are no fixtures in `packages/server/src/collectors/git/fixtures/` covering C-quoted output, meaning a space in a worktree path will silently corrupt internal state.

3. **Flaw: Tmux paths with tabs will crash the parser**
   `list-panes.ts:30` strictly splits on `\t` and throws if the field count isn't exactly 7. Unix directory paths can legally contain tabs. A user navigating to a directory named with a tab will crash the entire Tmux parser. No fixtures in `tmux/fixtures/` cover tabs or newlines in `pane_current_path`.

4. **Flaw: Missing detached main worktree fixture**
   `parse-worktrees.test.ts` drives coverage via `all.txt` and `single.txt`, but both strictly feature a main worktree on a named branch (`main`). There is zero fixture coverage for the primary worktree sitting in a detached HEAD state, leaving a critical Git collector code path untested.

5. **Law tests: Brittle grepping over AST analysis**
   `namespace-law.test.ts:153` and `readonly.test.ts:25` grep raw file contents via `readFileSync` and Regex (e.g., `/(^|\/)lab\/[^/]/.test(specifier)`). This is reinventing `noRestrictedImports` and `noRestrictedSyntax` poorly. As proven by `packages/server/src/api/lab.ts:361`, a dynamic `await import('../cli/index.js')` entirely evades the namespace restriction. Biome operates on the AST and correctly handles aliases, dynamic imports, and obfuscation.

6. **Suite Health: The macOS / CI environment gap**
   The `namespace-law.test.ts:655` `/var` vs `/private/var` failure occurs because dev macOS machines use `/var` for `$TMPDIR`, which is a symlink to `/private/var`. The test invokes `git worktree list`, which canonicalizes to `/private/var`, and compares it against Node's un-canonicalized `os.tmpdir()` (`labRoot(dataRoot)` at line 656). It falsely passes on CI (`.github/workflows/ci.yml:25`) because GitHub Actions `macos-latest` overrides `$TMPDIR` to `/Users/runner/work/_temp`, bypassing the symlink behavior entirely.

7. **Suite Health: Host-dependent test state**
   Law tests directly invoke host binaries (`git(['worktree', 'list'])` in `namespace-law.test.ts:645`) instead of mocking the CLI or operating on isolated dummy Git repositories. This binds test stability to the developer's global Git configuration (`core.quotePath`, global hooks) and the host machine's filesystem idiosyncrasies.

8. **Over-tested / Untested: Domain logic hidden in `marks.test.ts`**
   `web/src/scene/marks.test.ts` is grossly bloated at 3772 lines, acting as a dumping ground for unrelated domain tests. `salience.ts` contains the load-bearing, mathematically complex contrast budget algorithm but lacks its own unit test file—its coverage is incidentally buried inside the visual component tests in `marks.test.ts` instead of an isolated `salience.test.ts`.

9. **Untested (Positive): The `paint.ts` executor seam**
   `web/src/scene/paint.ts` correctly has no tests. The architecture effectively isolates all display logic into a testable array of marks (the display list), leaving `paint.ts` as a pure Canvas API side-effect. This is an excellent testing seam that keeps the heavy visual logic decoupled from flaky DOM/Canvas screenshot assertions.

10. **Mocking (Positive): `ExecResult` resilient fallbacks**
    The mock execution interface (`packages/server/src/server/exec.ts:24`) successfully catches missing binaries and process crashes, returning a robust `{ failed: true }` instead of throwing. `git-collector.test.ts` successfully leverages this seam to assert that a missing Git binary latches the collector into a `disabled` state, confirming the architecture won't infinite-loop on process crashes.
