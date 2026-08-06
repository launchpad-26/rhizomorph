# Architecture review

- **The core/server/web split is real and the dependency direction is clean** (`web→core`, `server→core`, no reverse imports; core has no `node:*` types and bundles into the browser). The event-sourcing discipline in `core` (lenient parse, `upcast` chokepoint, golden era corpus with byte-identical CI snapshots) is genuinely more rigorous than most "event-sourced" systems I've reviewed.
- **Replay is *not* complete.** Two surfaces the operator reads live — lane fences (`/api/lanes` reads `.swarm/lanes.json` fresh per request) and transcripts (`/api/transcript/:lane` reads the agent's own `~/.claude/projects/<slug>/*.jsonl`) — are side doors the event log never sees. The portable record (prd11) cannot reproduce them; replay returns `available:false` honestly, but "live and replay are the same reducer" is true only for the fold, not for the whole dashboard.
- **`lab` is a second product hiding inside the first.** A checkpoint/fork/dispatch experiment harness with its own mutating `POST /api/lab/launch`, its own git-ref namespace (`refs/rhizomorph/`), and a structural namespace-law test to keep it quarantined. Containment is strong; coherence is not.

## 1. Package boundaries

Real separation. `packages/core/src/index.ts` exports the event union, reducer, selectors, `Collector` interface, record/verify/merge, pricing — all pure. `web/src` imports only `@rhizomorph/core` (verified: zero `@rhizomorph/server` imports). `server/src` imports `@rhizomorph/core`. Two minor leaks: `web/src/recordings/export.ts` reaches into `@rhizomorph/core/src/record/index.js` (deep path past the barrel); and the `lab`/`judge` event *sources* are deliberately widened out of `eventSourceSchema` (`EVENT_SOURCE_BY_TYPE` `satisfies Record<EventType, EventSource | 'lab' | 'judge'>`), so core's wire schema disowns events that core's union owns. That's documented, but it means core's type system encodes a product split the schema doesn't.

## 2. Event sourcing: earning its complexity

Mostly yes. The fold (`reduce`) is the single function both `streamState.ts` (live) and `replayFold.ts` (replay) bottom out in; `upcast` is wired inside `reduce` so every event, live or replayed, flows through one identity chokepoint reserved for future migrations; `parseEventLenient` counts and voices unknown lines instead of silently dropping them; the era corpus (`eras/era-1/`) pins a *real* 100-line slice of a real log to a byte-identical snapshot in CI, and re-blessing is a human-typed command that vitest `-u` cannot trip. This is the real thing.

But it is a polling dashboard in one costume seam: replay fidelity holds for the fold, not for the screen. `/api/lanes` and `/api/transcript/:lane` are REST reads of files outside the log. The web has two data paths (SSE fold + REST manifest poll into `buildFleet`); the manifest is folded into the derived fleet object, not into `SessionState`. So "one event log in, one `SessionState` out" is true at `streamState.ts` and false at `buildFleet.ts`.

## 3. Eras — designed, not aspirational

`ERAS` has one entry; the mechanism is built for N. At era-2: add `era-2/recording.jsonl` + snapshot to `ERAS`; era-1's snapshot must still fold byte-identically or the build fails; a schema change writes an `upcast` arm that rewrites old shapes. The gap list in `eras.test.ts` already names the 10 event families era-1 doesn't reach (`session.started`, `collector.*`, `fork.*`, `judge.finding`, `telemetry.refused`). The cost is real: every reducer change re-blesses every era snapshot. This is the discipline you want.

## 4. Collector contract

Five of six (`git`, `tmux`, `workmux`, `sessionlog`, `judge`) implement `Collector<Snapshot>` with `initialSnapshot`/`poll` and `capabilities`. `otel` is the holdout: a passive HTTP receiver (`api/otel.ts`) calling `recorder.record(createEvent(...))` directly — `capabilities.ts` says verbatim "no `poll()` to attach capabilities to." So the contract is one shape for pull collectors and an unwritten second shape for push. Adding a seventh pull collector is cheap (implement, register, declare `AdapterCapabilities`); a seventh push receiver has no contract. `honestCapabilities`' active/inactive override only reaches poll collectors.

## 5. lab and judge

`judge` is a legitimate collector — independent `git worktree list` read for structural collisions, in the poll loop, emits `judge.finding`. Belongs. `lab` is an A/B experiment harness: `checkpoint.ts` captures a lane's state, `fork.ts` restores N arms into lab-namespaced worktrees + synthesized sessions and shells out to `workmux add`. `namespace-law.test.ts` proves no observer file imports `lab/` and that all writes stay under `refs/rhizomorph/`. It is well-quarantined and well-tested, but it is a different product (experiment management) co-located with an observation instrument, and it introduces a mutating POST into an otherwise read-only server.

## 6. Data flow

```
git/tmux/workmux/sessionlog/judge ──poll(prev)→{next,events[]}──┐
otel POST ──recorder.record(createEvent)──────────────────────┤
                                                               ▼
                              ~/.local/share/rhizomorph/<slug>/session-<ts>.jsonl  ◀── SOURCE OF TRUTH
                                                               │ SessionRecorder EventEmitter
                                                               ▼
                                          SSE /api/stream (backlog replay → live tail)
                                                               │ EventSource
                                                               ▼
                web streamState.reduce(core) ─▶ SessionState (React ctx) ─▶ selectors/buildFleet ─▶ panels+scene
                                                ▲                                 ▲
                REST /api/lanes  (.swarm/lanes.json, not in log) ─────┘  REST /api/transcript (~/.claude/…, not in log) ──┘
```

Source of truth: the JSONL log; `SessionState` is derived. Divergence points: (a) manifest and transcript are outside the log; (b) `buildFleet`'s `now`/`windowMs` make the ladder time-windowed — live uses `Date.now`, replay uses the scrubber clock, so the same log at the same offset can show different FROZEN/WAITING states. By design, but the log alone can't reconcile it.

## 7. Most expensive decision to reverse in 6 months

The lane manifest as a side-channel REST endpoint rather than a collector emitting events. Fences/parked/off-fence detection now flows through `buildFleet` from a manifest the event log never carries, so the portable record (prd11's headline) can't reproduce the fleet view a live operator saw. Reversing means: a `lanes` collector emitting `lane.fenced`/`lane.parked`, backfilling the manifest into the log, reworking `buildFleet` to read fences from state, and re-blessing every era snapshot — touching the record format, the era corpus, and the one object four surfaces read. Close second: extracting `lab`, whose `fork.*` events are already in the union and the era gap list.
