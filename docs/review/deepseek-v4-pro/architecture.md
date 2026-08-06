# Architecture review

- **Right call, right shape**: the `core`→`server`/`web` dependency direction is clean, the `Collector<S>` interface is genuinely generic across five of six collectors, and `reduce(state, event) → state` being the single chokepoint through which both live SSE and replay scrub folds is the architecture's load-bearing truth.
- **One honest leak, one hidden split**: the lane manifest and transcript endpoint read disk *outside* the event log — by design, documented, and read-only, but they *are* side doors. Worse: OTel is not a poll-based `Collector` at all; it is a push REST ingester wired through `api/otel.ts` that directly calls `recorder.record()`, and nobody reading `collector.ts` would know it exists.
- **Era migration is designed but untested by fire**: `upcast`, the golden corpus, and CI snapshot pinning are all real and wired correctly. But there is exactly one era. The second one will be the proof.

```
┌─────────────────────────────────────────────────────────────┐
│  COLLECTOR TIER (poll 2s)          PUSH TIER (POST)         │
│  git ─┐                                                      │
│  tmux ─┤                                                      │
│  workmux ─┤── poll-loop ── recorder ── session.jsonl    ◄── api/otel.ts
│  judge ─┤                            ▲                       │
│  sessionlog ─┘                       │                       │
│                                      │                       │
│  CLI (lab) ──── checkpoint/fork ────┘                       │
│                                      │                       │
│  SIDE DOORS (read-only, disk)        │                       │
│  /api/lanes ── .swarm/lanes.json     │                       │
│  /api/transcript ── Claude JSONL     │                       │
├──────────────────────────────────────────────────────────────┤
│  SERVER ── SSE /api/stream ──► WEB (reduce() from core)     │
│            GET /api/sessions                                  │
│            GET /api/meta                                      │
└─────────────────────────────────────────────────────────────┘
```

### 1. Package boundaries

The dependency direction is one-way and correct: `core` (zero deps except `zod`) is imported by both `server` and `web`. No reverse imports exist — `grep` across all three packages returns empty for `@rhizomorph/web` imports from server/core and `@rhizomorph/server` imports from core/web.

But two splits weaken the "core owns the contract" claim:

- **Sessionlog is wired in `cli/run.ts`**, not in `collector-loader.ts` where git/tmux/workmux/judge are assembled. Two separate assembly points means two places to forget a new collector. The sessionlog collector *does* implement `Collector<SessionlogSnapshot>` correctly — it just isn't registered alongside its peers. The reason appears to be its extra configuration needs (`claudeProjectsRoot`, `extraSessionDirs`, `backfill`) that the loader's zero-arg `loadCollectors()` signature cannot thread through without becoming a longer options bag.

- **OTel bypasses the `Collector` interface entirely.** `api/otel.ts` registers three `POST` routes (`/v1/metrics`, `/v1/logs`, `/v1/traces`) that call `recorder.record()` directly after parsing OTLP payloads. There is no snapshot, no `poll()`, no `capabilities` declaration — the OTel "collector" directory under `collectors/otel/` is really a *parser library* consumed by an API route, not a collector. The naming is honest about this (`OtelEmitter`, not `OtelCollector`), but it lives in the collectors directory alongside real `Collector<S>` implementations, which misleads a reader scanning the tree.

### 2. Event-sourcing: real, with side doors

The event-sourcing model is **genuine, not costume**. `reduce()` in `packages/core/src/reduce.ts` (~1,300 lines) is a pure function folding every event type into `SessionState`. The web's `foldStreamEvent` calls `reduce()` — the identical function replay's `useReplaySession` calls. That identity is what makes replay "free." The upcast chokepoint (`events/upcast.ts`) is called inside `reduce()`, so every event path goes through migration. The golden era corpus (`eras/fold.ts`) pins this in CI: a reducer change that alters a committed era-1 fold breaks the build.

But **three side doors exist** where the server reads state the event log never sees:

1. **`/api/lanes`** (`server/src/api/lanes.ts`) reads `.swarm/lanes.json` directly from disk on every request. This data — lane handles, branches, fence globs, parked status — is never folded into `SessionState`. It is the *only* source of lane identity mapping and fence compliance, and it lives outside the event log entirely. A replay of a session without the corresponding lanes.json file loses all lane geography.

2. **`/api/transcript/:lane`** (`server/src/api/transcript.ts`) seeks into raw Claude Code session JSONL files on disk, bounded by byte offsets. The sessionlog collector *does* emit telemetry events into the log, but the full conversation text lives only on disk — the event log carries token counts and agent status, not the conversation itself.

3. **OTel push ingestion** (`api/otel.ts`) writes directly to the recorder. It validates payloads against core schemas and contributes `llm.usage`, `agent.activeTime`, and trace events — all properly shaped. But it skips the `Collector` contract: it has no snapshot, no `poll()`, and the poll loop doesn't know it exists. The architecture doc's claim that "every fact is an event in one append-only log" is true; the claim that "collectors and the server loop build against the same contract" is only true for polling collectors.

These side doors are defensible — the lane manifest is operator-authored metadata, not observed fact; full transcripts are too large for the event log; OTLP is a push protocol. But the architecture doc should name them.

### 3. Era-1 and the migration story

The migration infrastructure is **designed, not aspirational**: `upcast()` in `events/upcast.ts`, the `ERAS` registry in `eras/fold.ts`, and `corpus.ts` binding `era-1/recording.jsonl` + `session-state.snapshot.json` via Vite `?raw` imports all work today. The golden corpus test folds era-1's 100-line real-world recording and asserts byte-identical JSON output against the committed snapshot.

But **there is exactly one era**. The `ERAS` array has a single entry. `upcast()` is a no-op identity function for every event type it handles. The migration path — "add era-2, capture a new recording, bless the snapshot, and any reducer change that breaks the era-1 snapshot fails CI" — is real but never exercised. When era-2 arrives, `upcast()` is where old shapes become new ones, and the corpus for era-1 must still fold identically. That constraint will bite if the payload shape widens in a way the old recording's lines don't carry. The upcast function will need to synthetic-fill missing fields with era-appropriate defaults, and the corpus will verify it didn't break. The plumbing is in place; the test is waiting.

### 4. Collector abstraction: consistent shape, inconsistent registration

Five collectors implement the full contract:

| Collector | `Collector<S>` | `capabilities` | Snapshot type | Poll-based |
|-----------|----------------|----------------|---------------|------------|
| git | ✓ | ✓ | `GitSnapshot` | ✓ |
| tmux | ✓ | ✓ | `TmuxSnapshot` | ✓ |
| workmux | ✓ | ✓ | `WorkmuxSnapshot` | ✓ |
| sessionlog | ✓ | ✓ | `SessionlogSnapshot` | ✓ |
| judge | ✓ | ✓ | `JudgeSnapshot` | ✓ |
| otel | ✗ | ✓ (parser only) | none | ✗ (POST) |

The `Collector<S>` interface (`core/src/collector.ts`) is well-designed: generic over snapshot, `poll(prevSnapshot, context) → {nextSnapshot, events}`, with `capabilities` as an optional honesty manifest. Adding a seventh poll-based collector (say, a GitHub API watcher) would be cheap — implement the interface, add one line to `collector-loader.ts`, done. The `withResilience` and `withResumeReconciliation` wrappers apply automatically.

The cost of adding a second *push* receiver like OTel: you'd register another route in `api/`, write another parser, and call `recorder.record()` directly. No shared infrastructure beyond the recorder itself.

### 5. Lab and judge

**Judge** belongs in this codebase. It is a polled collector emitting `judge.finding` events (`severity: 'log'`) — the ladder's silent first rung. It diffs lane pairs for symbol overlap and speculative `git merge-tree` conflicts using deterministic, read-only git plumbing. Its `collector.ts` is 150 lines and fits the existing mold exactly.

**Lab** is a second product inside the first, but walled off with real discipline. It enables fork/capture/dispatch of Claude Code sessions for A/B experiments. Three facts keep the separation honest: (a) a namespace law test (`namespace-law.test.ts`) greps the entire server source and asserts no file outside `cli/index.ts` imports from `lab/`; (b) a web-side law test (`no-live-fleet-law.test.ts`) greps the lab tab source and asserts it imports no fleet/scene/panel code; (c) the lab has no `setInterval`/`setTimeout`. Its events (`fork.checkpoint`, `fork.dispatched`) carry `source: 'lab'` deliberately excluded from `eventSourceSchema` so no one mistakes it for a collector. It is an operator-invoked CLI with two read-only API routes; it never runs unattended. The separation is real but the lab's web UI (`packages/web/src/lab/`) is substantial — at ~20 files, a full comparison surface with its own geometry engine (`branching/geometry.ts`). It is a second application sharing the same process and data directory, not a panel of the first.

### 6. Data flow end-to-end

**Source of truth**: the session JSONL files on disk (`~/.local/share/rhizomorph/<slug>/session-<ts>.jsonl`). The poll loop writes events; the recorder owns the write handle. The server replays the log on SSE connect; the web folds it through `reduce()`. Both live and replay converge on the same state.

**Where they can diverge**:

- **Lane geography**: the fleet table reads `SessionState`'s worktrees and touches, then cross-references them against the lane manifest read fresh from disk (`/api/lanes`). If dispatch rewrites `.swarm/lanes.json` between polls, the fleet table sees lanes the event log hasn't yet discovered — or vice versa. The two sources reconcile on handle/branch names but have different update cadences.

- **Transcript**: the conversation drawer polls `/api/transcript/:lane` independently of SSE. It reads session files that the sessionlog collector is *also* tailing, so they share the same on-disk state — but the transcript endpoint reads forward from a client-side byte offset, while the event log has already folded whatever the collector emitted. A process kill between a collector tick and a transcript read can put the drawer one poll cycle behind.

- **Collector snapshots vs. event log**: snapshots are persisted to disk via `SnapshotStore` (for resume-after-restart), but they are JSON blobs opaque to the event log. If a snapshot is corrupted, the collector re-reads from scratch and re-emits events — the reducer is idempotent for `worktree.discovered`/`pane.discovered` (uses a Set internally), but `llm.usage` and `agent.status` events would duplicate in the fold. The architecture doc doesn't address whether duplicate usage events inflate spend selectors (they would).

### 7. Most expensive reversal in 6 months

**Making `SessionState` carry the lane manifest and transcript attribution.** These are currently read through side doors (direct disk reads) that the event log never sees. If the architecture evolves to need replayable lane geography — so a portable `.rhizorecord.json` can reconstruct a fleet view without the original `.swarm/lanes.json` — the lane manifest must become events in the log. That means a new collector (or the existing git collector) watching `.swarm/lanes.json`, emitting events on dispatch, and the reducer folding those events into `SessionState`. All existing code that reads the manifest fresh from disk (`/api/lanes`, `buildFleet`, `fences.ts`) would need to read from selectors instead. The codegen of the PR is small; the coordination of "what happens during the dispatch window where the file is written but the collector hasn't polled yet" is the expensive part — a problem the current side-door design sidesteps by reading on every request.
