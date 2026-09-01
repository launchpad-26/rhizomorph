# prd-44 — the flat instrument: what it costs to watch tracks the swarm, not the session's age

> **Status:** **SHIPPED** — 2026-08-27. Milestone `prd44` closed with every issue done; the
> closeout, including what the plan got wrong, is the last section of this document.
> Blessed by Ciaran Slow, 2026-08-24, in session. Drafted the
> same day from `docs/review/2026-08-24-performance.md` (a measured pass over `60c2cae`); every
> cited line re-verified against `main` at `9a26030`, where prd-29 ruling 7 had just moved
> `/api/lane-index` into `gated-read` — which is why ruling 1 lives in `log/`. Consumes prd-40's ordering; refuses prd-33's model stage and
> prd-40's fold. Finding 3 of that review is prd-40's and appears here only as a fence.

## Problem

The instrument gets slower the longer it is used and the bigger the swarm gets, and neither should
cost anything. Five distinct paths each re-pay for something already known: a page load re-reads
every recording ever made, an event re-opens the log it just wrote, a poll waits in series for
commands that do not depend on each other, a day-long session's memory only grows, and a finished
lane's picture is rebuilt sixty times a second after it can no longer change.

The cost is not that any one is large. It is that four of the five scale with a quantity the
operator cannot reduce without deleting their own history — recordings kept, events recorded, hours
connected, lanes finished — so the instrument degrades as a function of being used. One of them
stops the whole process while it runs, which is what makes this urgent rather than untidy.

## Evidence

- **`/api/lane-index` re-reads and re-parses every recording on disk, per request.**
  `log/lane-index.ts:476-490` lists the session dir then awaits `readSessionLog`,
  `readSessionLabel` and `readTranscriptCaptureManifest` per session in one sequential loop, with
  no cache; `api/lane-index.ts:59` calls it fresh on both routes. Measured on this repo's own
  session dir (4 files, 20 MB, 51,690 lines), page cache warm: **281.3 / 280.0 / 252.2 ms**.
- **That request starves the event loop.** A 20 ms heartbeat measured beside it ran **1.3 ms late
  normally and 92.5 ms late during**, firing 3 of ~14 expected ticks. While it runs, `/api/stream`
  does not write and the poll loop does not tick.
- **Nothing prunes the session directory.** 37 files and 39 MB across repo slugs on one box already.
  The re-read above is a function of that pile, so it grows for as long as the tool is used.
- **The log file is opened, written and closed once per event.**
  `recorder/session-log-writer.ts:82` calls `appendFile` inside the serialised `tail` chain
  (`:86`). Measured at 5,000 events × 278 B: **306.9 ms (61.4 µs/event)**, against **74.1 ms
  (4.1×)** for one held handle and 2.6 ms (119×) for a coalesced one.
- **Independent subprocesses are awaited in series inside collectors.**
  `collectors/workmux/collector.ts:357` then `:515` run `status --json` and `list --json`
  sequentially though neither reads the other. `collectors/git/git-collector.ts:246` awaits
  `computeAheadBehind` per branch and `:357` a `git status --porcelain` per worktree;
  `collectors/tmux/collector.ts:156-163` awaits `resolveWorktreePath` and a `capture-pane` per pane.
- **On the measured box the tick is one slow collector, not the six in series.** Real collectors,
  real `exec`: tick **289.8–343.4 ms**, of which workmux **223.3–256.5 ms** on two commands.
  Polling the six concurrently read 1.3× / 0.6× / 1.4× — no reliable win. The per-entity loops are
  what scale: 20 sequential spawns measured **282.4 ms against 94.7 ms concurrent (3.0×)**.
- **The server's event buffer is unbounded; the client's is capped.**
  `recorder/session-recorder.ts:36` is emptied only by `openSession` (`:125`), and `:139` copies it
  whole for each of sixteen callers. `web/src/app/streamState.ts:60` caps the same data at
  `MAX_EVENTS = 75_000` with `eventsWindowLabel` to say so. One side ruled; the other has not.
- **Sessions reach the sizes that makes this matter.**
  `research/2026-08-16-concurrency-measurement.md` counted this project's own recordings:
  **63,653 events over 43.5 h**, several above 27,000.
- **A settled lane's vertices are rebuilt every frame.** `scene/gl/frame.ts:141` calls
  `vertices.reset()` and re-tessellates every mark per frame, though
  `docs/design-notes/geometry-cache-audit-178.md` established the spine itself is pure past
  `dissolve >= 1` — which is why `livingSpineCache` (`scene/geometry/layout.ts:200`) is lawful.
  Measured: 30 live + 200 retired = **18.46 ms median, of which `buildFrame` is 14.91 ms**, against
  a 16.67 ms budget. Hiding them instead reads 11.3 ms.

## Success

1. Fold, read and parse work per request is constant in the session directory's size. **Not met
   while** any route's cost is a function of how many recordings have accumulated, or while a law
   asserts this with a wall clock instead of a count.
2. One `write` per event, one `open` per session. **Not met while** the per-event path opens or
   closes a descriptor, or while ordering or `sync()` semantics differ from today's by any observable.
3. Independent subprocesses within a collector start together, and the log is byte-identical to the
   serial ordering. **Not met while** a replay of the same inputs produces a different line order,
   or while the concurrent path can start more processes at once than a declared cap.
4. The server's retention is a stated number with a name, like the client's. **Not met while**
   `eventsSoFar()`'s growth is bounded only by session length, or while a bound exists but no
   surface says a window is partial.
5. A settled retired lane contributes no per-frame tessellation. **Not met while** its vertices are
   rebuilt on a frame where none of its inputs changed, or while the cached path returns arrays that
   are not byte-equal to a fresh build.
6. Every claim above is a counting law that fails when broken. **Not met while** any of the five is
   defended by a reported measurement rather than an assertion — the defect prd-24 named before it
   retired as superseded (2026-08-24).

## Non-goals

- **Not the fold per request.** prd-40 rulings 1–2 and issues #3/#5 own `reduceAll(eventsSoFar())`
  and `/api/meta`. No wave here folds, caches or re-reads that path.
- **Not prd-33's model stage.** Ruling 13 states 180 threads at 30 fps and says outright that it is
  "not a bug to be closed by relaxing this table". This PRD touches the *tessellation* stage and
  the *retired* axis, which that table does not cover, and moves no cell in it.
- **Not the light-theme status palette.** `--color-broken` vs `--color-working` measure ΔE 1.4 under
  deuteranopia and 1.25:1 in greyscale (`theme.css:455-461`), while `category.test.ts:207`'s cap 5
  holds the *category* family to greyscale survival and reaches the status family only as
  `STATUS_HUES`, the reference it measures against (`:154`). Real, and not a cost that scales — it
  is a theme law, filed outside this PRD as `theme: <what becomes true>`.
- **No change to the record format.** `docs/record-format.md`'s manifest, hash chain and line
  grammar are held by **ADR-0009** and **ADR-0011** (both accepted — and an ADR outlives the PRD
  that prompted it) and by **prd-17**, still in flight. prd-11 shipped, so it is history here, not
  an owner. Ruling 2 changes how bytes reach the file, never which bytes.
- **No route reclassification.** Route classes are prd-29's, and **prd-29 ruling 7 has already
  moved `GET /api/lane-index` and `/api/lane-index/:handle` into `gated-read`** (landed on main in
  `5f45252`). This PRD does not touch that gating, is not blocked by it, and must not undo it —
  which is precisely why ruling 1 lives in `log/`, not in the route file. See Sequencing.

**Rejected alternatives.** *A TTL cache on `/api/lane-index`* — it turns a cost problem into a
staleness problem on a route whose answer is a list of facts, and prd-40 already rejected the same
shape for the same reason. *Coalescing log writes into one syscall per microtask* — 119× and
tempting, but it lets `record()` resolve while the event is only in memory, which is precisely the
loss window prd-40 ruling 1 and issues #26/#4 exist to close; the 4.1× that changes nothing
observable is taken instead. *Polling the six collectors concurrently* — measured at 1.3× / 0.6× /
1.4×, because one collector is three quarters of the tick; it adds ordering risk for no reliable
gain, and the per-entity loops it distracts from are where the growth is. *Deleting old recordings
automatically* — retention is the operator's call, booked as wave 0, never a default this PRD picks.
*Lowering the scene's default quality* — `hideFinished` already exists as the operator's escape
hatch; the picture should cost less, not say less.

## What already exists (do not rebuild)

- `livingSpineCache` (`scene/geometry/layout.ts:200`) and
  `docs/design-notes/geometry-cache-audit-178.md` — the cache-key discipline and the purity argument
  ruling 5 extends one stage later. Its `world`-signature reasoning is reused, not re-derived.
- The spend cursor (`core/src/selectors/spend-cursor.ts`) — this repo's worked example of a
  maintained incremental structure with a prime-once cost, cited by prd-40 for the same reason.
- `withTimeout` (`server/exec.ts`) — already the one exec ceiling, wired at `poll-loop.ts:91`.
  Ruling 3's cap composes with it; it does not grow a second timeout story.
- `Batch` and `buildFrame`'s `into` parameter (`scene/gl/frame.ts:139`) — the reusable vertex buffer
  ruling 5 needs already exists as an argument; only `reset()`'s all-or-nothing scope is wrong.
- `eventsWindowLabel` (`web/src/app/streamState.ts`) — the existing vocabulary for "this window is
  partial", which ruling 4 reuses rather than inventing a server-side twin.

## Rulings

## Ruling 1 — a finished recording is parsed once, not once per request

A session file that is not the live one is immutable: it is closed and never appended to, and
`lane-index.ts:481-484` already reads the live session from the recorder instead of from disk. So a
per-session cache keyed on the file's identity plus `mtime` and `size` is sound, and steady-state
work falls to the one recording still moving.

This is a cache of *parsing*, not of answers — the route still recomputes its response from the
parsed sessions every time, so nothing it reports can go stale. That is the difference between this
and the TTL the Non-goals reject. The three per-session reads become concurrent in the same change,
because they are three different files.

**How far it extends:** to every reader of the session directory, not just this route.
`log/listing.ts` names the same rule in its own comment. A second caller that walks the directory
per request is the same defect with a different route name.

**Amendment (2026-08-24, grooming) — the cache is cross-session, and pruning must invalidate it.**
The reasoning above stands; what it left unsaid is *why* the route reads everything, and a lane
that does not know can "optimise" by narrowing what the index covers. **prd-31 ruling 5** (shipped)
built this surface and made the index part of that ruling rather than an optimisation of it: a
worktree is deleted by `workmux merge` the moment work lands, which is exactly when someone wants
to read what happened, and a lane that ran across three sessions has its life scattered across
three recordings. Reading across all of them is therefore the feature. This ruling removes only the
*repetition* — a finished recording is immutable, so parsing it twice is waste while parsing it
once is ruling 5 working as designed.

Two constraints follow, and the second is a cross-wave hazard this PRD did not previously name:

- **The cache spans sessions.** One scoped per request, or remembering only the live session,
  defeats ruling 5 while passing every count law this PRD asks for.
- **Wave 3 deletes what this cache holds.** Retention enforcement must invalidate it rather than
  leave it serving a recording that is gone, and a pruned lane must read as *pruned* — degrading
  the way the index already degrades for an unreadable recording — never as a lane that never
  existed. "No such lane" for work that did happen is the dishonest failure, the same shape
  ADR-0011 abolished for the silent skip.

## Ruling 2 — the log is opened once per session, not once per event

The per-event `appendFile` becomes one held descriptor for the writer's life. Ordering stays the
`tail` chain's, `sync()` keeps awaiting it, and the bytes are unchanged — one `write` per event
either way. It is 4.1× for no semantic movement.

**What it must not break, and who owns it.** The live constraint is **prd17 ruling 1**, which makes
`session.closed` an event family — "a session's end is an event, not an absence" — and prd-17 is
still in flight (partially shipped). The phrase "a final `session.closed`" is the *code's* gloss on
that ruling, not the ruling's own title, and it appears in both files this ruling's neighbourhood
touches: `session-log-writer.ts:61` and `session-recorder.ts:90`, each naming the serialised `tail`
chain as what makes the ordering structural. That chain is untouched here. Three existing laws pin the rest and
are the acceptance criteria: appends land in issue order even when nobody awaits them
(`session-log-writer.test.ts:46`), `sync()` leaves every issued append on disk (`:68`), and a write
failure still reaches the caller that issued it (`:89`).

**Why it is wave 2 and not later:** prd-40 ruling 1 puts the append on the critical path — "the
append is awaited before the event is anyone's". Today the write races behind publication; after
prd-40 every event waits on its own write. The 61 µs of open/close per event therefore stops being
background cost and becomes operator-visible latency. **This ruling must land before or with prd-40
wave 1**, or prd-40 ships a regression this would have prevented. Different files
(`session-log-writer.ts` vs `session-recorder.ts`), so it is a sequencing constraint, not a fence.

## Ruling 3 — independent subprocesses start together, and the log's order is not theirs to decide

Within one collector, subprocess calls that read none of each other's output are issued together:
workmux's two commands, and the per-worktree, per-branch and per-pane loops.

Two bounds, both structural. **A declared concurrency cap**, because six collectors each fanning out
per entity can otherwise start forty-plus processes at once, and the reference box is an 8 GB
machine that already thrashes at four lanes. **Recording in the original order**, because the record
is hash-chained (ADR-0009) — results are gathered concurrently and appended in the collector's own
sequence, so a replay of the same inputs is byte-identical. That property is what makes this
provable rather than hopeful, and it is the acceptance criterion, not a hope about scheduling.

**What this ruling does not claim:** that polling the six collectors concurrently is worth doing. It
was measured and it is not (Evidence). The win is inside a collector, where the loops scale with the
swarm.

## Ruling 4 — the server states its retention, as the client already does

`eventsSoFar()`'s growth becomes a declared number with a name, and any surface reading a bounded
window says so — reusing `eventsWindowLabel`'s existing vocabulary rather than inventing a second.

**Why this is a ruling and not a patch:** two consumers assume the whole session is in memory —
`/api/stream`'s replay promise to a new subscriber, and the exporter. Bounding the buffer means
changing one of those promises, so the bound is chosen with them named, not discovered by a lane.
prd-40's open question — whether `foldSoFar()` becomes the only reader with `eventsSoFar()` narrowed
to the exporter — is the prerequisite, and this ruling consumes its answer rather than pre-empting
it.

## Ruling 5 — a picture that cannot change is not rebuilt

Past `dissolve >= 1` a retired lane's spine is a pure function of the world frame — the finding
`geometry-cache-audit-178.md` already proved and `livingSpineCache` already relies on. Its vertices
are therefore equally pure, and are cached on the same argument one stage later: a persistent range
in the existing `Batch`, invalidated by the same world signature.

**Scope, stated so it cannot drift into prd-33's:** this is the tessellation stage
(`buildFrame`), on the retired axis. prd-33 ruling 13's table is the model stage on the live axis,
and the candidate it names next — memoising a growing thread's spine — moves a different number.
The two are additive and neither relaxes the other's cell.

## Sequencing (waves, each gated as ever)

`recorder/session-recorder.ts` and `server/poll-loop.ts`'s snapshot/append ordering are **prd-40's
territory**; no wave here enters them until prd-40 has. Rotation (`recorder/rotate.ts`) is prd-16's,
and prd-16 is **shipped** — so there is no lane to coordinate with, only shipped code and the laws
around it: the recorder namespace law (`recorder/namespace-law.test.ts:173`) requires every
filesystem write in the module to live in the log writer, and `:228-241` keeps rotation reachable
only from its one declared caller. Ruling 2 stays inside the writer for exactly that reason. `core/src/reduce.ts` and `/api/meta` are
prd-40's outright — consumed, never edited. `scene/marks/` and the model stage are **prd-33's**; no
wave here touches ruling 13's table. Route classes are **prd-29's**, and its ruling 7 (landed `5f45252`) is about to add a capability
gate to `api/lane-index.ts` itself. **No wave here opens that file** — ruling 1's cache lives in
`log/`, so the two never contend for it.
`docs/record-format.md` is **ADR-0009**'s and **ADR-0011**'s structurally, and prd-17's while that
PRD is in flight; prd-11 shipped.

**Wave 0 — operator acts, booked not skipped. Not dispatchable.** The session directory's retention
answer (how long recordings are kept, and by what act they go), and the number ruling 4 declares.
Both destroy or withhold operator data; neither is an agent's call.

**Wave 1 — Keystone: the costs are counted, and the counts are asserted.** A shared counting harness
plus one law per ruling: parses per lane-index request, `open` calls per event, spawns per tick, the
buffer's ceiling, tessellations per frame for a settled lane. **Counts, never wall-clock** — a timing
assertion measures the box, which is why this repo reports times and asserts counts, and it is the
defect prd-24 named to do otherwise. Additive, claims no production file, and every later wave proves
itself against it.

**Wave 2 — Parallel, fenced apart:** the lane-index parse cache and its concurrent per-session reads
(`log/lane-index.ts`, `log/listing.ts`) · the writer's held descriptor
(`recorder/session-log-writer.ts`) · the retired-lane vertex cache (`scene/gl/frame.ts`,
`scene/gl/batch.ts`). Three disjoint fences, three different packages, no shared file. The writer
lane carries ruling 2's cross-PRD constraint: **it lands before or with prd-40 wave 1.**

**Wave 3 — Parallel, fenced apart, each gated on prd-40:** within-collector concurrency and its cap
(`collectors/workmux/`, `collectors/git/`, `collectors/tmux/`), gated on prd-40 wave 2 landing its
`poll-loop.ts` ordering first · the declared buffer bound (`recorder/session-recorder.ts`), gated on
prd-40 wave 1 and its open question's answer.

**Wave 4 — the sweep, last:** retention enforcement for the session directory, implementing wave 0's
answer. It runs last because it deletes what waves 1–3 are measured against, and a sweep that runs
earlier re-lays the ground they dig.

Checked against **ADR-0011** ("recordings never rot") before being written down, because the names
collide and the conflict would be fatal. That ADR is about *parsing* an old recording — lenient
parse, a reserved `upcast()`, the golden-era corpus — not about how long one is kept. And the
corpus it pins the reducer with is committed in the repo (`core/src/eras/era-1/recording.jsonl`)
with hermetic tests that never read the real data root, so no retention policy can reach it.
**No conflict.** Deleting a recording stays an operator act (wave 0), never a default.

**Unfiled work implied, described not numbered:** the transcript route's full-array scan for a lane
the log never named (`api/transcript.ts` via `findAttribution`) — O(N) per 2 s poll, single-digit ms
at 55k events, real and not worth a wave yet. The 15 remaining `eventsSoFar()` callers audited in
the review's §3, all one-shot. `runServerDoctor`'s serial checks (`api/doctor.ts:95-105`), bounded
already by a 15 s TTL and single-flight.

## Open questions

- **What is the lane-index cache's eviction story?** *Where* it lives is no longer open: prd-29
  ruling 7 is adding a capability gate to `api/lane-index.ts`, so the cache goes in `log/` or the
  two lanes collide on one file — and ruling 1's "a second directory walker is the same defect"
  argued for `log/` anyway. What remains open is that a cache in `log/` outlives any one request,
  so it needs a bound and an eviction rule this PRD has not written. Open, not ruled.
- **Where does the old descriptor's close go?** `openSession` (`session-recorder.ts:121`) is
  **synchronous** and replaces the writer wholesale, which is free today only because the writer
  holds nothing. A held descriptor must be closed, and closing is awaited. The namespace law points
  at the answer rather than leaving it open: filesystem writes must live in the writer
  (`namespace-law.test.ts:173`), and `closeWith` is already async and already awaits `sync()` — so
  the ending session closing its own descriptor needs no change to `openSession`, no change to
  `rotate.ts`, and no fence widening. What is *not* settled is whether `sync()`'s separate
  `open(filePath, 'r+')` should then reuse the held handle. Open, not ruled — but narrow.
- **Does the concurrency cap belong per collector or per process?** Per collector is simpler to fence
  and reason about; per process is what actually protects an 8 GB box, and it needs an owner outside
  any one collector. Open, not ruled.
- **Can a retired lane's vertex range survive a camera or resize change without a full rebuild?**
  The world signature catches resize, but a persistent range's *offsets* may not. Open, not ruled.

## Amendment — the waves collapse from five to three (grooming, landed 2026-08-24)

Groomed the same day it was blessed, and the grooming found the Sequencing above paying the
per-PR toll twice for no dependency. Recorded here rather than left to diverge on the tracker.

**The shared counting harness is withdrawn.** Wave 1 asked for one, and the five count laws it
would serve spy on five unrelated things — filesystem reads, `open` calls, subprocess spawns, a
buffer's length, vertex writes — across three packages with separate vitest configs. The shared
part is a `vi.spyOn` wrapper with one caller per site. **The rule survives, the module does not:**
every issue asserts a count and never a wall clock, stated in its own Definition of done. Nothing
about success 6 changes; only the vehicle does.

**With the harness gone, wave 2 depended on nothing in wave 1.** The only real keystone left was
the bounded-concurrency helper, and it is consumed by wave 3 alone — additive, claimed by nobody,
and therefore safe to ride inside another wave's PR. So the old waves 1 and 2 are one wave, and the
numbering closes up:

| now | was | contents |
|---|---|---|
| **wave 1** | 1 + 2 | the lane-index parse cache · the writer's held descriptor · the retired-lane vertex cache · the bounded fan-out helper |
| **wave 2** | 3 | workmux · git · tmux · the declared buffer ceiling |
| **wave 3** | 4 | retention enforcement |

Four fences in the new wave 1, pairwise disjoint, no intra-wave dependency: `log/`,
`recorder/session-log-writer.ts`, `scene/gl/`, and one new file. **Three PR tolls instead of four**
— against a measured 20.9 h median toll, the reason this amendment exists at all.

**Open question 2 is answered by the same pass.** The old descriptor's close cannot go in
`closeWith`: `recorder/session-recorder.ts` is prd-40 issue #3's live fence, and reaching into it
would have broken ruling 2's own "before or with prd-40 wave 1" timing. The writer **releases its
handle on `sync()`** instead — which `closeWith` already calls, and which already opens a
descriptor of its own today — so the change stays inside `session-log-writer.ts` entirely. The
interleaving that follows (an append after a `sync()` must reopen) is the lane's to prove, not an
assumption this amendment makes.

**One constraint the grooming surfaced, recorded because a lane cannot see it coming.** No law
added by any wave may be named `*.bench.test.ts` or carry a `// @gate-timing` marker.
`scripts/gate.sh:100` derives its timing set from exactly those two, runs it under 4× load, and
ratchets the count in `.swarm/timing-count`. A count law is deterministic and belongs in the
normal suite; put it in the timing set and it slows the operator's landing tool and moves a ratchet
only a human can clear.

---

# Outcome — shipped 2026-08-27

Twelve issues, three days from blessing to close. Every ruling landed, and both wave-0 answers
came from the operator rather than from a lane.

It took **nine pull requests to do it**: five to `main` (#50, #128, #129, #131, #134) and four to
an integration branch that never had one of its own (#96, #97, #101, #102). That second number is
the interesting one, and it is the last thing in this section.

What follows is the closeout — what shipped against each ruling, how the six success criteria
actually read now, what the four open questions turned out to be, and, because it is the most
useful part, what the plan got wrong.

Written at `8315237`, the merge that closed the milestone. Ruling numbers above are untouched;
this is appended, as the standard requires.

## The five rulings, as they landed

| ruling | issues | landed | deviation from the mechanism this PRD imagined |
|---|---|---|---|
| 1 — a finished recording is parsed once | #30, #104 | PR #50, PR #129 | none in shape. The bound and eviction rule the PRD left open became **ADR-0028** (128 MB of raw file bytes, LRU, single-flighted). #104 extended it to the third reader — `readSessionEvents` — which is the "how far it extends" clause doing its job rather than a new decision. |
| 2 — the log is opened once per session | #31, #46, #55 | PR #50 (#31, and #55 superseded inside it by `ddf7e41`), PR #96 → PR #128 (#46) | none. Two failure paths the ruling did not name needed their own issues: a failed append must release the descriptor (#46) and a clean stop must too (#55). |
| 3 — independent subprocesses start together | #33, #34, #35, #36 | PR #50, PR #128 | none. The cap became `COLLECTOR_FANOUT_LIMIT = 4` in one new module, consumed by three collectors, with results gathered concurrently and appended in the collector's own order. |
| 4 — the server states its retention | #37 | PR #131 | **yes.** The ruling said the bound would be stated and any surface reading a bounded window would say so. It is, and the fold's `eventCount` carries the honesty — but eviction advances an index rather than trimming an array, because a `splice(0, n)` per event past the bound would have reintroduced ruling 2's own per-event cost one file away. |
| 5 — a picture that cannot change is not rebuilt | #32 | PR #102 → PR #128 | **yes, and it is the most instructive one.** "A persistent range in the existing `Batch`, invalidated by the same world signature" was tried and **rejected on its own measurement**: caching every world mark made a living lane's slot a guaranteed miss and the digest walk pure overhead, regressing the realistic frame even though the retired-only slice sped up 6x. What shipped is a per-mark content-digest cache gated to `role: 'persist' \| 'persist-mark'` — the marks `scene/marks/` already treats as settled. The ruling's *claim* held; its proposed mechanism did not. |

## The six success criteria, assessed

Each one names the law that proves it, because criterion 6 forbids proving any of them with a
measurement. Where a criterion is met only within this PRD's declared scope, it says so.

1. **Parse and read work per request is constant in the session directory's size — met as
   scoped.** `parsedSessionLogCache` parses each finished recording once per process, and three
   readers share the one instance (`lane-index.ts`, `listing.ts`, `session-log.ts`). Pinned by
   counting laws in all three test files, e.g. *"parses each closed recording once, however many
   times the index is read"*. **The per-request fold over already-parsed events is not constant
   and was never claimed** — the Non-goals give `reduceAll(eventsSoFar())` and `/api/meta` to
   prd-40, and #104 explicitly left `api/lab.ts`'s per-request `reduceAll` out of scope. That
   half is still open, and it is prd-40's, not a residual here.
2. **One `write` per event, one `open` per session — met.** The writer holds one descriptor for
   its life; `sync()` reuses that handle and releases it, so there is no second `open` anywhere on
   the path. Ordering and `sync()` semantics are unchanged, pinned by the three pre-existing laws
   the ruling named as its acceptance criteria plus #46's and #55's release laws.
3. **Independent subprocesses start together, and the log is byte-identical to the serial
   ordering — met.** Each collector fans out and then walks its own original array by index to
   emit, so a replay of the same inputs is byte-identical; the cap is asserted as a max-in-flight
   **count**. Three collectors, three laws.
4. **The server's retention is a stated number with a name — met.** `MAX_BUFFERED_EVENTS = 75_000`,
   evicted oldest-first, with the fold left complete so
   `eventsSoFar().length < foldSoFar().eventCount` is how a reader detects a partial window — the
   same pair `eventsWindowLabel` already reads. Eight laws, all counts.
   **One honesty cost, named on the issue and in PR #131 rather than discovered later:** the web
   client derives its total from the events it *receives*, so after a truncated replay it can no
   longer tell its window is partial. Filed as **#132**.
5. **A settled retired lane contributes no per-frame tessellation — met.** Gated to settled marks
   only, keyed on a content digest, with a law asserting tessellations per frame rather than a
   frame time.
6. **Every claim above is a counting law — met, and it held under pressure.** No law added by any
   wave asserts a wall clock, and none is named `*.bench.test.ts` or carries `@gate-timing`, so
   `.swarm/timing-count` never moved. Two places where holding this line cost real work are worth
   recording: #37's laws run at the **real** 75,000 rather than an injected toy bound (a
   configurable ceiling tested at 4 would never exercise the default it protects), and #38's
   golden-era-corpus law survived eight mutations before a ninth was written that could kill it —
   a law that cannot fail for the reason it claims is not a law.

## Wave 0's two answers

Booked, not skipped, and both the operator's (Ciaran Slow, 2026-08-27, in session). Recorded here
because a wave-0 answer that lives only on an issue is lost when the issue closes.

- **The buffer's ceiling is 75,000** — deliberately *the client's* number (`MAX_EVENTS`,
  `web/src/app/streamState.ts`), so `eventsWindowLabel`'s vocabulary means one thing on both sides
  of the wire. 25,000 was rejected for truncating sessions that exist here; 150,000 for being a
  bound that never fires.
- **Retention has no default age.** The operator names the age at the moment they ask, every time;
  a caller who supplies none gets a refusal, not a policy. A 30-day default was offered and
  rejected — a default age is a policy that reaps a lane nobody thought about. Newest-N-per-slug
  was rejected for the same shape plus a worse failure: a quiet week's recording evicted by a busy
  day's.

## The four open questions, answered

1. **The lane-index cache's eviction story** — answered by #30 and written down as **ADR-0028**:
   bounded by the raw file bytes it holds rather than by an entry count, 128 MB, plain LRU, with a
   single entry larger than the whole budget still cached alone. Single-flighted, so two callers
   racing a cold file cost one parse.
2. **Where the old descriptor's close goes** — answered, and more cleanly than the grooming
   amendment expected. `sync()` releases the handle, so `openSession` and `rotate.ts` needed no
   change. The narrow sub-question — whether `sync()`'s separate `open(filePath, 'r+')` should
   reuse the held handle — is answered **yes**: there is no second `open` left on the path at all.
3. **Whether the concurrency cap belongs per collector or per process** — **partly answered, and
   the rest survives this PRD.** What shipped is a per-call cap, and `concurrency.ts` records why
   that is also the per-process ceiling *today*: `runTick` awaits the six collectors in turn, so at
   most one fan-out is ever live. If the poll loop ever fans out across collectors, that stops
   being true and the question has to be answered before it does. Still open, now with the
   condition that would force it.
4. **Whether a retired lane's vertex range survives a camera or resize change** — answered by #32,
   and the answer removed the question rather than solving it. No panel or camera term is needed in
   the key, because `ribbon()` never reads `panel.width`, `panel.height` or `panel.camera`; a
   resize is caught one stage up, where `layoutScene`'s `world`-keyed cache hands out a new `path`
   the instant the world moves, producing a new outline and therefore a new digest. The
   `geometry-cache-audit-178.md` argument is reused rather than re-derived.

## What the plan got wrong

- **The grooming amendment's three waves were right about the toll and wrong about the count.** It
  collapsed five waves into three to pay the ~21 h per-PR toll three times instead of four.
  Nine PRs were opened. Five reached `main`; four reached an integration branch and had to be
  relanded, so their toll was paid twice. The amendment's reasoning was sound and nothing enforced
  it at dispatch — each issue was built as its own lane and merged on its own, which is the
  one-issue-one-PR habit the working agreement exists to break.
- **A ruling's stated mechanism is not a ruling.** Ruling 5's persistent-`Batch`-range and
  ruling 4's array-trimming both lost to measurement, and in both cases the ruling's *claim*
  survived intact. The PRD would have been better with the mechanism sentences marked as
  candidates rather than written in the ruling's own voice.
- **#104 arrived with no wave.** Ruling 1's "how far it extends" clause named the defect shape
  exactly — *"a second caller that walks the directory per request is the same defect with a
  different route name"* — and a third reader was still found later, by a review of a different
  PR. An extension clause that names a shape should have come with a search for every instance of
  it at grooming time, not a promise to recognise one later.
- **The work was finished days before it landed, and the tracker could not see the difference.**
  Waves 1 and 2 were built, reviewed and merged — into an integration branch named `prd44` that
  never had a PR to `main`. Five commits sat there while `main` moved 40 commits past them, and
  four issues were closed with comments that said, truthfully, *"merged into prd44"*. Nothing was
  mis-recorded and nothing was lost; the milestone simply read as done while none of it was on
  `main`. It was recovered on 2026-08-27 by cherry-picking all five onto current `main` as PR #128.
  The general lesson belongs in `AGENTS.md`, not here: **a green gate on a branch whose base is
  not `main` has landed nothing.**

## Residuals, with owners

Nothing here blocks the milestone's close; all four are filed.

- **#132** (High) — the client can tell a live window is partial. The honesty cost of ruling 4,
  named in PR #131 before it was merged.
- **#133** (High) — a rotation captures every lane the session named. `rotate.ts` hands the
  transcript capture a window, so an evicted lane vanishes from the manifest.
- **#130** (Low) — `server/concurrency.ts`'s doc comment names the indexed-access friction and the
  three different idioms ruling 3's three consumers each invented for it. Three retros asked for
  this in comments; the fourth ask is a tracked issue.
- **`snapshots/<id>/` is not pruned** by #38's policy — collector byte offsets for a session
  nobody will resume. A real if small disk cost, deliberately not folded into retention's meaning.
