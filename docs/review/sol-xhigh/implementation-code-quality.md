# Implementation and code-quality review

**Reviewer:** `gpt-5.6-sol`, `xhigh` — implementation/code-quality agent  
**Date:** 2026-08-06  
**Scope:** implementation correctness, collectors, recorder/replay, server/API, frontend
state and performance, tests, TypeScript quality, error handling, maintainability, and
developer ergonomics

## Verdict

This is a technically serious codebase. It has strict TypeScript, lean dependencies,
clean lint/typecheck results, pervasive fixtures, strong law-style tests, multi-platform
CI, package smoke tests, and unusually candid performance instrumentation. The event
boundary and shared live/replay reducer are strong foundations.

The main weaknesses are cross-layer contracts and runtime ownership. Components are
well-tested in isolation while real browser/server behaviour, session-wide identity,
recorder ownership, subprocess lifetime, and backpressure fall between those tests.
Several hot paths also rebuild or copy whole-session state repeatedly.

## Critical correctness findings

### Browser rename cannot satisfy server authentication

The server mints an in-memory token and requires it on `/api/label`, but the security
module states that the token is never sent to the browser. The web request type cannot
carry it and sends only `Content-Type`:

- `packages/server/src/server/build-app.ts:56-72`
- `packages/server/src/api/label.ts:35-39`
- `packages/server/src/api/security.ts:16-32`
- `packages/web/src/recordings/label.ts:34-37,69-83`

Server tests introspect the app token while web tests mock success, so no cross-layer
test catches the real 401. Centralise mutation authentication and add a built-client to
built-server integration test.

### Event IDs are not session-unique

IDs are documented as session-unique, but separate factories are created for:

- Boot events: `packages/server/src/cli/run.ts:80-91`.
- Poll events: `packages/server/src/server/poll-loop.ts:41-43`.
- OTEL events: `packages/server/src/api/otel.ts:33`.
- Checkpoints: `packages/server/src/lab/checkpoint.ts:73-90`.
- Forks: `packages/server/src/lab/fork.ts:211-216,302-315`.

Factories reset across resume. SSE reconnect uses the first matching ID
(`packages/server/src/api/stream.ts:42-49`), so duplicate IDs can resume from an older
event and replay already-folded usage, cost, or activity.

Give the authoritative session recorder one persistent allocator, or use
collision-resistant IDs. Assert whole-log uniqueness and test reconnect after process
resume.

## High-priority implementation findings

### Lab writes can remain invisible to the running application

Checkpoint and fork paths create their own recorders. The dashboard launch endpoint
invokes that machinery in-process, while Lab GET routes deliberately prefer the live
server recorder's in-memory buffer over disk. Events written by the independent Lab
recorder do not enter the live buffer or emitter, so listings and SSE can remain stale.

Extract one append/domain service owned by the live server. Pass the authoritative
recorder into Lab operations and test POST launch followed immediately by GET and SSE.

### A hung subprocess freezes collection and shutdown

`timeoutMs` is supported by the execution contract and `execFile`, but no production
caller supplies it. Collectors run sequentially and shutdown awaits the active poll
without a deadline:

- `packages/core/src/collector.ts:13-19`
- `packages/server/src/server/exec.ts:11-18`
- `packages/server/src/server/poll-loop.ts:67-145`

Enforce a default timeout, propagate abort signals, terminate timed-out children, and
give collectors explicit budgets. Parallel collectors are reasonable if event
publication order remains deterministic.

### Recorder publishes before durable persistence

`SessionRecorder.record()` updates its buffer and emits SSE before awaiting append
(`packages/server/src/recorder/session-recorder.ts:78-83`). `closeWith()` has the same
ordering. After ENOSPC, EACCES, or another I/O failure, clients can observe an event that
will never exist in replay.

Append successfully before committing to memory/emitting, or model pending and failed
events explicitly. The recorder needs a durable degraded/fatal state rather than trying
to report a writer failure through the same failed writer.

### Fleet recomputation causes periodic main-thread stalls

`packages/web/src/fleet/FleetContext.tsx:56-73` rebuilds the full Fleet every second,
even without new events. `buildFleet` invokes overlapping spend/session/lane/role
selectors that repeatedly filter and allocate across the full event set.

The reviewer measured a representative 55k-event Fleet build at roughly 96 ms on
average, with heavier telemetry shapes substantially worse. Separate event-dependent
aggregates from clock-only status, build indexed summaries once, and introduce a
representative whole-Fleet performance budget.

### SSE backpressure and disconnect handling are incomplete

The stream waits only for `drain`, can wait indefinitely after socket destruction, and
does not consistently honour backpressure for queued/live writes
(`packages/server/src/api/stream.ts:63-130`). Slow clients can retain closures or grow
socket buffers.

Race drain with close/error/abort, unsubscribe and clear queues on termination, and
enforce a bounded per-client queue with a slow-client cutoff.

### Git parsing corrupts legitimate filenames

The collectors use human-oriented quoted Git output rather than NUL-delimited machine
formats. The reviewer reproduced a Unicode filename being preserved as Git's escaped
`"caf\303\251.txt"` representation. Tabs, newlines, and renames are similarly fragile.

Use `-z` formats and NUL-aware parsers. Add fixtures for Unicode, tabs, newlines, quotes,
backslashes, and rename records.

## Maintainability and resilience findings

### HTTP Lab handling is coupled to CLI prose and global process state

The endpoint serialises calls, dynamically imports the CLI, replaces
`process.stderr.write`, and parses output using regular expressions
(`packages/server/src/api/lab.ts:293-414`). This can suppress unrelated errors and makes
CLI wording an accidental API contract.

Create a typed Lab domain service returning structured results. HTTP and CLI should be
adapters, with injected output streams rather than global monkeypatching.

### Session tail does not recover correctly after truncation

`packages/server/src/collectors/sessionlog/tail.ts:23-46` preserves the previous offset
whenever file size is less than or equal to it. After truncation, new content remains
invisible until it grows past the stale offset, at which point the beginning is skipped.

Track file identity and detect `size < offset`; restart at zero while emitting an honest
reset/gap signal.

### Per-worktree Git failures silently preserve stale state

Status failure carries previous dirty data forward, while ahead/behind and commit-load
failures become missing values without a per-worktree degradation event. A disappeared
or unreadable worktree can keep looking healthy.

Emit structured per-worktree degradation and apply a consecutive-failure expiration
policy.

### Reducer and selector costs still grow disproportionately

Several hot event families append by spreading arrays, and replay/fleet paths refold or
rescan whole-session state. Existing measurements already show per-event cost increasing
substantially with session length. Preserve the pure public result while using a mutable
internal builder, chunked storage, or persistent indexed structures.

### Resource ownership is broadly unbounded

- The recorder retains every event in memory and `eventsSoFar()` copies the array.
- Lab arm count and request field lengths have no meaningful application caps.
- OTLP ingestion and error-event creation are not rate-limited.
- Per-client SSE buffering is not bounded.
- Session growth is warned about rather than constrained or paginated.

Add explicit budgets and degraded states instead of relying on eventual operator
rotation.

## Smaller issues

- Malformed percent-encoding can throw through direct `decodeURIComponent()` in
  `packages/web/src/router.ts:31-38`.
- Fire-and-forget heartbeat writes lack rejection handling in
  `packages/server/src/cli/run.ts:118-123`.
- Top-level shutdown uses `.then()` without complete rejection/finalisation handling in
  `packages/server/src/index.ts:20-24`.
- jsdom repeatedly reports unimplemented Canvas APIs, so the extensive scene tests do
  not exercise a realistic rendering implementation.
- Documentation and source comments frequently contain stale issue/PRD-era assertions,
  increasing the cost of distinguishing current invariants from history.

## Verification

- `npm run lint`: passed, 547 files.
- `npm run typecheck`: passed all workspaces.
- `npm test`: 3,411 passed and 1 failed out of 3,412.
- The failing namespace-law assertion compares raw `/var/folders/...` against Git's
  canonical `/private/var/folders/...` spelling. Its own evidence shows all arm
  worktrees inside the intended Lab directory; the later containment assertion passes.

## Strengths worth preserving

- Strong typed event boundary and thoughtful forward-compatible event parsing.
- One reducer model shared by live and replay.
- Strict TypeScript, clean lint/typecheck output, lean dependencies, and little unsafe
  typing.
- Extensive fixtures, namespace-law tests, performance instrumentation, multi-OS CI,
  minimum-Node coverage, and package-install smoke testing.
- Good work around serialised file writes, atomic snapshots, partial-line recovery,
  fsync ordering, symlink defence, and session resume reconciliation.
- Effective frontend replay batching and gap-free subscribe-before-backlog SSE ordering.
