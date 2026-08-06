# Architecture review

* **The event-sourcing model is real but incomplete:** The UI is genuinely driven by a folded event stream, but side channels like `.swarm/lanes.json` leak state outside the event log, breaking replay fidelity.
* **`lab` and `judge` are a second product:** Rhizomorph is ostensibly a read-only observability dashboard, but the `lab` package is a write-heavy orchestrator that creates worktrees, runs tests, and mutates git state.
* **Boundaries hold but duplication looms:** Package boundaries (`core`/`server`/`web`) are strictly maintained, but the server and web independently fold the same event stream to derive state, trading redundant compute for isolation.

### 1. Package Boundaries
The `core` / `server` / `web` separation is a real boundary. `core` handles the domain (events, selectors, the reducer) and has zero `node:*` dependencies (`packages/core/src/eras/fold.ts`), allowing it to be bundled into the browser. The `server` and `web` depend on `core`, but never on each other.

**Dependency flow:** `server` &rarr; `core` &larr; `web`

**What Leaks:** State reduction is duplicated on both sides of the network boundary. Since the server needs folded state to calculate API capabilities (`packages/server/src/api/meta.ts`) and hydrate collectors on boot (`packages/server/src/server/collector-loader.ts`), it must run the same `reduceAll(events)` logic as the web client. 

### 2. Central Abstractions & Replay
The event sourcing model earns its complexity by powering genuine time-travel replay via a verifiable, append-only JSONL log (`docs/record-format.md`). 

**However, replay is not fully complete.** There is a glaring side door: `packages/server/src/api/lanes.ts` reads the dispatch manifest (`.swarm/lanes.json`) directly from the local filesystem on every GET request. As noted in `docs/architecture.md`, `fence.declared` events are ruled but not yet landed. Thus, fences are never captured in the event log. A replayed session cannot accurately reconstruct a trespass because the filesystem state of `.swarm/lanes.json` from the time of recording is completely lost.

### 3. The Migration Story (era-1 vs era-2)
The migration story in `packages/core/src/eras/era-1` is deliberately designed, not aspirational. As `packages/core/src/eras/fold.ts` explains: *"One small REAL recording per era, folded in CI by whatever the reducer has become. If a future change alters the fold of a past era, the build fails."*

When `era-2` arrives, a new `era-2/recording.jsonl` fixture and snapshot will simply be added. There are no schema migrations—only a strict guarantee that the current reducer can still fold old log shapes into their exact historical byte-for-byte `snapshot.json`. Unknown event types from newer eras are counted and preserved verbatim in the record.

### 4. Collector Abstraction
There is one consistent contract: `Collector<Snapshot>` (`packages/core/src/collector.ts`). Git, Tmux, Workmux, and Judge all seamlessly implement `initialSnapshot()` and `poll()`, and are dynamically wrapped with resilience logic via `loadCollectors`.

**The exceptions:** The `otel` collector (`packages/server/src/api/otel.ts`) is push-based (an HTTP receiver on Fastify) and `sessionlog` tails files directly; they bypass the polling loop.
**Cost of a 7th collector:** Extremely low. It simply requires implementing the `Collector` interface and injecting it into the `loadCollectors` array.

### 5. Lab and Judge: A Second Product
Rhizomorph's core identity is a "read-only localhost dashboard." The documentation insists that *"exporting a record never touches the watched repo"* (`docs/record-format.md`).

But **`lab`** breaks this boundary entirely. `packages/server/src/lab/fork.ts` creates git worktrees, mutates commits, and orchestrates new agent processes via `workmux add`. `lab/compare.ts` shells out destructive commands like `npm test`. Lab is an orchestrator hiding inside an observability tool.

**`judge`** (`packages/server/src/judge/lanes.ts`) is a read-only "structural organ" to cross-reference file collisions across lanes, though it operates somewhat independently of the standard git collector's state to preserve its signal integrity.

### 6. Data Flow End to End

```text
[Tmux/Git/OTel/Manifest]
      |      | (file read)
 (poll/push) |
      v      v
[ Collectors & API Routes ] ---> /api/lanes (side door) ---> [ Web UI ]
      |
      v
[ SessionRecorder ] -> disk (JSONL log, hash-chained)
      |
      v
[/api/stream (SSE)] -> [ Web `useEventStream` ] -> `reduceAll` -> [ SessionState ] -> [ Selectors ]
```

**Source of truth:** The append-only JSONL log on disk.
**Where state is held:** The authoritative folded state is held entirely in the *web client* (`SessionState`).
**Where they diverge:** They diverge exactly at the server's filesystem side-doors (`/api/lanes`). If a workspace's `.swarm/lanes.json` changes while the UI is replaying an older log, the UI will paint the historical log against the modern, unversioned filesystem fence, generating a hallucinated UI state.

### 7. Most Expensive Decision to Reverse
**Folding 100% of state on the client.** By choosing to make `/api/stream` flush the entire event backlog (`flushBacklog` in `packages/server/src/api/stream.ts`) and relying on the web bundle to build `SessionState`, the architecture couples performance entirely to client-side CPU. In 6 months, as sessions cross 100,000+ events, parsing and reducing this on every page reload will throttle browser tabs. Reversing this—moving the source of truth to a server-side queryable database or sending pre-reduced snapshots—would mandate tearing out the core event-sourcing paradigm, rewriting replay, and destroying the "portable zero-dependency record" guarantee.
