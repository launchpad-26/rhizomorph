# Architecture review

- **Verdict:** The core event-sourcing bet is real and well-executed — one log, one reducer, replay genuinely free. But the codebase has quietly grown a second product (`lab`) that violates the founding law, and the migration story it advertises is wired in the wrong place.
- The `core`/`server`/`web` split is honest in dependency direction, but the product's most valuable derivation (`buildFleet`) lives in `web`, unreachable by anything else.
- `docs/decisions/` is a scene-cosmetics log (20 files, all geometry/palette), not an architecture decision record — the structural bets are documented only in prose.

## 1. Package boundaries: real, with one inversion

Direction is clean: `web` and `server` both depend on `@rhizomorph/core`; nothing imports upward (`grep` finds zero `@rhizomorph/server` imports in `web`). `core` is admirably disciplined — no `node:*`, hand-rolled SHA-256 and `basename` (`state.ts`, `record/hash.ts`) so it bundles to browser. The `Collector` contract in `packages/core/src/collector.ts` is the right shared seam.

The inversion: `buildFleet` (`packages/web/src/fleet/buildFleet.ts`) — the frozen/waiting diagnosis, ladder, the thing the whole instrument exists to say — is in **web**, composed from core selectors. `packages/server/src/api/lab.ts` needs spend-by-lane and re-folds with `reduceAll` + `selectSpendRateByLane` because the fleet object is unreachable server-side. Any future CLI, notification daemon, or second client re-derives or duplicates. Core holds the *facts*; the *judgment* shipped with the view.

## 2. Event sourcing: earning it, mostly

This is not a costume. The proof: `packages/web/src/app/streamState.ts` folds live SSE, fixtures, and replay through the same `foldStreamEvents`/`reduce`; `docs/record-format.md`'s hash-chained portable record replays through the same reducer; `eras/fold.ts` pins real 100-line recordings against committed state snapshots in CI. The news-vs-history tag (`NEWS_GRACE_MS`) and `upcast` chokepoint show the model is load-bearing, not decorative.

Two honest caveats. First, the "append-only log" has side doors: `/api/transcript/:lane` parses session logs directly, `/api/lanes` re-reads `.swarm/lanes.json` per request, and the OTel collector has its own attribution path — three facts the event log never sees, so replay of a session is *not* a complete replay of what the dashboard showed. Second, the server holds no folded `SessionState`; it replays raw events over SSE and folds only on demand (lab routes). Source of truth is the JSONL log, and there is exactly one — good — but the server is a dumber pipe than the architecture doc's "collectors + API" framing suggests.

## 3. Eras: designed in intent, mispositioned in mechanism

`era-1/` contains only fixtures (`recording.jsonl`, `session-state.snapshot.json`) — the corpus law is real and CI-enforced (`eras.test.ts`). But the migration chokepoint `upcast` (`events/upcast.ts`) is an identity function called from `reduce()` — **after** zod validation in `parseEventLenient`. An era-2 payload change to an existing type fails the discriminated union at parse and becomes an "unknown," never reaching `upcast`. The chokepoint can only ever see events the *current* schema already accepts. There is also no per-event version field (only the record manifest's `schemaVersion`). Era-2 will require either forever-widening unions or moving upcast ahead of parse — i.e., the retrofit the doc comment says it exists to avoid.

## 4. Collectors: one contract, honestly extended

Genuinely uniform: `poll(prev, ctx) → { nextSnapshot, events }` for git/tmux/workmux/sessionlog/otel/judge, fixture-tested pure parsers, `capabilities` (prd15's honesty layer) declared per collector — including `JUDGE_CAPABILITIES` declaring all-absent rather than taking the flattering default. Adding a seventh costs: one directory, a zod event family in `core/events/`, a union member, capabilities. The friction is the event union (`events/index.ts` spreads nine schema arrays into one discriminated union everything type-checks against) — it grows monotonically and every addition recompiles all consumers.

## 5. lab and judge: a second product, and it knows it

`judge` (`server/judge/` + `collectors/judge/`) is a legitimate collector — read-only, emits `judge.finding` events, deliberately independent of the git collector. Belongs here.

`lab` (~5.3k lines across `server/lab/`, `server/api/lab.ts`, `web/lab/`, `core/events/lab.ts`) forks checkpoints, restores worktrees, and `POST /api/lab/launch` **writes** — dispatching agents via an in-process `runCli` call, dynamically imported to dodge a module cycle. The read-only law survives only as a test (`namespace-law.test.ts`) and a doc-comment argument that a UI button is "an explicit human invocation." That is a rationalization: the instrument's founding promise ("never executes anything," enforced elsewhere by `drawer/readonly.test.ts` grepping for exec capability) now has a sanctioned hole with a capability token. Lab is an experimentation platform wearing the observer's trust.

## 6. Data flow

```
git/tmux/workmux/sessionlog/otel/judge
        │ poll() → diff events (2s tick)
        ▼
 poll-loop ──► SessionRecorder ──► ~/.local/share/.../session-*.jsonl  ← SOURCE OF TRUTH
        │                              │
        │ SSE /api/stream (backlog+tail)│ on-demand fold (lab API only)
        ▼                              ▼
 web: foldStreamEvents → SessionState → buildFleet → panels/scene
```

Divergence points: web's live fold vs. server's on-demand folds (same reducer, so benign); the three side channels (transcript, lanes.json, OTel) that bypass the log entirely; and collector snapshots (`snapshot-store.ts`) persisted outside the log, meaning restart behavior isn't derivable from the log alone.

## 7. Most expensive to reverse

**The unversioned event union with the chokepoint downstream of validation.** Every JSONL log, golden corpus, and exported record pins today's 25-family shape; era-2 will discover `upcast` can't see the events it exists to rewrite, and the fix — versioned envelopes, pre-parse migration — touches the wire format, the corpus, the record spec, and every consumer at once. Runner-up: lab's write path, which each month of use makes harder to excise from a tool whose entire credibility is "read-only."
