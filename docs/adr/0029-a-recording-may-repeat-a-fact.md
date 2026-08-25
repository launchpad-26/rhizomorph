# 0029. A recording may repeat a fact: at-least-once on the poll path, declared rather than deduped

- **Status:** accepted
- **Date:** 2026-08-25
- Amends [ADR-0011](0011-recordings-never-rot.md).

## Context and Problem Statement

ADR-0011 promises that recordings never rot: what the instrument showed you, it
can show you again. prd-40 ruling 1 closes the write-side half of that promise —
the recorder awaits `writer.append(event)` before it publishes, and the poll loop
awaits `recorder.record(event)` before `snapshots.set` — so a rejected append can
no longer lose an event that a subscriber already saw. The cost is stated in the
ruling itself: because the snapshot is not advanced, the next tick re-derives the
same event and appends it again, and replay becomes at-least-once rather than
exactly-once. prd-40 declares issue #4 blocked until an ADR rules on that, and
its own Open Questions ask the question this record has to answer: *does a
duplicate on replay break any existing consumer* — answered with the corpus, not
by argument.

**The corpus answers no, it does not break a test; and yes, it corrupts meaning.**
Duplicating each of era-1's 100 committed lines in turn and re-folding through the
corpus law's own functions (`foldEraRecording` + `canonicalStateJson`,
`packages/core/src/eras/fold.ts`), with the untouched recording folding
byte-identically to `session-state.snapshot.json` as a control:

```
baseline === committed snapshot: true
mode=verbatim  anyChange=100/100 beyondEnvelope=79/100
  {"pane.activity":36,"llm.usage":17,"tool.activity":12,"commit.landed":8,
   "agent.status":3,"llm.cost":1,"agent.activeTime":2}
mode=rederived anyChange=100/100 beyondEnvelope=84/100
  (the same seven, plus branch.updated 3 and worktree.dirty 2)
```

Two readings of that, and only the second is load-bearing. The `100/100` is
near-tautological: `withEnvelope` (`packages/core/src/reduce.ts:157`) increments
`eventCount` unconditionally, so *any* parseable inserted line breaks byte
equality — a repeated line is not distinguishable from a novel one by that
measure. The `79/100` is the real number: seven of the fifteen event families
era-1 contains fold a repeated fact into corrupted state. Six of them accumulate
(`telemetry.usage`, `telemetry.costs`, `telemetry.tools`, `telemetry.activeTime`,
`commits.log`, `panes.*.activityCount`); one lies outright — a repeated
`agent.status` sets `previousStatus` to the agent's current status
(`reduce.ts:631`), turning "changed from working" into "changed from done".

In money, one duplicated `llm.usage` line on this corpus:

```
baseline spend {"costUsd":0.7042406999999999,"requestCount":17,"tokens":3191372}
dup      spend {"costUsd":0.7585226999999999,"requestCount":18,"tokens":3431071}
```

+7.7% on reported dollars, from one retry. The reducer's existing usage dedupe
cannot absorb it and says so in its own comment: `crossOriginMatch`
(`reduce.ts:834-846`) returns only a position whose `origin !== origin`, because
"folding same-origin records here would risk hiding that bug instead of
surfacing it." A re-derivation is by construction same-origin.

Eight families are idempotent — the keyed and last-write-wins ones.
`trace.span` dedupes on `(traceId, spanId)` (`reduce.ts:1396-1401`);
`commits.bySha` and `commits.order` dedupe on the sha while `commits.log`
does not. The split is mechanical, not accidental: an arm keyed on a domain
identity in the *payload* survives; an append-only ledger does not.

Three facts constrain every remedy.

**There is no dedupe key.** The envelope is exactly `{id, ts, source, type,
payload}` (`packages/core/src/events/common.ts:78-85`), and `id` comes from
`createIdFactory` (`packages/core/src/events/index.ts:378-384`), a per-process
counter stamped at emission. The two copies of one fact carry different ids. The
repo's one existing dedupe, `record/merge.ts:99-105`, keys on
`(actor.instance, event.id)` and would miss them. A content hash is lossy on real
data rather than merely expensive: era-1 already contains one pair of
`(type, payload)`-identical lines — two `llm.usage` with `requestId: null` — so a
payload-hash dedupe would silently drop a genuine event at 1 in 100 on the repo's
own corpus, reintroducing ADR-0011's abolished silent skip. Seven of the fifteen
families carry no natural key at all, and `requestId` is null on 4 of 17
`llm.usage` records and on the single `llm.cost`.

**The mechanism prd-40 names is not the mechanism that produces duplicates.** A
partial append cannot yield a repeated line: the writer only strips a trailing
partial when resuming (`session-log-writer.ts:157`,
`if (this.resuming) await dropTrailingPartialLine(...)`), so mid-session the
retry is `O_APPEND`ed onto the half-written bytes and glues into one malformed
line — both events lost, and counted as unreadable rather than duplicated. The
route that does produce duplicates needs no partial write. `poll-loop.ts:216-219`
advances one snapshot per *batch* and then appends the batch in a loop; a clean
rejection on event *k* leaves events 1..*k*-1 fully appended with the snapshot
un-advanced, so the next tick re-derives and re-appends all of them. Duplicates
are therefore routine on any append failure and arrive in runs, not singly.

**The window is one call site of twelve.** `grep -rn "recorder.record("
packages/server/src | grep -v test` returns 12 production sites; only
`poll-loop.ts:218` re-derives. The OTLP receiver's six sites
(`api/otel.ts:75,99,123,136,172,185`), the lab's two, `cli/run.ts:90`,
`rotate.ts:169` and the degrade path at `poll-loop.ts:162` hold no snapshot, so a
rejected append there still loses the event outright. `llm.cost` is `otel`-sourced
(`events/index.ts:76`) and is not reachable by re-derivation at all. So the
recording is at-least-once on the poll path and at-most-once everywhere else;
exactly-once was never true, and this ruling does not make it less true.

## Considered Options

- **A — Accept duplicates.** A recording may contain the same fact twice; the
  reducer's per-arm behaviour is what it is, and the cost is recorded.
- **B — Dedupe on read.** Reject duplicates at the parse boundary
  (`parseJsonl`, `parseEventLenient`) or in `reduce`, keyed on the event id, a
  content hash, or a per-type natural key.
- **C — Make the append idempotent.** The writer refuses to write a line it has
  already written — a last-line check, or a per-session digest set.
- **D — Drop and report.** On a rejected append, advance the snapshot anyway and
  report the loss, keeping exactly-once at the cost of the event.
- **E — Advance the snapshot partially.** Persist "the snapshot as of event *k*"
  so a mid-batch failure re-derives only the tail.
- **F — Retry the same event object in place** — same id, same `ts`, no
  re-derivation.
- **G — Add a per-session `seq` to the envelope**, making a repeat detectable
  without hashing anything.

## Decision Outcome

Chosen: **A**, scoped.

**A recording may contain the same fact twice, and a reader must not treat that
as corruption.** This amends ADR-0011: the promise is that a recording can be
read and folded by a later reader without rot — not that every line in it names a
distinct fact. Three limits go with it.

*First, the guarantee is per-path and must be stated that way.* The recording is
at-least-once on the poll path and at-most-once on the other eleven
`recorder.record` sites. Any later sentence of the form "every event on the
stream is on disk" also needs prd-40 success 1's named carve-out ("One named
exception, and no other", `docs/prds/prd-40-the-record-survives-the-write.md`): the
degrade `collector.error` reporting an append failure may be emitted without
having been appended.

*Second, duplicate tolerance is bought per reducer arm, keyed on payload
identity, and this ADR does not buy it.* `trace.span`'s `(traceId, spanId)` guard
and `commits.bySha`'s sha keying are the pattern; the seven non-idempotent arms
above are named here so the cost is visible and citable, not so that fixing them
is in scope. Whoever fixes one must key on something in the payload, because the
envelope has nothing that identifies a fact rather than an emission.

*Third, the golden-era corpus stays exactly as ADR-0011 built it.* It is a
committed fixture, so no CI job goes red on this decision — which is precisely
why the corpus is the right instrument and a poor alarm. It measured the damage;
it will not notice it in the wild.

**B lost on all three of its keys.** Keyed on `event.id` it catches nothing, since
the re-derived event's id is a fresh counter value. Keyed on a content hash it
would delete a real event 1-in-100 on the repo's own corpus, which is ADR-0011's
silent skip returning under a new name. Keyed per-type it covers eight of fifteen
families and none of the seven that break. Worse, wherever it lives it collides
with ADR-0002: under ruling 1 a live subscriber receives both copies (each append
resolved, so each publishes), while a parse-boundary dedupe runs only on replay —
live and replay would fold to different states, which is the one thing ADR-0002
exists to forbid, and whose last gap was closed only on 2026-08-24.

**C lost on cost and on layering.** The cheap form does not work: the duplicate is
not adjacent to its original, because the degrade `collector.error` for the failed
append is written between them (`poll-loop.ts:160-168`). The full form is a
per-session digest set, measured in isolation at 16.3 µs/event using core's own
portable SHA-256 against a post-#31 per-event write cost of 14.8 µs — roughly
doubling the write, immediately after prd-44 ruling 2 spent a wave buying 4.1×.
`node:crypto` is 1.7 µs but forks the hash story away from ADR-0009's
browser-safe chain, and reusing the export chain is not available either: it is
built at export time in a pure function over parsed events
(`record/build.ts:54-75`), and the writer holds no digest state at all.

**D lost because its cost is not a lost line, it is permanent blindness.** The
snapshot that advanced is the only thing that would have re-derived the event; a
dropped `worktree.discovered` never returns, and the instrument shows a worktree
that does not exist for the rest of the session. That is the exact failure prd-40
was written to close, reintroduced as a policy.

**E lost because it is not available inside ADR-0004's contract.** `PollResult` is
`{nextSnapshot, events}` — one snapshot per batch — and the loop stores it
opaquely as `unknown` (`poll-loop.ts:100`). Only a collector could construct "the
snapshot as of event *k*", so all six would have to change, and the contract with
them.

**F is the natural fourth option and prd-40 rejected it by name** — "it moves the
loss window rather than closing it and invents a second durability story beside
the recorder's" — with prd-44 rejecting the adjacent write-coalescing for the same
reason. **G is blocked by a non-goal in two live PRDs**: prd-40 and prd-44 both
forbid changing the record format, which `docs/record-format.md`, ADR-0009 and
ADR-0011 hold and prd-17 is still in flight over.

## Consequences

- **Good.** prd-40 ruling 1 stands unamended and #4 unblocks: a re-derived event
  appended twice is a permitted content of a recording, not a defect the lane has
  to prevent.
- **Good.** The failure direction inverts, and this is the whole point. Before,
  the record silently lost an event the operator had already seen. After, the
  record may carry one extra copy of an event that did happen. A record that says
  too much is recoverable; one that says too little is not.
- **Good.** The mechanism is now named correctly. prd-40's "if the first append
  partially succeeded" describes a case that produces a glued malformed line and
  loses both events; the real generator is batch granularity, and it is louder,
  commoner, and cleaner than the PRD implied.
- **Bad — reported spend can be wrong, upward, silently.** One duplicated
  `llm.usage` moves this corpus's `selectSessionSpend` from $0.7042407 to
  $0.7585227 and `requestCount` from 17 to 18, and the reducer's own dedupe is
  documented as deliberately declining to absorb it. Nothing in the instrument
  distinguishes a double-charged session from an expensive one.
- **Bad — one family corrupts rather than inflates.** A repeated `agent.status`
  rewrites `previousStatus` into the current status. No consumer reads that field
  today, which means the damage is currently invisible and will surface as a
  wrong answer the first time one does.
- **Bad — nothing detects a duplicate anywhere.** An exported record carrying one
  verifies clean: the hash chain is computed over the body as given, so the second
  copy chains over a different predecessor and closes correctly, and `verifyRecord`
  returns a bare `{ok:true}` with no `unknown` field. `readRecord`, `parseJsonl`
  and `readSessionLog` all count both copies as good lines, so neither
  `unknownVoice` nor `unreadableLinesVoice` fires. ADR-0011 made an unrecognised
  event a voiced fact; a repeated one is not.
- **Bad — two legitimate readers of one record can disagree.** `mergeRecords`
  dedupes on `(actor.instance, event.id)`, so it would drop an id-identical
  duplicate while a direct read keeps it. It has no production caller today
  (federation is unbuilt), so this is latent rather than live — but it is the one
  place in the tree that already assumes `event.id` names a fact rather than an
  emission, and this decision falsifies that assumption.
- **Bad — a duplicate outlives the process that made it.** `SessionRecorder`
  rebuilds its buffer from disk via `resumeFrom` (`cli/run.ts:80`,
  `cli/replay.ts:156`), so a duplicated line on disk becomes a duplicated event in
  the live buffer on the next resumed run, and from then on every live consumer
  double-counts too.
- **Neutral.** No test changes colour. The corpus is a committed fixture and this
  decision does not touch it; the seven non-idempotent arms have no duplicate law
  today and gain none here. Whichever way a later ruling goes, it starts from zero
  coverage.
- **Neutral.** prd-44's #46 (a wedged file descriptor after a failed write) is not
  vetoed by this, but its severity assessment changes: it is filed as "mostly
  self-healing… it clears when a `sync()` finally completes", and under ruling 1 a
  persistently unwritable log re-derives and re-fails every tick, so no `sync()`
  ever completes. The leak stays capped at one descriptor per session; "self-
  healing" stops being true.

## Open questions this record does not close

- **Thirteen of the twenty-eight declared families are absent from era-1**, and
  `eras.test.ts:97-111` states the gap by name: `agent.removed`, the four
  `collector.*`, `fork.checkpoint`, `fork.dispatched`, `judge.finding`,
  `session.started`, `session.closed`, `telemetry.refused`,
  `worktree.dirtyStatusFailed`, `worktree.dirtyStatusRecovered`. Two of them bear
  directly on this ruling — `collector.error` is the degrade path a rejected
  append routes through, and a retry storm would duplicate it — and the corpus
  cannot say what they fold to. Rare families in the corpus are single-sample:
  `trace.span` "survives" on one span.
- **How often an append actually fails is unmeasured.** Nothing in the repo
  records write-failure rate, so "duplicates are rare" cannot be weighed against
  "a lost worktree is permanent" with evidence. This decision was made on the cost
  of each outcome, not on their frequencies.
- **A duplicated `session.started` is unmodelled.** It satisfies `opensNewSession`
  and resets to `initialSessionState`, so the `eventCount` floor above does not
  hold for it. era-1 contains none, and this was reasoned from `reduce.ts:141-143`
  rather than run.
- **Whether the OTLP receiver already delivers duplicate `llm.cost` today** for
  reasons unrelated to this ruling (upstream OTLP retry) was not investigated. If
  it does, that path is already at-least-once and this record understates the
  status quo.

## On acceptance

Accepted 2026-08-25 by Ciaran Slow, in session. Two edits followed acceptance,
recorded here so the shape of the amendment stays readable from this record:

`docs/adr/0011-recordings-never-rot.md`'s Status line gains a link, matching the
convention ADR-0014 carries for its own amendment (ADR-0001 uses the `×N` form
when a record has been amended more than once):

```
- **Status:** accepted — amended by [ADR-0029](0029-a-recording-may-repeat-a-fact.md) (a recording may repeat a fact; no read-side dedupe)
```

`docs/adr/README.md`'s index table gains a row after 0028:

| # | Decision | Decided | Status |
|---|---|---|---|
| [0029](0029-a-recording-may-repeat-a-fact.md) | A recording may repeat a fact: at-least-once on the poll path, no read-side dedupe — amends [0011](0011-recordings-never-rot.md) | 2026-08-25 | accepted |
