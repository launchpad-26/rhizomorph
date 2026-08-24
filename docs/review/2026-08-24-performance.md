# Performance and reliability review — `60c2cae`

A dated artefact. Every figure below was **executed** on one box (macOS, Node 24, this
repo's own worktree and its own session directory) unless labelled `REASONED`, in which
case it is argued from the code with nothing run. That split is the repo's own review
discipline, and it matters here: one of my two opening hypotheses did not survive
measurement, and it is recorded as refuted rather than quietly dropped.

Measurement caveat, inherited from `scene/perf.test.ts`'s own header: absolute ms move
with the box's load, so **ratios are the claim**. Every number below was taken on a quiet
box, and the one figure I first read under contention is called out in §4.

---

## The short version

| # | Finding | Cost, measured | Confidence |
|---|---|---|---|
| 1 | `/api/lane-index` re-reads and re-parses every recording on disk, per request | **281 ms**, event loop starved | `EXECUTED` |
| 2 | The recorder does open+write+close per event | **61.4 µs/event**, 4.1× recoverable | `EXECUTED` |
| 3 | `reduceAll(eventsSoFar())` on the request path | 166 ms at 55k events | `EXECUTED` — already prd-40's |
| 4 | Per-entity `exec` loops inside collectors, not across them | 3.0× on the loops that scale | `EXECUTED` + `REASONED` |
| 5 | Server recorder buffer is unbounded; the client's is capped | asymmetry, unbounded heap | `REASONED` |
| 6 | Retired-lane fields re-tessellate a static picture every frame | **14.9 ms** of an 18.5 ms frame | `EXECUTED` |
| 7 | `runServerDoctor` spawns its subprocesses in series | ~3 execs serialised, cached | `REASONED` |

Do #1 first. It is the only finding that stalls the whole instrument, it is the cheapest to
fix, and it gets monotonically worse every week the tool is used.

---

## 1. `/api/lane-index` re-reads every recording on disk, on every request

`log/lane-index.ts:472` — `readLaneIndex` lists the session directory and then, for each
session, sequentially awaits `readSessionLog` + `readSessionLabel` +
`readTranscriptCaptureManifest`, before folding the lot in `buildLaneIndex`. There is no
cache of any kind. `api/lane-index.ts:59` calls it fresh on both routes.

Measured against this repo's own session directory — 4 session files, 20 MB, 51,690 JSONL
lines — with the page cache already warm:

```
readLaneIndex #1: 281.3 ms  (18 lanes)
readLaneIndex #2: 280.0 ms  (18 lanes)
readLaneIndex #3: 252.2 ms  (18 lanes)
```

**It starves the event loop.** JSON-parsing 51,690 lines is synchronous CPU between
awaits. A 20 ms heartbeat — the shape of an SSE keepalive or the poll timer — measured
alongside it:

```
baseline:              14 ticks fired, worst heartbeat lag  1.3 ms
during readLaneIndex:   3 ticks fired, worst heartbeat lag 92.5 ms
```

Eleven of fourteen expected ticks did not fire. So for a quarter of a second per request,
the live stream does not write, the poll loop does not tick, and no other route answers.
Both call sites are `useEffect` on mount (`recordings/RecordingsPage.tsx`,
`lane-page/LanePage.tsx`), so this is what the operator feels as *the instrument freezes
when I open Recordings*.

**It grows without bound.** Session files accumulate forever — 37 files and 39 MB across
all repo slugs on this box already, 4 files and 20 MB in this repo's own. Nothing prunes
them, so the stall is a function of how long the tool has been in use.

**The fix the data points at.** Every session file except the live one is immutable: the
live session is deliberately read from the recorder's buffer instead
(`lane-index.ts:481-484`), and a rotated-away log is closed and never appended to again.
So a per-session-id cache keyed on `mtime` + `size` is sound, and reduces steady-state
work to the live session alone. The three per-session awaits should also be a
`Promise.all` — they are independent reads of three different files.

## 2. The recorder does an open, a write and a close per event

`recorder/session-log-writer.ts` — `append()` calls `appendFile` per event, serialised
through the `tail` chain. `appendFile` is open + write + close every time.

5,000 events of 278 B, the ordering contract preserved in all three variants:

```
A  appendFile per event (current) : 306.9 ms   61.4 µs/event
B  persistent handle, per event   :  74.1 ms   14.8 µs/event    4.1x faster
C  persistent handle, coalesced   :   2.6 ms    0.5 µs/event  119.5x faster
```

**B is a free win.** One `write(2)` per event, same order, same durability posture, same
`sync()` semantics — only the redundant open/close per event goes away. The serialising
`tail` chain and prd17 ruling 1's "final `session.closed`" guarantee are untouched.

**C is not free, and should not be taken without a ruling.** Coalescing into one `write`
per microtask keeps ordering (the chunks join in call order) but widens the window in
which a process crash loses events that `record()` has already resolved. That is exactly
the territory of open issues #26 (*a dropped append speaks in the degrade*) and #4 (*an
event reaches the log before it reaches…*), so it is their decision, not a free
optimisation.

Where this bites hardest is **backfill**: both the sessionlog and pi collectors take a
`backfill` option, and a resume replays into the same per-event path. Ten thousand
backfilled events currently cost ~614 ms of pure syscall overhead.

## 3. `reduceAll(eventsSoFar())` on the request path — prd-40 already owns this

Confirmed, and correctly diagnosed already. Quiet box, `reduce.bench.test.ts`'s own
spanless corpus:

```
N=5000: 3.2 ms (0.64 µs/ev) · N=15000: 16.8 ms · N=30000: 48.3 ms · N=55000: 161.1 ms (2.93 µs/ev)
```

Issues #3 (*the recorder answers from a fold it maintains*) and #5 (*`/api/meta` answers
from the maintained fold*) are the right fix and need no argument from me.

**What I can close is prd-40's own open question.** The PRD notes that "the other 15
callers of `eventsSoFar()` were counted but not audited one by one." Audited:

- **One-shot, benign** — `cli/run.ts:207` (boot), `recorder/rotate.ts:124`,
  `api/retarget.ts:194`, `api/sessions.ts`, `api/lab.ts`, `api/concierge.ts:334`,
  `api/session-preview.ts:182`, `api/transcript.ts:657` (export path).
- **Per connection, already batched** — `api/stream.ts:156`; `flushBacklog` exists for
  exactly this and does its job.
- **Polled every 2 s** — `/api/transcript/:lane`. `findAttribution`
  (`log/transcript-attribution.ts:59`) scans backwards and breaks on first match, so a
  recently-attributed lane is cheap; a lane the log never named falls through to a full
  backward scan *twice*, plus `laneIsKnown`'s forward `.some()`. That is O(N) per poll but
  only single-digit ms at 55k events — real, not urgent.
- **The one that matters** — `/api/lane-index`, which is finding #1 and a *different*
  mechanism: disk and JSON.parse, not the fold. prd-40's incremental fold does not help it.

So prd-40's residual is benign except for lane-index, which needs its own lane.

## 4. The serialised `exec` that matters is inside collectors, not across them

**My opening hypothesis was that `poll-loop.ts:runTick`'s sequential `for` over the six
collectors was the headline cost. Measured, it is not, and the refutation is the useful
part.** Real collectors, real `exec`, against this repo:

```
SEQUENTIAL tick: 306.7 / 289.8 / 343.4 ms
PARALLEL   tick: 232.6 / 451.1 / 244.2 ms   → 1.3x / 0.6x / 1.4x
```

No reliable win, and one run was slower. The reason is Amdahl, and it is visible in the
per-collector split:

```
git         46.0 ms  4 exec(s)
tmux         5.9 ms  1 exec(s)
workmux    230.2 ms  2 exec(s)     ← 75% of the tick
judge        0.0 ms  0 exec(s)
sessionlog  10.7 ms  1 exec(s)
pi          13.9 ms  1 exec(s)
```

`workmux` is three quarters of the tick on two subprocesses (`workmux status --json`
measured at ~51 ms wall, plus `execFile` overhead, twice). Parallelising *across*
collectors cannot beat the slowest one, so it buys ~1.3× and is not worth the ordering
risk on its own.

**What is worth doing, in order:**

1. **`collectors/workmux/collector.ts:357` and `:515`** — `status --json` then
   `list --json`, strictly sequential and fully independent. This is the tick's dominant
   term on this box; firing both and then checking the status result for the
   missing-binary early return halves it. **Highest-value tick fix, smallest diff.**

2. **The per-entity loops, which are the ones that scale with the swarm.** This box has 1
   worktree, 2 branches and 0 tmux panes, so none of them showed up at all:
   - `collectors/git/git-collector.ts:352` — `git status --porcelain` per worktree, awaited
     in a `for` loop. W execs in series.
   - `collectors/git/git-collector.ts:244` — `computeAheadBehind` per branch, likewise. B
     execs in series.
   - `collectors/tmux/collector.ts:163` — `tmux capture-pane` per pane, awaited in a `for`
     loop, with `resolveWorktreePath` execs in the same loop. P execs in series, purely to
     compute a content hash.

   Proxy measurement of that shape, 20 spawns of `git status --porcelain`:
   `282.4 ms sequential vs 94.7 ms parallel` — **3.0×**. On a six-lane swarm these loops
   are ~20 serialised spawns per tick and they, not workmux, set the tick's cost.
   `REASONED` as to the swarm figure: I did not stand up six worktrees to confirm it.

**Two constraints on any fix here.** Do not reach for an unbounded `Promise.all`: six
collectors each fanning out per entity could spawn 40+ processes at once, and this is an
8 GB box that already thrashes at 4–5 concurrent lanes. Cap the concurrency. And the log
is hash-chained (ADR-0009), so gather concurrently but **record in collector registration
order** — that keeps replay byte-identical, which is the property that makes the change
provable rather than hopeful.

## 5. The server's event buffer is unbounded; the client's is capped

`recorder/session-recorder.ts:36` — `buffer` is only ever emptied by `openSession()`. The
web client, by contrast, deliberately caps itself: `app/streamState.ts:60`,
`MAX_EVENTS = 75_000`, oldest evicted first, with `eventsWindowLabel` existing precisely so
a bounded window never passes as the whole session.

So the client has ruled on this and the server has not. A multi-day session grows the
server's heap without limit, and every one of the sixteen `eventsSoFar()` call sites copies
the array. `REASONED` — I did not run a multi-day session; the asymmetry is what I am
reporting, not a measured leak. It is worth a ruling either way, and it is not obviously
free: `/api/stream`'s replay contract and the exporter both assume the whole session is
in memory.

## 6. Retired-lane fields re-tessellate a static picture every frame

The repo's own `scene/perf.test.ts`, run here. Budget is 16.67 ms:

```
30 living                        :  4.0 ms median ·  331 marks ·  24%   ok
30 living + 100 retired          : 10.8 ms median ·  831 marks ·  65%   ok
30 living + 200 retired          : 18.5 ms median · 1331 marks · 111%   over
  of which buildFrame            : 14.9 ms
model floor 60x3 (180 threads)   : 17.1 ms median · 1700 marks · 103%   over
  of which sceneMarks            : 15.0 ms
```

**Half of this is already ruled on, and I framed it wrongly the first time.** prd-33 ruling 13
states this instrument's supported size outright — 30 threads comfortably, 90 threads at 60 fps
(the shipped ceiling), and **180 threads at 30 fps**, with the explicit words *"180 threads is
not a bug to be closed by relaxing this table."* My 17.1 ms reading at 60 lanes × 3 colonies
reproduces that declared cell almost exactly. It is a published limit, not a defect, and it is
not a finding.

**The retired-lane axis is the part no PRD covers**, and it fails in a different place. prd-33's
table is about live threads across colonies, it never mentions retired or persistent lanes, and
the next candidate it names — memoising a growing thread's spine — is a *model-stage* fix. The
retired field's cost is not in the model stage at all:

```
180 live threads   : marks      14.97 ms of 17.14 ms   <- prd-33 ruling 13's declared cell
200 retired lanes  : buildFrame 14.91 ms of 18.46 ms   <- a different stage, unowned
```

Worst-case frames reach 42–86 ms. Only the second row is open work.

**The cheapest lever is the one the layout cache already argued, one stage later.**
`docs/design-notes/geometry-cache-audit-178.md` established that a retired lane's spine is
a pure function of the world frame past `dissolve >= 1` — that is why `livingSpineCache`
is lawful. But `gl/frame.ts:141` calls `vertices.reset()` and re-tessellates *every* mark
every frame, so those provably-static retired spines are rebuilt into vertex arrays 60
times a second for a picture that cannot change. A persistent vertex range for the
settled-retired set attacks the 14.9 ms term directly, on exactly the argument the
geometry cache already won. `REASONED` — I did not build it.

Two honesty notes on these figures: `buildFrame` is CPU tessellation measured under jsdom,
so real frame cost is this *plus* GPU upload and draw; and `hideFinished` already gives the
operator an escape hatch (200 retired hidden: 11.3 ms), so this is a default-quality
question, not a wall.

## 7. `runServerDoctor` spawns its subprocesses in series

`api/doctor.ts:95` — `await` on each element of an array literal, so
`checkOptionalTool('tmux')`, `checkOptionalTool('workmux')` and `checkCliVersionDrift`
each spawn and complete before the next begins, each under a 5 s ceiling.

Real but low priority: the route has single-flight plus a 15 s TTL cache
(`PROBE_CACHE_TTL_MS`) and `/connect` polls at 5 s, so two of every three requests are
cache hits. `Promise.all` over the independent checks is a two-line fix whenever the file
is next open. `REASONED`.

---

## Which of these already has a home

Checked against all sixteen current PRDs, by mechanism and by file path.

| # | Owning PRD | Status |
|---|---|---|
| 1 | none | **Homeless.** No PRD names `log/lane-index.ts` or `log/listing.ts`. |
| 2 | none | **Homeless.** No PRD names `session-log-writer.ts`. |
| 3 | **prd-40** ruling 2, issues #3/#5 | **Fully owned.** Nothing to add but §3's audit. |
| 4 | none | **Homeless.** No PRD names any collector directory. |
| 5 | prd-40 (adjacent) | **Hook, no ruling.** Its open question is the prerequisite. |
| 6 | **prd-33** ruling 13 (half) | **Half ruled, half homeless** — see §6. |
| 7 | none | **Homeless.** No PRD names `theme.css`; none mentions contrast. |

Three things this mapping turned up that matter more than the table:

**prd-40 makes finding 2 *more* load-bearing, not less.** Its ruling 1 puts the append on the
critical path — "the append is awaited before the event is anyone's." Today an event is published
and the write races behind it; after prd-40, every event waits for its own write before anyone
sees it. That is the correct durability answer, and it moves 61 µs of open/close overhead per
event onto the path the operator waits on. **Finding 2 should land before or with prd-40's wave 1,
not after it** — otherwise prd-40 ships a latency regression that finding 2 would have prevented.

**prd-40 and finding 4 collide on one file.** Both want `server/poll-loop.ts`: prd-40 wave 2
(issue #4) for the snapshot/append ordering, finding 4 for concurrency. Same file, incompatible
diffs if they run in parallel — and per the working agreement they cannot be bundled, because one
depends on the other's shape. Sequence them: prd-40's ordering first, concurrency on top of it.

**Two research documents look like they cover findings and do not.**
`research/2026-08-16-concurrency-measurement.md` is about how many *animation pulses* are alive at
once, not about subprocess concurrency — it does not touch finding 4.
`docs/design-notes/geometry-cache-audit-178.md` caches a retired lane's *geometry* and is the
precedent finding 6 leans on, but it stops before the tessellation stage where the cost actually
sits. Both are worth reading before opening either lane; neither is the lane.

One useful corroboration from that concurrency doc: real recorded sessions in this project's own
history reach **63,653 events over 43.5 hours**, with several above 27,000. Findings 3 and 5 are
therefore about sizes this instrument genuinely reaches, not hypothetical ones.

---

## What I would do, in order

1. **#1, lane-index caching.** Biggest single win, bounded diff, and it is the only
   finding here that stalls the entire instrument. It also needs a retention answer for
   the session directory, which nothing currently prunes.
2. **#2 variant B, the persistent file handle.** 4.1× on the path every event takes, with
   no semantic change to argue about.
3. **#4.1, workmux's two commands.** Smallest diff on this list; halves the tick's
   dominant term.
4. **#4.2, the per-entity exec loops.** The only item whose cost grows with the swarm, so
   it is the one that matters most on a real fleet and least on this box.
5. **#3 is already prd-40's** — nothing to add beyond closing its open question (§3).
6. **#5 and #6 want rulings before code**, not lanes. #7 whenever the file is next open.
