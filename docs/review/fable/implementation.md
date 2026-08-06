# Implementation review

**Reviewer:** Fable seat 5 of 5 — implementation correctness
**Date:** 2026-08-06
**Scope:** collectors (git, tmux, workmux, otel, sessionlog, judge), recorder/replay, server + API polling and streaming, test quality, edge-case error handling

> **Correction applied after this report was filed:** this seat's diagnosis of the
> `namespace-law.test.ts` failure (below, "a companion canonicalization gap remains
> for `dataRoot`") is wrong. See [README.md](./README.md) for the verified cause —
> a raw vs canonical path comparison at line 655.

---

## Verdict
- **Severe, high-likelihood bug:** no collector subprocess ever gets a timeout, and the poll loop runs one collector at a time behind a single in-flight-tick gate — a single hung `git`/`tmux`/`workmux` call (credential prompt, index.lock, etc.) freezes the *entire* dashboard forever, including graceful shutdown.
- Git parsing has a real, verified data-corruption bug on non-ASCII filenames (git's default path-quoting isn't undone), and the git collector permanently self-disables on any transient failure with no recovery path short of a restart.
- Test suite is solid (3411/3412 passing) but the one failure is a genuine, reproducible bug, not flake.

## Findings

### 1. No subprocess timeout + single in-flight tick = permanent dashboard freeze

`packages/server/src/server/exec.ts:16` and `packages/core/src/collector.ts:15`

No collector ever sets `timeoutMs`, so `execFile`'s `timeout` is always `undefined` — no timeout is ever enforced. Combined with `packages/server/src/server/poll-loop.ts:121-128` (`tick()` returns the existing `inFlightTick` if one is running, and the interval just calls `tick()` again), one wedged subprocess call in *any* collector permanently stalls every collector, forever.

`stop()` (poll-loop.ts:138-144) awaits `inFlightTick`, so a graceful shutdown also hangs.

Concrete trigger: a private submodule/remote prompting for credentials, or `git status` blocking on a `.git/index.lock` held by a concurrent `git gc`/rebase in a watched worktree.

### 2. Git collector permanently self-disables on transient failure

`packages/server/src/collectors/git/git-collector.ts:73-81`

On any failed `git worktree list`, the collector sets `disabled: true` and every later poll short-circuits at line 66-68 with no retry. A transient failure (repo on a network mount blipping, a momentary lock) permanently kills all git data for the process's lifetime; only a server restart recovers it.

### 3. Git path-quoting is never undone — unicode filenames corrupt

`packages/server/src/collectors/git/parse-status.ts:12-35` and `parse-log.ts:66-80`

Git's default `core.quotePath=true` wraps any filename with non-ASCII bytes in `"..."` and octal-escapes the bytes (verified live: `café.txt` → `"caf\303\251.txt"` in both `git status --porcelain` and `git log --raw`/`--numstat` output).

Neither parser strips quotes nor decodes the escapes, so `DirtyFile.path` / `FileChange.path` end up literally containing quote chars and octal digits for any commit or dirty file touching a unicode filename — breaking display, path matching, and the merge/collision logic downstream.

No fixture anywhere covers a quoted/unicode path. Fix is trivial (`-z` output + NUL splitting, or unquote-on-parse) but currently unaddressed.

### 4. Sequential per-worktree git calls

`packages/server/src/collectors/git/git-collector.ts:260-267, 149-217`

`diffDirty` and `diffBranches` `await` one `git status` / `git rev-list` / `git log` per worktree/branch sequentially inside a `for` loop rather than in parallel. Not incorrect, but scales linearly with worktree/branch count and compounds finding 1 — more worktrees means more chances for one call to hang.

### 5. Session log tail can get permanently stuck after truncation

`packages/server/src/collectors/sessionlog/tail.ts:26`

`if (info.size <= offset) return { lines: [], nextOffset: offset, ... }`. If a session JSONL is ever truncated/rewritten (size drops below the stored offset), the tail gets permanently stuck: it never resets to 0, so new content is silently dropped until the file grows back past the stale byte offset. No inode/mtime-regression check exists anywhere in the caller (`collectors/sessionlog/collector.ts:446`).

### 6. Failing test — `src/lab/namespace-law.test.ts`

Genuine failing test, not flaky. *(Original diagnosis attributing this to a `dataRoot` canonicalization gap companion to commit `7a9219d` was subsequently shown to be incorrect — see the correction note at the top of this file.)*

## Test run

`npm test` (after `npm install`; no `vitest` binary was present pre-install): **3411 passed, 1 failed**, 227 test files (226 pass, 1 fail), ~100s.

The failure above is the only one; everything else — including the collector parser suites, record/replay round-trip tests, and poll-loop tests — is green.

Fixtures for tmux/workmux/otel/sessionlog are reasonably representative of real captured output (`*.real.txt`, versioned Claude Code fixtures). Git's fixtures are the weak spot: no unicode, no quoted-path, no detached-HEAD-with-spaces-in-path case.

---

## Second pass — parsing robustness, resource growth, disappearing repos

Filed after the first report, targeting the three areas the other four seats did not cover.

### 7. Permanent self-disable is a *pattern*, not a one-off

`git-collector.ts:73-81` and `tmux/collector.ts:77-88`

Both collectors permanently disable on their very first failure, with no retry, ever. Confirmed identical shape in both. The tmux case is the more likely to bite: `tmux kill-server`, or the last pane closing and taking the server down, disables the tmux collector forever — even after the user starts a fresh tmux session. Only a rhizomorph restart recovers it.

### 8. A deleted worktree keeps showing as healthy, with zero signal

`packages/server/src/collectors/git/git-collector.ts:260-267` (`diffDirty`) — **the sharpest finding in this pass.**

When a worktree directory is deleted (`rm -rf`, or `git worktree remove` run outside rhizomorph) while `git worktree list --porcelain` still lists it — git doesn't verify path existence for `list`, only for `prune` — `git status --porcelain` run with that path as `cwd` fails with ENOENT. The catch branch **silently carries forward the last-known dirty-file state**:

```ts
// Transient (e.g. a worktree mid-removal); keep last known state.
const carried = prevSnapshot.dirty[worktree.path]
if (carried) nextDirty[worktree.path] = carried
continue
```

No `collector.error`, no event of any kind. Contrast `diffBranches`, which does emit `collector.error` on failure.

The comment shows the author reasoned about the *transient* case (mid-removal) and handled it correctly for that case — but the same branch also swallows the *permanent* case. Net effect: a deleted worktree keeps appearing in the dashboard indefinitely, with stale dirty-file state, looking healthy.

Note the whole repo disappearing *is* handled visibly (`git-collector.ts:73-81` emits `collector.disabled`). It's specifically a single deleted worktree that goes unreported.

### 9. `SessionRecorder.buffer` grows unbounded for the process lifetime

`packages/server/src/recorder/session-recorder.ts:36, 78-83, 128-130`

`buffer` is an in-memory array holding *every event of the current session*, with no eviction — only a manual rotation (`openSession`, line 115) resets it. The module's own comments reference a real ~46k-event session (#166). A long-running unrotated session (busy multi-lane swarm, default 2s poll × many collectors × many lanes) grows this without bound.

The batching/backpressure work in `stream.ts` paces *writes to a socket*; it does nothing to cap what's held in memory.

**Compounding factor found during verification:** `eventsSoFar()` has **9 non-test call sites**, and line 129 returns `[...this.buffer]` — a full array copy every call. Two of those callers then fold the entire thing: `api/meta.ts:107` and `cli/run.ts:184` both run `reduceAll(recorder.eventsSoFar())`. So an `/api/meta` request costs a full copy plus a full reduce over every event in the session. That's O(n) per request against an unbounded n.

### 10. Dangling drain promise (minor)

In `stream.ts`'s `flushBacklog`, if a client's socket is destroyed while `onceDrained` awaits a `'drain'` that will now never fire, the promise hangs forever. Harmless — no timer, just a dangling closure — but real.

### Verified as *not* problems

- **Spaces in paths** — fine everywhere checked. `git worktree list --porcelain` treats the path as rest-of-line; tmux's `list-panes -F` output is tab-split, so a space inside `pane_current_path` doesn't break the 7-field count.
- **Detached HEAD** — parsed correctly (`parse-worktrees.ts:43-44` sets a `detached` boolean), and `diffBranches` naturally skips it since it only iterates `refs/heads/`. Correct, not a bug.

---

## Files read

`packages/server/src/collectors/git/*.ts`, `packages/server/src/collectors/tmux/list-panes.ts`, `packages/server/src/collectors/sessionlog/{tail,collector,parse-session-line}.ts`, `packages/server/src/server/{poll-loop,exec}.ts`, `packages/server/src/recorder/rotate.ts`, `packages/server/src/api/stream.ts`, `packages/core/src/record/read.ts`
