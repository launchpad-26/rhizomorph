# Architecture review

**Reviewer:** Fable seat 2 of 5 — architecture
**Date:** 2026-08-06
**Scope:** docs/architecture.md, docs/record-format.md, docs/decisions/, verified against packages/core, packages/server, packages/web

---

**Verdict**
- Package boundaries are real, not cosmetic: `core` depends only on `zod`, has zero `node:*` imports, and no cross-import was found between `web` ↔ `server`. The dependency graph is enforced by what's importable, not just convention.
- Event-sourcing earns its keep because one property makes it true: live and replay share the *same reducer* (`reduceAll`). This isn't a polling dashboard cosplaying as event-sourced — replay really is free, and the golden-era-corpus mechanism (`packages/core/src/eras/`) proves the reducer's meaning is pinned, not just its shape.
- Biggest structural risk isn't core/server/web — it's `lab` + `judge`, a second, mutation-capable product (worktree forking, dispatch, merge-tree conflict prediction) grafted onto a codebase whose entire premise is "read-only observer." The two-hands model is currently just discipline (a lint-style source-tree test), not a package boundary.

## 1. Package boundaries

`core` ships only `zod` as a dependency (`packages/core/package.json`), has no Node types in scope by design (`packages/core/src/eras/fold.ts`'s own comment: "core has no Node type definitions in scope at all... because core is bundled into the browser"), and writes its own `basename`/SHA-256 rather than assume Node ambients. Grep confirms zero `node:*` imports outside tests, and zero cross-imports between `web` and `server`. `server` depends on `core` + `fastify`; `web` depends on `core` + `react`/`d3`.

This is a real, enforced separation — dependency direction is strictly `web → core ← server`, never sideways.

## 2. Event/selector/era model

`docs/architecture.md`'s claim — "one SSE hook feeds one reducer into React context... live and replay are the same reducer" — checks out: `StreamContext.tsx` and the record-replay path both fold through `core`'s `reduceAll`. Selectors (`packages/core/src/selectors/*`, 11 modules) are pure functions over `SessionState`, shared verbatim by server (doctor, lane derivation) and web (`buildFleet`).

This is the load-bearing decision and it's real: derived facts (collisions, flatline, spend) exist in exactly one place. The complexity is bought back by unit-testability (fixture text in, events out, no live git/tmux needed) and by `docs/record-format.md`'s portable, hash-chained record — a genuinely federatable artifact, not a toy.

## 3. `eras/era-1` — designed, not aspirational, and smaller than the name suggests

It is **not** a schema-migration system. `eras/CAPTURE.md` and `fold.ts` reveal it's a golden-snapshot regression harness: one real (redacted) 100-line log slice per era, whose fold is committed and asserted byte-identical in CI. There is exactly one era, and no `era-2` exists or is scheduled — the migration story is explicitly deferred (`docs/prd17.md`: "the day a migration is needed it has a home... every event already flows [through the reducer]").

That's an honest, minimal position — a designed placeholder, not a half-built promise — but the directory name overclaims: it reads like a versioning scheme and is actually a corpus-of-one.

## 4. Collectors — one real contract, five implementations, one outlier

`packages/core/src/collector.ts`'s `Collector<Snapshot>` interface (`poll(prevSnapshot, ctx) → {nextSnapshot, events}`, plus the prd15 `capabilities` honesty manifest over six signals) is genuinely shared — git/tmux/workmux/otel/sessionlog all implement it, each with fixture-driven tests and no live binary required (`collectors/*/fixtures`).

Adding a seventh is cheap: implement `poll`, declare `capabilities`, add fixtures.

The outlier is `judge` (`packages/server/src/collectors/judge` *and* `packages/server/src/judge/`) — it's not a passive fact-collector, it's speculative `git merge-tree --write-tree` conflict prediction (`judge/mergetree.ts`), read-only in a narrower, harder-to-verify sense ("writes loose objects, never referenced") than the other five.

## 5. `lab`/`judge` — a second product under an amended constitution

`docs/architecture.md`'s prd12 section is explicit: "the read-only constitution is AMENDED, not dissolved. Two hands."

`packages/server/src/lab/` (fork, checkpoint, restore, compare — 4,259 lines) creates real worktrees and branches, confined to `refs/rhizomorph/` by *convention enforced in a test* (`lab/namespace-law.test.ts` greps the source tree) plus a runtime guard (`assertInsideLabWorktrees`), not by package isolation. `web/src/lab/` is another substantial slice with its own launch/compare/branching UI.

This is architecturally a second product (mutation, dispatch, speculative merging) sharing `core`'s types and living in the same repo/build as a read-only observer. It belongs here today because it reuses `core`'s event model and the web shell, but the boundary between "instrument" and "actor" is a naming/test convention, not a type system or process boundary — the next feature that wants to mutate more freely has no structural wall to hit.

## 6. Data flow

```
collector.poll(prevSnapshot) --events--> poll-loop.ts --appends--> session log (.jsonl, outside repo)
                                              |                          |
                                              v                          v
                                     SnapshotStore (restart)      SessionRecorder
                                              |
                                              v
                              GET /api/stream (SSE, backlog+live) --or-- GET /api/sessions/:id/events
                                              |
                                              v
                              web: StreamContext --reduceAll (core)--> SessionState
                                              |
                                              v
                         selectors (core, pure) --> buildFleet (web) --> panels/scene
```

Source of truth is the append-only JSONL log (`~/.local/share/rhizomorph/<repo-slug>/session-*.jsonl`), outside the watched repo. Server-side `SessionState` is a derived, restart-losable cache (the snapshot store persists collector *snapshots*, not folded state) — divergence risk is low because both live and replay reduce the same log through the same pure function. The one place state could actually diverge is `.swarm/lanes.json`, read fresh per-request with no caching (`api/lanes.ts`), correctly avoiding a second stale copy.

## 7. Most expensive-to-reverse decision

Not core/server/web, not the event model — it's `lab`'s enforcement being test/convention-based rather than structural.

Right now "read-only except lab, and lab only touches its own namespace" is upheld by a grep-based test and a runtime assertion inside the same server process. As `lab`/`judge` grow (they already have dispatch, forking, merge-tree prediction), retrofitting a real process/package boundary between "observer" and "actor" — if that ever becomes necessary for safety or licensing reasons — means separating what's currently one Fastify process and one npm workspace tier.

Everything else (collector contract, selector purity, event schema) is cheap to extend by comparison.
