# prd-40 — the record survives the write: an event on screen is an event on disk

> **Status:** **SHIPPED** — 2026-08-27. Milestone `prd40` closed with all ten issues done; the
> closeout, including the open question whose premise turned out to be false, is the last
> section of this document.
> Blessed by Ciaran Slow, 2026-08-22, in session. Drafted the same day from the reconciled audit
> at `03df141` (findings 5 and 7 — untracked artefact, `.gitignore`d; the sha is the anchor). Ruling 1 needs an **ADR** before its code — it changes what a replay may
> contain, which is ADR-0011's territory, not this PRD's.
>
> **That ADR landed 2026-08-25:** [ADR-0029, "A recording may repeat a fact"](../adr/0029-a-recording-may-repeat-a-fact.md),
> accepted, amending ADR-0011. Wave 2 is dispatchable. See the amendment inside ruling 1 — the ADR's
> evidence corrected the *mechanism* this PRD named, though not its conclusion.

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
- **The recorder's append is the only durability boundary.** `recorder/session-recorder.ts:117-125`
  — nothing above it retries, and nothing below it knows the event was dropped.
- **No test drives an append failure behind an emitting collector.** The recorder's own seal
  tests cover a throwing append and a throwing subscriber (`session-recorder.ts:147-153`); the
  poll-loop's do not induce one.
- **`/api/meta` folds the whole buffer per request.** `api/meta.ts:238` calls
  `buildLadderManifest`, which reaches `reduceAll(eventsSoFar())`; the buffer is emptied only by
  `openSession` (`session-recorder.ts:166`).
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
   **Met 2026-08-25** — [ADR-0029](../adr/0029-a-recording-may-repeat-a-fact.md) names it
   accepted: a recording may contain the same fact twice, and a reader must not treat that as
   corruption. At-least-once on the poll path, at-most-once on the other eleven
   `recorder.record` sites, and no read-side dedupe.

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
- `closeWith`'s seal release at `session-recorder.ts:147-153` — the recorder already unwinds its
  *seal* correctly when an append throws, and that unwind is reused untouched. It is only the seal
  that is right: the publish ordering around it is part of the defect, so the gap is **both above
  the recorder and inside it**. An earlier draft of this line claimed the gap was above it only;
  that was wrong, and ruling 1 is scoped to the code, not to that claim.

## Rulings

## Ruling 1 — the append is awaited before the event is anyone's

**Publishing happens after the append resolves, at every site that publishes.** There are three,
and all three are in scope:

- `record()` (`session-recorder.ts:117-125`) awaits `writer.append(event)` **before** `buffer.push`
  and before `emitter.emit('event', …)`. Today it does both first, so a rejected append has
  already handed the event to every subscriber and to `eventsSoFar()`.
- `closeWith()` (`:136-154`) does the same, in the order seal → append → `sync` → push → emit. The
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

**Amended 2026-08-25.** The ADR this ruling waited on is
[ADR-0029](../adr/0029-a-recording-may-repeat-a-fact.md), accepted, amending ADR-0011. It ruled
duplicates **accepted**, so the ruling above stands unchanged in what it requires. Its evidence
did, however, falsify the *mechanism* named in the paragraph above, and the original wording is
kept because a lane reading it would otherwise build against a case that cannot happen:

- **"If the first append partially succeeded" is not the generator, and cannot be.** The writer
  strips a trailing partial line only when resuming (`recorder/session-log-writer.ts:157`), so
  mid-session a retry is `O_APPEND`ed onto the half-written bytes and glues into one malformed
  line. Both events are lost and counted unreadable — not duplicated.
- **The real generator is batch granularity, and it needs no partial write.** `poll-loop.ts:216-219`
  advances one snapshot per *batch*, then appends the batch in a loop. A clean rejection on event
  *k* leaves events 1..*k*-1 fully appended with the snapshot un-advanced, so the next tick
  re-derives and re-appends **all** of them. Duplicates are therefore routine on any append
  failure and arrive in runs, not singly — commoner and cleaner than this ruling assumed.

The conclusion is unmoved: replay becomes at-least-once, and that is accepted. Only the sentence
explaining *how* a duplicate arises was wrong.

**Amended 2026-08-25, second — each publisher publishes three times, not twice.** This ruling
enumerates `buffer.push` and `emitter.emit`. Wave 1 (#3, PR #67, merged 2026-08-24) put a third
publish between them: `advanceFold()`, which folds the event into the maintained `SessionState`
that ruling 2 exposes as `foldSoFar()`. Both publishers now read
push → `advanceFold` → `emit` → `append`:

- `record()` — push `:119`, `advanceFold` `:120`, emit `:123`, append `:124`
- `closeWith()` — push `:141`, `advanceFold` `:142`, emit `:144`, append `:145`

So the append must be awaited before **all three**, not two. Success 1 already requires this in
words — *"or leaves the fold ahead of the file after a rejected append"* — but this ruling's site
list predates wave 1 and never named it, and a lane building the two it names would leave the
fold ahead of the file: exactly the half-fix this ruling exists to forbid, in the surface wave 1
was written to create.

**The three move together and keep their order.** #3's mid-emit invariant pins that a subscriber
reading `foldSoFar()` from inside `emitter.emit` sees exactly the events `eventsSoFar()` shows it
(`session-recorder.ts:96-98`). Reordering push against `advanceFold`, or separating either from
the emit, breaks a law wave 1 landed. Move the block, not the statements.

**Amended 2026-08-25, third — `closeWith`'s `catch` is NOT reused as-is.** The paragraph above
says the existing `catch` that releases the seal "is reused as-is". Once the append moves first
that sentence is a defect, and it collides with **prd17 ruling 1**:

- Today the subscriber throws *before* the append, so the close genuinely did not happen and
  releasing the seal is right.
- Append-first, the subscriber throws *after* a durable close. The same `catch` would release the
  seal on a session that is closed on disk, and a later `record()` would append a line behind
  `session.closed` — the thing prd17 ruling 1 makes structural.

**prd17 ruling 1 wins, and a durable close does not fail.** Three rules, and the third exists
because the first two alone were a regression:

1. A failed append or sync releases the seal and rejects. The close did not happen, so the seal it
   took must not outlive it.
2. A durable close **holds** its seal. Releasing it would let a later `record()` append behind
   `session.closed`. Only `openSession` releases a seal the close earned.
3. Once the close is durable, **nothing below it may reject** — a throwing subscriber is reported,
   never propagated.

**Rule 3 was missed on the first pass and found in review of the wave-2 PR.** `rotate.ts` reaches
`removeSessionLock` (`:149`) and `openSession` (`:168`) only once `closeWith` resolves. With rules
1 and 2 alone, a subscriber throwing after a durable close rejected `closeWith`, so `openSession`
never ran — and rule 2 had just made `openSession` the *only* thing that can release that seal.
The recorder was left sealed with nothing alive to release it: every later `record()` parks
forever on the seal wait, `runTick` never returns, `inFlightTick` never clears, and the poll loop
stops silently and permanently. Reproduced through the real `rotateSession`, and confirmed as a
**regression** — on the pre-wave-2 code the same probe self-heals.

A subscriber's bug is not the closer's failure. `record()`'s own comment already draws that
asymmetry, and the poll loop's `recordOrDegrade` (#239) already establishes the shape: the
reporting path is never the crash path.

**With rule 3, this strengthens the law rather than weakening it**, which `CONTRIBUTING.md`
requires — and without rule 3 it did not, which is the honest record of what review caught. The
law at `session-recorder.test.ts:50` existed so the recorder never hangs on a seal nobody
released. Rules 2 and 3 together keep that guarantee *and* add the durable-close hold the old law
did not have. Rules 1 and 2 alone kept the hold and lost the guarantee.

**Amended 2026-08-25, fourth — a publish is bound to the session that issued the append.**
`await writer.append(event)` is the first suspension point `record()` has ever had. A rotation can
run `closeWith` (`rotate.ts:134`) and then `openSession` (`rotate.ts:168`) while a poll-loop
`record()` is parked on it; on resume it would push a closed session's event into the *new*
session's buffer, fold and subscribers. `record()` therefore captures its writer before awaiting
and publishes nothing if the recorder has moved on. The event stays durable in the file it was
appended to — the session it belongs to.

**Amended 2026-08-26, fifth — a session is closed when its line is appended, not when it is
synced.** Operator ruling, taken on #80 before that issue was dispatched. Rule 1 above says "a
failed append **or sync** releases the seal", and that wording is the defect: an append that
resolves has already put `session.closed` into the file, so a sync that fails afterwards releases
a seal on a session that is closed on disk — and a later `record()` appends behind the close line.
Confirmed pre-existing on `main` by two reviewers with a probe that rejects `sync` once, and
invisible downstream, because `verifyRecord` computes the chain over the body as given.

**Rule 1 splits in two:**

1a. A failed **append** releases the seal and rejects. The close did not happen — nothing reached
    the file — so the seal it took must not outlive it. Unchanged.

1b. A failed **sync after a successful append does not release the seal.** The close *did* happen:
    the line is in the file, and prd17 ruling 1's guarantee that it is the last line is now owed.
    `closeWith` still rejects, so the failure is reported rather than swallowed — losing durability
    is a fact the operator must learn — but the seal it earned stays, and only `openSession`
    releases it.

**What made this a fork, and why it is not one.** Holding the seal on a failed sync appears to
wedge the recorder: `rotate.ts` reaches `openSession` (`:168`) only once `closeWith` resolves, so a
rejected close would leave the seal held with nothing alive to release it — the hang rule 3 was
added to prevent. That is real, and it is a property of the **caller**, not of this rule. The seal
is only unreleasable because reopening is conditional on a successful close.

**So reopening becomes unconditional.** `rotate.ts` opens the next session whether `closeWith`
resolves or rejects. A session that could not be synced still ends, a fresh one still starts, the
sync failure still reaches the operator, and no line ever lands behind `session.closed`. Rule 3 is
untouched — a durable close still may not reject below the append — and the law at
`session-recorder.test.ts:50` keeps the guarantee it was written for.

**Two alternatives, and why they lost.** *Leave it as written* — the record can be silently
corrupted and nothing downstream detects it, which is the failure shape ADR-0011 abolished for the
silent skip. *Release the seal and record that the close was unsynced* — honest, but it does not
actually prevent a line landing after `session.closed`; it only annotates a file that has already
broken prd17 ruling 1.

**Fence consequence, recorded before the change.** #80 was fenced to `session-recorder.ts` and its
test. Rule 1b's cost lands in `rotate.ts`, so that issue widens to
`packages/server/src/recorder/rotate.ts` and `rotate.test.ts`. Note prd-42's #49 touched that file
on 2026-08-26 (`9406974`); #80 rebases onto it rather than racing it.

**What "unconditional" costs, ruled 2026-08-26 in review of the amendment.** Raised by
@gabriel-canaan: the sentence above dissolves one fork and opens three smaller ones, and a ruling
that leaves those to a lane has not finished the job it names for itself. `rotateSession`
(`rotate.ts:261-262`) is `closeCurrentSession` then `openNextSession`, and the second takes the
first's `ClosedSession` — which a throwing close never returns. So all three are ruled here.

1b-i. **`closeCurrentSession` returns rather than throws.** It absorbs the recorder's rejection and
   returns a `ClosedSession` that carries the sync failure. **Nothing has to be reconstructed:**
   `sessionId`, `filePath`, `closedAt` and `eventCount` are all captured at `rotate.ts:120-123`,
   before the first `await`, so the descriptor is fully determined before the failure point.
   `nextSessionStart(closed.sessionId, …)` therefore still guarantees a strictly greater id.
   **Rule 1b is untouched by this** — `SessionRecorder.closeWith` still rejects, and reporting the
   lost durability is still its job. The absorption is at the rotation layer, which is the layer
   that owns what happens next.

1b-ii. **`removeSessionLock` still runs** (`rotate.ts:149`). The lock guards a *live* session, and
   the session is not live: its close line is on disk, which is what 1b establishes. Skipping it
   would leave an orphan lock beside the new session's for no gain. Recorded because the blast
   radius was measured rather than assumed — locks are per-session files and go stale after
   `LOCK_STALE_MS`, so the wrong answer here is untidy and self-healing rather than dangerous,
   which is exactly the kind of question a lane would otherwise decide silently.

1b-iii. **`/api/rotate` answers 200, with the lost durability stated in the body.** Under 1b a
   rotation can partly succeed: the old session closed, the new one open, durability gone. An error
   status would say nothing happened, which is false, and would invite a retry that rotates a second
   time — a worse outcome than the one being reported. 409 is spoken for by `RotationRefusedError`
   and is not reused. The route reports the fact; it does not refuse.

**In scope for #80, and out of it.** In scope: `closeCurrentSession`'s return shape, the
unconditional call to `openNextSession`, the lock's placement, and the field `/api/rotate` reports.
Out of scope: `RotationRefusedError` and the 409 path, `LOCK_STALE_MS`, and any change to what
`closeWith` itself promises beyond 1a/1b above. A law drives **append resolves, sync rejects** —
neither existing seal law covers it, and a test that only rejects `append` would pass while this
stayed broken.

**The `eventCount` question is ruled with it.** `closeCurrentSession` reads
`recorder.eventsSoFar().length + 1` (`rotate.ts:124`), which can undercount a `record()` whose
append is in flight but whose buffer push has not happened. Under 1b the close line's authority
begins at its own append, so the count it carries is what was known at that moment and no more.
**The count is a claim about the buffer, not a census of the file** — say so where it is written,
and let `verifyRecord` remain the thing that counts lines. It is in #80's scope to state, not to
re-engineer.

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
delivery guarantee nobody has ruled on. **Gate lifted 2026-08-25** —
[ADR-0029](../adr/0029-a-recording-may-repeat-a-fact.md) is accepted and #4 is dispatchable.
**One issue, one fence, both files:**
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

### Re-sequenced 2026-08-25 — waves 3 to 6

The three waves above are kept as written: waves 1 and 2 ran exactly as planned and landed
(#3 in #67, #4 in #79), and wave 3's original text is the record of what was expected. What
follows is what the wave actually is, and why it split.

**One file did it.** `recorder/session-recorder.ts` turned out to be claimed by three issues at
once, and `AGENTS.md` forbids bundling across a live fence — two issues claiming one path is a
rebase conflict already scheduled. So they run in consecutive waves, ordered by the Timeline and
Priority already on them rather than by preference.

- **Wave 3 — parallel, fenced apart.** `#5` /api/meta answers from the maintained fold
  (`api/meta.ts`) · `#81` architecture.md says what a replay may now contain
  (`docs/architecture.md`). Both consume wave 1; they share no file.
- **Wave 4.** `#26` a dropped append speaks in the degrade voice — ruling 2's other half, and
  success 2. Now/High, so it takes the contested file first.
- **Wave 5.** `#69` `foldSoFar()` cannot be corrupted by the caller that reads it.
- **Wave 6.** `#80` a fsync failure cannot leave a line after `session.closed`. Last of the three,
  because it is the only one still gated on an operator ruling and would otherwise hold up two
  issues that need none.

**Why wave 3 lost the degrade-voice half.** `#26` was authored above as wave 3, fenced to
`server/poll-loop.ts`. Writing its plan showed it unbuildable there. Its DoD requires the degrade
`collector.error` to be emitted *whether or not its own append succeeds* — success 1's named
exception — and after wave 2 there is no way to do that from the poll loop: `record()` appends
before it publishes and so publishes nothing when the append fails, which is precisely the
disk-full case the alarm exists for, and the recorder's emitter is private. Publish-without-append
has to be added on the durability boundary itself, which is `session-recorder.ts`.

**Two dependencies this PRD's own tooling could not see, recorded so the next PRD expects them.**
`scripts/fence-lint.sh` compares fences **as declared**, and both of these are real couplings it
passed clean over:

- **A widening that has not happened yet is invisible.** `#26` declared `poll-loop.ts` alone, so
  its collision with `#69` and `#80` existed only in the plan, not in the fences. The lint that
  exists to catch a bad fence before anyone is dispatched cannot catch a fence that is about to
  change.
- **A shared type is not a shared path.** `#5` and `#69` share no file, but `#69` may change what
  `foldSoFar()` returns and `#5` consumes it — so the assembled wave breaks while each lane is
  green alone. Resolved by binding `#5` to treat the return as read-only unconditionally, which
  makes every shape `#69` can reach safe and removes the dependency without ordering the wave.

**A ruling was found stranded, not missing.** `#26`'s DoD rests on success 1's named exception,
whose commit had been pushed to `prd39-paper` the day after that branch's PR merged and never
landed. On `main` the exception did not exist, so the issue would have had a lane knowingly break
a live success criterion. Landed in #86, along with a prd-41 pointer stranded beside it.

## Open questions

- **Does a duplicate on replay break any existing consumer?** **Answered 2026-08-25, with the
  corpus.** No test breaks; meaning does. Duplicating each of era-1's 100 lines in turn and
  re-folding through the corpus law's own `foldEraRecording` + `canonicalStateJson` — with the
  untouched recording folding byte-identically to its committed snapshot as a control — changes
  the fold beyond envelope bookkeeping in **79 of 100** lines, across 7 of the 15 families
  present. Six accumulate; one corrupts, a repeated `agent.status` writing `previousStatus` to
  the *current* status (`reduce.ts:631`). One duplicated `llm.usage` moves `selectSessionSpend`
  from $0.7042407 to $0.7585227. Nothing goes red: the corpus is a committed fixture, so it is
  the measuring instrument here and a poor alarm. [ADR-0029](../adr/0029-a-recording-may-repeat-a-fact.md)
  accepts that cost — an over-reporting record is recoverable, a silently lost event is not — and
  records what it rejected, including a content-hash dedupe that would delete a genuine event at
  1-in-100 on this same corpus. **Fixing the seven non-idempotent arms is not scoped by this PRD.**
- **Should `foldSoFar()` be the only reader, with `eventsSoFar()` narrowed to the exporter?**
  It would make ruling 2 structural rather than conventional, but it touches every current
  caller. Open, not ruled.

---

# Outcome — shipped 2026-08-27

Ten issues, eleven pull requests, five days from blessing to close. Both rulings landed, all four
success criteria are met, and the PRD produced **three ADRs** — one as a prerequisite it named for
itself, two as consequences it did not.

Written at `37d537f`, the merge that closed the milestone. Ruling numbers above are untouched; this
is appended, as the standard requires.

## The two rulings, as they landed

| ruling | issues | landed | deviation from the mechanism this PRD named |
|---|---|---|---|
| 1 — the append is awaited before the event is anyone's | #4, #26, #80, #106 | PR #79, #105, #118, #125 (plus PR #77 for its prerequisite ADR and PR #116 for its fifth amendment) | **yes, and the PRD recorded it itself.** ADR-0029's evidence corrected the *mechanism* ruling 1 named while leaving its conclusion intact — the amendment inside the ruling says so. Three later corrections followed the same pattern: the degrade alarm had to move to the durability boundary (#26), close-versus-sync became two separate catches with opposite meanings (#80, the fifth amendment), and one subscriber's throw turned out to blind the others (#106). |
| 2 — the fold the server answers from is maintained, never rebuilt | #3, #5, #69, #81 | PR #67, #98, #114 | none in shape. `foldSoFar()` landed as new additive surface exactly as planned, and the frozen-fold requirement (#69) was a hardening the ruling did not anticipate rather than a change to it. |

Wave 3 bundled two issues into one PR (#98 carried #5 and #81). Waves 4 through 7 could not: three
issues contended for `recorder/session-recorder.ts`, so they ran as consecutive single-issue PRs.
See "what the plan got wrong" below — that is a collision between two rules, not a lapse in either.

## The four success criteria, assessed

1. **An event that reaches a subscriber has reached the log — met.** `record()` awaits its append
   before it publishes, and the poll loop advances its collector snapshot only after every event in
   the batch is on disk (`poll-loop.ts` says so in its own words). Both loci, as the criterion
   demanded. The one named exception is exempt **by name and by type**:
   `recordAlarm(event: EventOf<'collector.error'>)`, so no collector-derived event can reach the
   carve-out at all — a compile-time property rather than a claim a caller can make.
   **Still true after prd-44 ruling 4 bounded the in-memory window**, which a reader will wonder
   about: the bound changes which events a *new subscriber replays*, not whether an event that
   reaches a subscriber reached the log first, and the fold stays complete either way.
2. **A dropped write is loud — met.** #26, and the alarm reaches subscribers even when its own
   append cannot (ADR-0030). #106 then removed the way one broken dashboard could silence that
   alarm for every dashboard behind it.
3. **`/api/meta` costs the same at hour six as at minute one — met, and pinned by a count.** The
   fold is maintained incrementally and `/api/meta` answers from it. The law asserts **zero extra
   `reduce()` calls per `foldSoFar()` read, at two session sizes**
   (`session-recorder.test.ts`), plus a reference-identity law that a re-fold cannot fake — the
   spy alone was structurally blind to a rebuild through `reduceAll`, which the file records.
4. **The replay contract says what a replay may now contain — met 2026-08-25**, before wave 2 was
   allowed to dispatch. [ADR-0029](../adr/0029-a-recording-may-repeat-a-fact.md) names
   duplicate-on-replay accepted. The criterion's own text above carries the date.

## Three ADRs, and only one was planned

- **[ADR-0029](../adr/0029-a-recording-may-repeat-a-fact.md)** — the prerequisite this PRD named
  for itself and gated wave 2 behind (PR #77). Its evidence then corrected ruling 1's mechanism.
- **[ADR-0030](../adr/0030-the-alarm-may-outrun-the-record.md)** — the alarm may outrun the record.
  Success 1's named exception, promoted to an ADR once #26 showed it had to live on the durability
  boundary rather than in the poll loop.
- **[ADR-0031](../adr/0031-the-recorder-hands-out-a-frozen-fold.md)** — the recorder hands out a
  frozen fold. Ruling 2 said the fold is maintained; it did not say the fold is handed out by
  reference to sixteen callers, which is what made a caller's mutation silent, permanent for the
  session, and unrepairable.

Both consequential ADRs were reached from a wave's *build*, not from its plan. An ADR a PRD can
name in advance is the exception here, not the rule.

## The two open questions

**1. Does a duplicate on replay break any existing consumer? — answered 2026-08-25**, with the
corpus, and the answer is above in full: no test breaks, meaning does, in 79 of era-1's 100 lines.
ADR-0029 accepts that cost and records the content-hash dedupe it rejected. Fixing the seven
non-idempotent reducer arms was explicitly not scoped here and remains unowned.

**2. Should `foldSoFar()` be the only reader, with `eventsSoFar()` narrowed to the exporter? —
still unruled, and its premise is false.** Two things learned after this PRD stopped looking, both
worth having before the question is asked again:

- **There is no exporter caller to narrow to.** `cli/export-record.ts` and `cli/export-otlp.ts`
  both read the recording back from **disk** via `readSessionEvents`, never from the recorder's
  buffer. The question as phrased proposes narrowing a surface to the one consumer that does not
  use it. (Found while auditing all fourteen call sites for prd-44 #37, and recorded on that issue
  after this PRD had already named the question a prerequisite it was not.)
- **`eventsSoFar()` is no longer the whole session.** prd-44 ruling 4 bounded it to the last
  `MAX_BUFFERED_EVENTS`, so the interesting question has changed shape: it is no longer "who may
  read the raw events" but "which readers can tolerate a window". Eleven call sites read it today;
  two that could not — `rotate.ts`'s event count and `cli/run.ts`'s boot fold — were moved to
  `foldSoFar()` by prd-44 #37, which is ruling 2's own recommendation arriving where it was needed.

**Open, not ruled** — and whoever picks it up should re-ask it in prd-44's terms rather than these.

## What the plan got wrong

The re-sequencing above already records the three things this PRD found about itself, in its own
voice and dated: one file claimed by three issues at once, `#26` authored into a wave its own plan
proved unbuildable, and two dependencies `scripts/fence-lint.sh` structurally cannot see. Those
stand. What only hindsight adds:

- **The bundling rule lost to the fence rule, and neither was wrong.** The working agreement says
  bundle, because the ~21 h toll is per-PR. `AGENTS.md` says never bundle across a live fence,
  because two issues claiming one path is a rebase conflict already scheduled. Waves 4–7 were three
  issues on `recorder/session-recorder.ts` plus one found later, so they paid the toll four times
  on purpose. A PRD whose rulings converge on one file should expect that at grooming time and say
  so, rather than let the two rules meet in the sequencing section.
- **"Unfiled work implied" came true exactly, and was found by someone else's review.** The
  Sequencing section says the other fifteen `eventsSoFar()` call sites "were counted but not
  audited one by one. If any of them folds per call the way `/api/meta` does, it is the same issue
  with a different route name." One did — `api/lab.ts` — and it surfaced during the review of #98,
  became **#104**, and shipped under prd-44 rather than here. The prediction was right and cost a
  milestone boundary anyway: **an extension clause that names a defect shape should come with a
  search for every instance of it, at grooming time.** prd-44's closeout reached the same
  conclusion independently, from its own ruling 1.
- **The docs debt was created by the fence discipline working, and nobody planned for it.** #99 and
  #100 exist because two waves *correctly* declined to open `docs/architecture.md` across a live
  fence. That is the discipline behaving as designed, and its predictable cost is a docs pass at
  the end — which sat as the last open work in the milestone for two days. A closing docs wave
  belongs in the sequencing from the start, not as debt discovered when everything else is done.
- **A ruling can be stranded on a merged branch.** #26's DoD rested on success 1's named exception,
  whose commit had been pushed to `prd39-paper` after that branch's PR merged and never landed —
  so on `main` the exception did not exist. Recovered in PR #86. The general form of this is now in
  `AGENTS.md`'s Landing section (`50c8804`): a green gate on a branch whose base is not `main` has
  landed nothing.

## Residuals

None open. Everything this PRD spawned has landed or has an owner elsewhere:

- **#104** — the third parse-cache reader, prd-44's, shipped in PR #129.
- **#106** — the subscriber-isolation gap #26's build found, shipped here in PR #125.
- **The seven non-idempotent reducer arms** ADR-0029's corpus evidence exposed: explicitly out of
  scope, still unowned, and the strongest candidate this PRD leaves behind.
