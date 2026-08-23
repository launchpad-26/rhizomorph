# prd-40 — the record survives the write: an event on screen is an event on disk

> **Status:** **BLESSED** — Ciaran Slow, 2026-08-22, in session. Milestone `prd40`. Drafted the same day from the reconciled audit
> at `03df141` (findings 5 and 7 — untracked artefact, `.gitignore`d; the sha is the anchor). Ruling 1 needs an **ADR** before its code — it changes what a replay may
> contain, which is ADR-0011's territory, not this PRD's.

## Problem

ADR-0011 promises that recordings never rot: what the instrument showed you, it can show you
again. Two seams break that promise in opposite directions.

Writing: the poll loop advances its collector snapshot **before** the recorder has finished
appending. A full disk or a permissions change loses the event permanently — it renders live,
never reaches the log, and the next tick diffs against an advanced snapshot so it is never
re-emitted. The dashboard and the record disagree, and only the record is kept.

Reading: `GET /api/meta` re-folds the entire in-memory event buffer on **every request**. The
cost grows with session length, on an ungated route the dashboard polls, and the repo's own
published figures put it above half a second on a long session.

## Evidence

- **The snapshot advances before the append is awaited.** `server/poll-loop.ts:216-218` — the
  snapshot assignment precedes the recorder call, so a rejected append cannot un-advance it.
- **The recorder's append is the only durability boundary.** `recorder/session-recorder.ts:80-84`
  — nothing above it retries, and nothing below it knows the event was dropped.
- **No test drives an append failure behind an emitting collector.** The recorder's own seal
  tests cover a throwing append and a throwing subscriber (`session-recorder.ts:104-108`); the
  poll-loop's do not induce one.
- **`/api/meta` folds the whole buffer per request.** `api/meta.ts:238` calls
  `buildLadderManifest`, which reaches `reduceAll(eventsSoFar())`; the buffer is emptied only by
  `openSession` (`session-recorder.ts:139`).
- **The route is ungated and polled.** `api/index.ts:132` classifies it `read`, so it carries no
  `preHandler`, and its call sites grew 9→16 between audits.
- **The cost is the repo's own measurement, not an estimate.** 113.5 ms at 25k events, 535.3 ms
  at 55k — from the published figures in the perf suite's own reports.
- **This is outside the documented exemption.** The "session log is unbounded by design" row
  covers the log on disk; it says nothing about an in-memory buffer re-folded per request.

## Success

1. An event that reaches a subscriber has reached the log. **Not met while** any path publishes an
   event — pushing it to the live buffer or emitting it to subscribers — before its append
   resolves, or advances collector state before its append resolves, or leaves the fold ahead of
   the file after a rejected append. Both loci count: the recorder's own `record`/`closeWith`
   ordering *and* the poll loop's snapshot advance.

   **One named exception, and no other.** The degrade `collector.error` that reports an append
   failure may be emitted without having been appended. It is the alarm saying the log is
   unwritable, so requiring it to reach the log first silences it in exactly the case it exists
   for — on a full disk the alarm's own append fails too. This criterion is about not showing
   collector data the record never received; an alarm is not that data. The exemption is for this
   one event type on this one path, it is asserted **by name** in the law rather than inferred
   from a category, and no collector-derived event may carry it. Ruling 1 restates it where the
   ordering is specified, because an exception recorded only in a success criterion is an
   exception nobody implementing the ruling will read.
2. A dropped write is loud. **Not met while** an append failure produces no `collector.error`,
   no degrade voice, and no line the operator could find afterwards.
3. `/api/meta` costs the same at hour six as at minute one. **Not met while** answering it is
   O(events in the session) rather than O(1) in the work the request itself adds.
4. The replay contract says what a replay may now contain. **Not met while** at-least-once
   delivery ships without an ADR naming duplicate-on-replay as accepted or excluded.

## Non-goals

- **No gating of `/api/meta`.** Tempting and wrong: prd-29 sequences that route into wave 2, and
  gating it here would break `rhizomorph env`, `doctor` and the CI boot smoke mid-milestone. This
  PRD makes the route **cheap**, not private.
- **No change to the on-disk record format.** `docs/record-format.md`'s manifest, hash chain and
  line grammar are untouched; prd-11 and prd-17 own them.
- **No rotation or retarget work.** `recorder/rotate.ts` is prd-16's territory and finding 20's
  concurrency gap belongs to prd-42.
- **Not the fold-order divergence.** `#205` stays open and unruled; nothing here states or
  implies a resolution, and no wave may assume one.

**Rejected alternatives.** *Buffering failed appends in memory and retrying* — it moves the loss
window rather than closing it and invents a second durability story beside the recorder's.
*Making the fold incremental inside `buildLadderManifest`* — it puts session state in a manifest
builder, and the next caller of `eventsSoFar()` pays the cost again; the fold belongs to the
recorder that owns the events. *Caching `/api/meta`'s response with a TTL* — it makes a
correctness problem into a staleness problem, on the one route whose whole job is to report what
is true now.

## What already exists (do not rebuild)

- `reduce` at `core/src/reduce.ts:141` — the single-event fold. The incremental cursor consumes
  it; it is not reimplemented.
- The spend cursor (`core/src/selectors/spend-cursor.ts`) — the repo's existing worked example of
  a maintained incremental fold with a prime-once cost, including its cache-key discipline.
- `closeWith`'s seal release at `session-recorder.ts:104-108` — the recorder already unwinds its
  *seal* correctly when an append throws, and that unwind is reused untouched. It is only the seal
  that is right: the publish ordering around it is part of the defect, so the gap is **both above
  the recorder and inside it**. An earlier draft of this line claimed the gap was above it only;
  that was wrong, and ruling 1 is scoped to the code, not to that claim.

## Rulings

## Ruling 1 — the append is awaited before the event is anyone's

**Publishing happens after the append resolves, at every site that publishes.** There are three,
and all three are in scope:

- `record()` (`session-recorder.ts:78-84`) awaits `writer.append(event)` **before** `buffer.push`
  and before `emitter.emit('event', …)`. Today it does both first, so a rejected append has
  already handed the event to every subscriber and to `eventsSoFar()`.
- `closeWith()` (`:97-111`) does the same, in the order seal → append → `sync` → push → emit. The
  seal is still taken *first*, so prd17 ruling 1's structural guarantee is untouched — a
  collector poll landing in the same tick still cannot slip in behind the final line. Only the
  publish moves; the existing `catch` that releases the seal and rethrows is reused as-is.
- The poll loop (`server/poll-loop.ts:216-218`) awaits `recorder.record(event)` before
  `snapshots.set`. On rejection the snapshot is **not** advanced, the event is reported through
  the existing degrade path, and the next tick re-derives it.

**The one exception, named here so it cannot spread.** The degrade `collector.error` reporting an
append failure is emitted whether or not its own append succeeds — see success 1. The law asserts
that exemption against that event type on that path, by name. Any other event emitted without a
resolved append is a defect, and a law that exempts a *category* rather than a name has already
lost the guarantee.

The recorder is the durability boundary, so it is the recorder that must not publish early.
Fixing the poll loop alone would satisfy the snapshot half of success 1 and leave the subscriber
half broken — a subscriber would still see an event the log never received. This is the sibling
shape `AGENTS.md` names first: `record()` and `closeWith()` are structurally identical publishers
one screen apart, and a fix that lands in one and not the other is the defect this repo keeps
finding.

The consequence is deliberate and is the reason this ruling needs an ADR before its code: a
re-derived event can be appended twice if the first append partially succeeded, so replay becomes
**at-least-once** rather than exactly-once. That is a change to what a recording may contain, and
ADR-0011 is where it is recorded. The ADR may instead rule that duplicates are unacceptable and
require a dedupe on the read side — in which case this ruling is amended, not deleted.

## Ruling 2 — the fold the server answers from is maintained, never rebuilt

The recorder keeps a running `SessionState` beside its buffer: updated in `record()` via the
existing `reduce`, reset in `openSession()`, and exposed as `foldSoFar()`. `/api/meta` and every
future caller read that instead of calling `reduceAll(eventsSoFar())`.

The law is a spy, not a benchmark: it asserts the number of `reduce` calls per request is
constant as the session grows. A wall-clock assertion would be the same mistake prd-24 is
cleaning up after — a test that measures and does not assert.

## Sequencing (waves, each gated as ever)

`recorder/` and `server/poll-loop.ts` are this PRD's territory. `api/index.ts`'s route classes are
prd-29's; no wave here changes a `routeClass`. `core/src/reduce.ts` is consumed, never edited.
Every wave follows prd-39 wave 1 — nothing should land through a gate that pushes a broken build.

**Wave 1 — the Keystone.** `prd40 w1: the recorder answers from a fold it maintains` (ruling 2).
Additive, zero-claimant: `foldSoFar()` is new surface, no existing caller changes behaviour, and
wave 2 and every later reader consume it.

**Wave 2 — after the ADR, not before.** `prd40 w2: an event reaches the log before it reaches a
subscriber` (ruling 1). Gated on the ADR that ruling 1 names. Dispatching it earlier builds a
delivery guarantee nobody has ruled on. **One issue, one fence, both files:**
`recorder/session-recorder.ts` *and* `server/poll-loop.ts`. Splitting the recorder half from the
poll-loop half into two issues would let one land without the other, which is precisely the
half-fix ruling 1 exists to prevent — and its test must drive an append failure through a live
subscriber, not only through the snapshot.

**Wave 3 — parallel, fenced apart:** `prd40 w3: /api/meta answers from the maintained fold`
(`api/meta.ts`) · `prd40 w3: a dropped append speaks in the degrade voice`
(`server/poll-loop.ts` + the collector-error path). Both consume wave 1; they share no file.

**Unfiled work implied, described not numbered:** the other fifteen call sites reached by
`eventsSoFar()` were counted but not audited one by one. If any of them folds per call the way
`/api/meta` does, it is the same issue with a different route name.

## Open questions

- **Does a duplicate on replay break any existing consumer?** The golden-era corpus folds
  byte-identically today; nobody has checked whether it would survive a repeated line. The ADR
  ruling 1 names should answer it with the corpus, not by argument. Open, not ruled.
- **Should `foldSoFar()` be the only reader, with `eventsSoFar()` narrowed to the exporter?**
  It would make ruling 2 structural rather than conventional, but it touches every current
  caller. Open, not ruled.
