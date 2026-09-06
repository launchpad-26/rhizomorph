# 0038. A summons raiser judges the fold on the tick; it is not a collector

- **Status:** accepted (prd-17 ruling 5, ruled by the operator 2026-09-05)
- **Date:** 2026-09-06

## Context and Problem Statement

prd-17 ruling 1 gave the record its missing alarm: `summons.raised` /
`summons.cleared` (`packages/core/src/events/summons.ts`), keyed on `(lane,
kind)`. Landing the schema did not land an emitter. Without one, the record
stays exactly as observer-dependent as it was before ruling 1 — a summons
exists only if a browser happened to be open and a human happened to notice —
which is prd1's founding insight (orchestrated setups undercount by omitting
the orchestrator) recurring one level down, this time in the instrument's own
attention rather than a lane's.

The record must be complete whether or not anyone is watching, so the
instrument has to raise its own summons, server-side. That collides with
ADR-0004: every existing producer of a `RhizomorphEvent` is a **collector**,
and the collector contract (`packages/core/src/collector.ts`) hands a
collector exactly `repoPath`, `now`, `exec`, `nextId` and an `emit` — never the
folded `SessionState`, and never another collector's own output. A summons is
not a fresh observation of the outside world (git, tmux, a session log); it is
a judgement about facts the instrument has *already* recorded and already
folded through `buildFleet` (`packages/core/src/fleet/buildFleet.ts`) — a
lane's `pathologies`. Something has to read that folded judgement and decide,
per tick, whether an alarm condition started or ended. The question this
record answers is where that something lives, and why it is not a sixth
collector.

## Considered Options

- **A — Widen the collector contract** so one collector may receive the
  folded `SessionState` (or `Fleet`) instead of raw command output, and emit
  the summons pair from inside `poll()`.
- **B — The client declares what it summoned.** The web app already computes
  `Fleet.ladder`/`Lane.pathologies` for the attention strip; have it POST what
  it is showing.
- **C — Route it through the beacon door** (ADR-0036): the instrument writes
  a `summons` beacon line for its own collector to tail back in.
- **D — A raiser: a pure edge-trigger function, called from the poll loop's
  own tick**, fed `buildFleet`'s lanes and the previous tick's open-summons
  set, emitting through the recorder directly — not through `collector.poll()`
  at all.

Within D, two further choices this record also fixes: **where the previous
tick's open-summons set survives a restart**, and **which pathology kinds are
summons-worthy at all** (ruling 1 left `kind` an open string on purpose; this
build picks the first members).

## Decision Outcome

Chosen: **D**. `packages/server/src/server/summons.ts` exports one pure
function, `diffSummons(previous, current, now)`: last tick's `(lane, kind)`
points in, this tick's judged conditions in, `{ raised, cleared }` out, plus
the next snapshot to persist. `packages/server/src/server/poll-loop.ts` is the
only caller: at the end of `runTick()` — after every real collector has polled
— it reads `recorder.foldSoFar()`, folds it through `buildFleet`, filters
`Lane.pathologies` to the summons-worthy kinds, and hands the result to
`diffSummons`.

**A was rejected on the contract's own terms.** `collector.ts`'s doc comment
states the seam directly: a collector is *"pure logic over the output text of
shell commands"*, testable with fixture text and no live git/tmux/workmux.
Handing one collector the folded state — everything every OTHER collector has
already produced — is a different animal wearing the collector interface: it
would need `SessionState` threaded through `CollectorContext` for exactly one
consumer, and every future "does this depend on the fold or on the world"
question would need re-answering per collector. The five real collectors stay
what ADR-0004 already promised: raw-output parsers that have never needed to
know what any other collector saw.

**B was rejected because a summons is the instrument's own judgement, not an
external declaration.** The client already computes the same `Fleet` for
display; having it also be the one honest source of "this happened" makes the
record's completeness depend on a browser tab staying open — the exact
observer-dependence ruling 5 exists to close.

**C was rejected because a beacon is a writer's own line about itself**
(ADR-0036: *"one JSON line appended to a rhizomorph-owned directory and
tailed by a collector"*) — a declaration by the harness being watched, not an
inference by the instrument doing the watching. Routing a summons through the
door built for external emitters would have the server writing a file for its
own collector to read back, one tick later, the same fact it already holds in
memory. That is not a seam, it is a detour.

**Within D — where the edge-state lives:** the raiser's snapshot is stored
through the poll loop's existing `SnapshotStore`, under a reserved key
(`SUMMONS_SNAPSHOT_KEY = 'summons'`) rather than a new file or a new
persistence path. `SnapshotStore` is deliberately dumb — "JSON in, JSON out,
keyed by collector name" per its own doc comment — and nothing in its
contract requires the key to *be* a collector's name; `persist()` in
`poll-loop.ts` was narrowed from `(collector: AnyCollector, snapshot)` to
`(name: string, snapshot)` to make that explicit rather than fake an
`AnyCollector` object to satisfy the old signature. The alternative — a
second store, or a bespoke file next to the session log — was rejected for
introducing a second persistence mechanism to solve a problem the first one
already solves.

**Within D — which kinds raise a summons:** `isSummonsKind` derives the answer
from `PATHOLOGY_RANK` (`packages/core/src/fleet/pathology.ts`) rather than a
second, hand-maintained list. Every pathology core already ranks above
`notice` — today `frozen`, `looping`, `waiting`, `off-fence` — is
summons-worthy; `expensive`, the one `notice`-rank pathology, is not, matching
`docs/architecture.md`'s existing line that a notice *"never escalate[s]...
regardless of age."* A hand-listed enum was considered and rejected: it would
be a second place encoding a judgement (which conditions deserve
interruption) the ladder already makes, and the two would eventually disagree
about a kind neither list was updated for.

## Consequences

- **Good.** No judgement is duplicated. `buildFleet`, `readLanesManifest` and
  `parseLaneManifest` are each called exactly where they already were; the
  raiser adds one new fact (a tick-over-tick diff) and reads everything else
  secondhand.
- **Good.** `diffSummons` itself takes no collector, no clock read beyond the
  `now` it is handed, and no `Fleet`/`Lane` import — it is a three-field input
  (`lane`, `kind`, `since`/`detail`) and a five-line dedupe-and-diff body,
  which is what let both DoD mutations (raise-every-tick, drop-persistence)
  get direct unit coverage in `summons.test.ts` without a running loop, and
  integration coverage in `poll-loop.test.ts` against `buildFleet`'s own
  staged-pathology fixture — a real fold, not a fixture told what to say.
- **Good.** A session boundary (`reset()`) clears `summonsState` the same way
  it clears every collector's snapshot, for the same reason: the new
  session's log starts empty, so a condition still true right now still owes
  the new log its own `summons.raised`, regardless of what the old in-memory
  state or a newly-installed store remembers.
- **Bad.** `poll-loop.ts` now imports `readLanesManifest` from
  `packages/server/src/api/lanes.ts` — a new cross-directory dependency from
  `server/` into `api/`, in the direction `cli/doctor.ts` already established
  but `server/` itself had not needed before. A future reader tracing
  `poll-loop.ts`'s imports now has to know that one of them is a route
  module's exported reader function, not another piece of loop machinery.
- **Bad.** `raiseSummons()` calls `readLanesManifest` — a real `readFile` —
  once per tick, on every tick, whether or not `.swarm/lanes.json` has
  changed. `readLanesManifest`'s own doc says as much for `/api/lanes`'
  existing caller ("re-read fresh on every call... it is tiny"); the poll loop
  now does the same read every 2 seconds in addition to whatever request
  volume `/api/lanes` sees. Acceptable at today's file size and interval; a
  fleet whose manifest read becomes a bottleneck would need this revisited
  rather than assumed away.
- **Neutral.** The summons snapshot's persisted shape (`SummonsPoint[]`, just
  `{ lane, kind }` pairs) is deliberately smaller than what
  `diffSummons` computes per tick (`since`, `detail`) — only the key survives
  a restart, not the evidence that produced it. A restored process's very
  first raise after a restart (if the condition changed shape while it was
  down) would carry fresh evidence, not the evidence from before the restart;
  this is the same trade every collector's own snapshot already makes.
