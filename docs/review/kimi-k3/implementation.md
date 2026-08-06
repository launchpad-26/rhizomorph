# Implementation review

- The poll loop's core safety story (serialized appends, per-collector try/catch, resilience wrapper, hash-chained records) is genuinely solid — but the richest collector (`sessionlog`) is wired in **without** the resilience wrapper, so one transient failure kills liveness/telemetry until restart.
- The recurring failure mode is *parser throws → poll aborts → `collector.error` spam every 2s with the collector effectively dead*, plus several silent-degradation paths (workmux join keys, Claude project slugs, quoted git paths) where the dashboard just shows nothing, with no error.
- Recorder failure handling has two hard edges: an append failure crashes the process via unhandled rejection, and a failed rotation seals the recorder into a permanent hang.

## Findings (ranked by likelihood × impact)

**packages/server/src/cli/run.ts:129** — `createSessionlogCollector` is appended raw, not through `loadCollectors`' `withResilience` wrap. Its `poll` latches `disabled: true` on a single failed `stat(~/.claude/projects)` or `git worktree list` (collector.ts:148-160) and no-ops forever after. One transient hiccup (an external-disk sleep, a git index lock) permanently kills all token/liveness/turn-shape data with one easily-missed `collector.disabled` event — the exact #110 bug the wrapper exists to fix.

**packages/server/src/server/poll-loop.ts:114-123** — the catch block `await recorder.record(...)` is itself unguarded. If `SessionLogWriter.append` rejects (disk full, session-dir perms), `runTick` rejects; `setInterval(() => void tick())` makes it an unhandled rejection → Node 22's default `throw` mode kills the server. Scenario: disk fills mid-session; the *error-reporting path* is what crashes the process.

**packages/server/src/recorder/session-recorder.ts:96-108 + recorder/rotate.ts:96** — `closeWith` takes the seal *before* awaiting append/fsync. If that write throws, `sealed` is never released: every later `record()` awaits forever, the poll loop's in-flight tick never settles, and `pollLoop.stop()` hangs. Server stays up, silently brain-dead; the dashboard just stops updating.

**packages/server/src/collectors/tmux/list-panes.ts:32-36** — `parseListPanes` throws unless exactly 7 tab-separated fields, but tmux does not escape format expansions: a `pane_current_path` or `window_name` containing a tab or newline (legal in POSIX paths; `mkdir $'a\tb'` and a pane cd'd there) yields 8 fields → throw → poll-loop catches → the tmux collector is dead (snapshot never updates) and spams `collector.error` every 2s for as long as that pane exists.

**packages/server/src/collectors/workmux/collector.ts:96-99** — `listByHandle` is keyed by `row.branch` but looked up with `row.handle`; the join only works because workmux currently names worktrees after branches verbatim. A slashed branch (`feat/foo` → sanitized handle) never joins: `branch`/`worktreePath` are permanently null in every `agent.status`. Worse, the fixture/test (collector.test.ts:75) asserts `worktreePath: '(here)'` and `'../2-core'` pass through verbatim — downstream comparing these against the git collector's absolute paths never matches, so cross-collector lane identity silently breaks.

**packages/server/src/collectors/sessionlog/worktree-slug.ts:10** — slug replaces only `/` and `_`; Claude Code also maps `.` → `-` (e.g. `~/.claude` → `-claude`). Any worktree path containing a dot (`~/work/v2.0/wt`, a dotted username) resolves to a nonexistent project dir, which `tailProjectDir` treats as "no session yet" (collector.ts:352) — zero transcripts, zero errors, forever.

**packages/server/src/collectors/git/parse-status.ts:14-27** — no unquoting of porcelain v1's C-quoted paths. With default `core.quotePath`, `café.ts` appears as `"caf\303\251.ts"` and a rename as `R  "old" -> "new"`; dirty-file paths then mismatch the raw paths every other collector emits, and rename detection via first `' -> '` breaks on filenames literally containing that substring.

**packages/server/src/collectors/git/parse-log.ts:83** — `parseFile` throws on an unparseable `--raw` line (a filename containing a newline does this). The throw aborts the entire git poll mid-`diffBranches`; the snapshot is never updated, so every subsequent tick re-attempts the same range and re-throws: git collector dead + 2s error spam, all `branch.updated`/`worktree.dirty` events lost, until the offending history scrolls out of the polled ranges.

**packages/server/src/collectors/git/git-collector.ts:238-247** — a worktree directory deleted but not yet `git worktree prune`d still appears in `worktree list`; `git status` with that cwd fails (spawn ENOENT) and the *previous* dirty set is carried forward indefinitely — the dashboard shows ghost dirty files for a gone worktree with no signal.

**packages/server/src/collectors/sessionlog/tail.ts:22** — truncation/rotation blindness: `info.size <= offset` returns the stale offset unchanged, so a truncated or replaced session file is never re-read and new lines are dropped silently forever (the transcript API has a `restarted` heuristic at api/transcript.ts:274; the collector doesn't). Also `Buffer.alloc(size - offset)` per poll is unbounded — a `--backfill` first read of a 500MB log allocates it whole.

**packages/server/src/recorder/session-recorder.ts:33,84** — `buffer` retains every event of the session in memory for `eventsSoFar()`/SSE replay; a weeks-long session with per-poll `tool.activity` grows without bound, and any SSE client whose `Last-Event-ID` isn't found (stream.ts:44) triggers a full replay of it.

**packages/server/src/api/stream.ts:129-132** — the live path discards `writeEvent`'s backpressure signal; only the backlog flush respects `drain`. A slow or half-dead client on a busy session grows the socket buffer unboundedly, and `queued` accumulates unbounded while a long backlog flushes to a client that never closes.

**packages/server/src/collectors/judge/collector.ts:196-231** — every sweep spawns one `git merge-tree` per lane *pair*: 15 lanes = 105 subprocesses plus 15 symbol diffs per minute. Fine at fleet-of-five scale; quadratic cost beyond it.

**packages/server/src/api/otel.ts:33-40** — Fastify's default 1MB `bodyLimit` is never raised; an oversized OTLP export surfaces through `setErrorHandler` as "malformed OTLP request body" (400), a misdiagnosis that makes a legitimate exporter retry forever. The refusal-throttle `Map` (line 238) also grows unbounded across distinct bogus `instance` ids.

**packages/server/src/collectors/workmux/collector.ts:88-90** — a non-ENOENT `workmux status` failure (or a workmux version with different table output) yields `parseStatusTable → []`: all agents silently vanish from the snapshot with no `agent.status` or error event, then re-emit as "changed" on recovery — flapping, invisible state.

**packages/server/src/cli/replay.ts:148** — round-trip caveat: `readRecord`'s `unknown` (newer-era) lines are voiced once in the CLI log but *not* written into the reconstructed session JSONL, so a replayed newer record's dashboard silently omits those events. Format versioning otherwise holds (schemaVersion is bound into the genesis seed; `verifyRecord` recomputes with the record's own version).

**packages/server/src/collectors/git/git-collector.ts:71,185** — a detached main-worktree HEAD makes `mainBranch` null, so every branch's `aheadOfMain/behindMain` degrades to null and the judge collector no-ops — silent, no event, in exactly the detached-HEAD setups spike work tends to create.
