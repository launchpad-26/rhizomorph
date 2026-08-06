# Testing strategy and quality review

**Verdict:** The suite is thorough, architecturally self-aware, and unusually literate — the law-test pattern is a genuine innovation. But it over-relies on curated fixtures to the exclusion of real-world garbage input, has a structural blind spot in its import guard, and lacks any end-to-end parse of actual tool output.

---

## 1. Strategy: heavy unit, zero e2e

The real philosophy is **fixture-driven pure-function testing with a single injectable seam** (`Exec`). Every collector parser is tested against text files in `fixtures/`; the server's poll loop uses a fake collector (`cli/index.test.ts:64`); the lab tests create real git repos in `mkdtemp`. The boot-smoke in CI (`ci.yml:115`) curls `/api/meta` — that is the **only** end-to-end test, and it doesn't exercise any collector. For a tool whose core risk is parsing output of `git`, `tmux`, `workmux`, and OTLP exporters, the absence of a single test that runs the real pipeline against real binaries is the #1 gap. The 1.16:1 test ratio is high but mostly unit.

## 2. The 'law test' pattern

Seven files (`namespace-law.test.ts`, `no-live-fleet-law.test.ts`, `readonly.test.ts`, `fixture-hygiene-law.test.ts`, etc.) grep the project's own source text with regexes to enforce architectural invariants. **What it buys:** invariants no linter can express — "no refs/ literal outside refs/rhizomorph/" (`namespace-law.test.ts:156`), "no setInterval in lab/" (`namespace-law.test.ts:285`), "no POST/PUT/DELETE in drawer/" (`readonly.test.ts:54`), "identity-field values in fixtures are placeholder-shaped" (`fixture-hygiene-law.test.ts:70`).

**How it fails:**
- **Indirect reachability:** `api/lab.ts:361` calls `await import('../cli/index.js')`, which in turn imports from `../lab/checkpoint.js` et al. The regex at `namespace-law.test.ts:84` catches `import(...)` syntax but checks only the *specifier string* against `targetsLab()`, and `'../cli/index.js'` doesn't match `/lab\//`. The `ALLOWED_IMPORTERS` set (`namespace-law.test.ts:53`) contains `cli/index.ts`, not `api/lab.ts`. The spirit is violated — a server route reaches the lab through the CLI — but the letter passes.
- **Renames:** `targetsLab` is a regex over path strings; renaming `server/src/lab/` to `server/src/workshop/` silently defeats it.
- **Obfuscation:** `eval('import("../la' + 'b/checkpoint.js")')` evades the regex entirely, though this is unlikely in a codebase that already has the law tests.

**Biome `noRestrictedImports`** would catch static imports from lab/* more robustly (AST-level, survives renames) but wouldn't catch dynamic `import()` either, and couldn't express the refs, scheduling, or identity-field checks. The correct hybrid: Biome for import restrictions, law tests for the bespoke invariants.

## 3. Fixture quality

**Good:** Git fixtures cover branches, detached HEAD (secondary worktree), locked worktrees, clean/mixed/renamed/unmerged status, empty logs. OTel fixtures cover real Claude Code traces, malformed payloads, bad datapoints. Sessionlog fixtures cover multi-turn sessions, tail states from metadata-only through turn-complete. Tmux fixtures are real captured output.

**Missing (real failure modes with zero coverage):**
- **C-quoted git paths** (core.quotePath=true): `"path/with spaces"` renders as octal escapes in `git status --porcelain` — no fixture tests this. The parser at `parse-status.ts` would silently mangle such paths.
- **Unicode in tmux `pane_current_path`**: `list-panes.real.txt` uses only ASCII `/home/operator/...` paths. Tmux tab-delimited output with emoji or CJK in the path or title has no test.
- **Tabs/newlines in pane paths**: Tab is the `list-panes` delimiter — a tab in a path or title corrupts column alignment. No fixture exercises this.
- **Detached HEAD on the main worktree**: `worktree-list/all.txt` has detached HEAD only on a secondary worktree. The main worktree's branch is always `refs/heads/main` in fixtures.
- **Empty output for `git worktree list` vs `git for-each-ref`**: only `git log` has an empty fixture. The others get empty-string tests in code but no fixture file.
- **Malformed `worktree list --porcelain` output**: the parser trusts the format unconditionally — a missing `worktree ` line or garbled HEAD would produce junk entries with no test.

## 4. Over-tested vs untested

**Over-tested:** `marks.test.ts` (3772 lines, 193 `describe`/`it` blocks) is the largest single file. ~15–20% of assertions restate constants: `expect(inkOf(RETURN.totalMs)).toEqual([...PERSIST.strand.rgb])` (line 2340) simply confirms `returnAt()` is wired to the right palette constant. The `renderEverything` and `frameBudget` suites are performance probes, not correctness tests. These aren't worthless — they guard the visual encoding contract — but their volume is disproportionate.

**Under-tested:**
- **`server/src/server/exec.ts`** has **zero direct tests**. The `ExecResult` contract — `errorMessage` only set for ENOENT vs. non-zero exit, `code: null` vs `code: 128` — is tested only implicitly through collector mocks that never exercise the real `execFile` wrapper. The `maxBuffer: 16MB` and `input` streaming path are untested.
- **`sessionlog/collector.ts`** at 783 test lines still has no test for a session log that is actively being written (the tail reader racing the writer).
- **`workmux` status parsing** has fixtures but no test for a status line with a malformed PID or unexpected field count.

## 5. Suite health

**Runtime:** `marks.test.ts` uses `HEAVY_CASE_TIMEOUT_MS = 20_000` (`marks.test.ts:133`); the full suite is gated by `scripts/gate.sh` which splits serial/parallel passes for the timing-sensitive cases.

**Host coupling:** 17 test files call `execFileSync('git', ...)`; 5 create real repos in `os.tmpdir()`. These are hermetically `mkdtemp`-isolated but require `git` on `$PATH`. The `namespace-law.test.ts` symlink test (`namespace-law.test.ts:584`) explicitly depends on macOS's `/private/var` → `/var` symlink behavior. The known failure at line 655 is exactly this host coupling biting.

**CI:** `.github/workflows/ci.yml` runs `npm test` (vitest run) on `ubuntu-latest` (node current + min) and `macos-latest` (node current only, costs 10x). Plus a `pack-smoke` job that installs the tarball into a clean project and runs the CLI. CI runs exactly what a developer runs, plus the boot-smoke. The macOS leg excludes min-node for cost reasons.

**Flakiness:** The single known failure (namespace-law.test.ts:655, canonical vs raw path) and the `HEAVY_CASE_TIMEOUT_MS` history (`#172, #189` — sibling lane contention causing timeouts) suggest the suite occasionally fails under concurrency.

## 6. Mocking and seams

The `Exec` injection seam is well-designed and well-used. `FakeShell` (`tmux/collector.test.ts:46`) records calls for assertions; `fakeExec` in worktree tests returns canned responses. The `cli/index.test.ts` uses a `fakeCollector` to test the poll loop without real git/tmux. This is correct — collectors are tested separately with fixtures.

**Over-mocking:** The `cli/index.test.ts` boot tests use a fake collector that emits a single event — the `snapshot` persistence path and the `resume` window logic are tested only through this narrow aperture. The real session-log writer (`log/session-log.ts`) is exercised only in its own tests, never integrated with the poll loop.

---

## Top 10 actions, prioritized

1. **Add an e2e test** that runs the real server with real `git` and `tmux` (even just one pane), polls once, and asserts shape of output. The CI boot-smoke proves the server starts; add one collector tick.
2. **Fix the namespace-law import guard** — either add `api/lab.ts` to an explicit allowlist with a comment explaining the indirection, or add a transitive check that walks `cli/index.ts`'s own imports.
3. **Add C-quoted git path fixtures** to `git/fixtures/status/` and `git/fixtures/for-each-ref/` — this is the most likely real-world parsing failure.
4. **Add a detached-HEAD-on-main-worktree fixture** to `worktree-list/`.
5. **Add tmux fixtures with unicode and tabs** in `pane_current_path` and `pane_title`.
6. **Write direct tests for `server/exec.ts`** — especially the `errorMessage`-vs-`code` contract and the `input` streaming path.
7. **Split `marks.test.ts`** into semantic-role tests (keep) and rendering-constant tests (could be inline snapshots or removed if the constants are the source of truth).
8. **Add a `workmux` status fixture** with a garbled line (wrong field count, non-numeric PID).
9. **Use Biome `noRestrictedImports`** for the lab import restriction (static imports only) as a belt-and-suspenders complement to the regex law test.
10. **Fix the namespace-law.test.ts:655 failure** by canonicalizing before comparison (already diagnosed) — this eliminates the sole suite failure and the runtime-evidence scaffolding it required.

**Genuinely good:** The law-test pattern is brilliant — it forces architectural decisions into diffs a reviewer reads. The `isAllowedWrite` live containment check (`namespace-law.test.ts:452`) actually runs `fork` and walks the filesystem before/after, which catches things no regex can. The OTel identity-field walk (`fixture-hygiene-law.test.ts:56`) recursively finds `KeyValue` shapes anywhere in arbitrary JSON, not just at known envelope paths — this is how to do a hygiene check.
