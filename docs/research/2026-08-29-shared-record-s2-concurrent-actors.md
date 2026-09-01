# s2-concurrent-actors — N shippers, one server, one table: losslessness demonstrated, ordering guaranteed by construction

Lane `166-concurrent-shippers`, rhizomorph prd-48 wave 2 (issue #166, "two shippers writing
at once lose and reorder nothing"). This spike extends
`docs/research/2026-08-28-shared-record-s2-shipper.md` (single-shipper; read-only, not
edited) from one actor to eight, on the same server/table design. Build area
`~/rhizomorph-spikes/concurrent-actors/` (throwaway, outside this git tree). Repo checkout
and `~/.local/share/rhizomorph` were read-only throughout; every ledger used below is a
**copy** (PRD ruling 2).

Box: macOS, Apple Silicon (arm64), 18 logical cores, 48 GiB RAM, node v22.22.2, Postgres 18.4
(Homebrew, native — no docker on this box, so this is a client of the operator's own local
Postgres instance rather than a throwaway container; a dedicated database,
`rz_spike_concurrent_actors`, was created for it and is dropped in the reproduction section).
**Same physical box as `docs/research/2026-08-29-shared-record-s1-corpus-machines-2-3.md`'s
"machine 2".** Shared box, and every timing below carries its loadavg: `3.72, 4.40, 6.73` at
the start of the run, `1.93, 3.09, 4.00` by the end.

**Headline:** across six runs — a concurrent cold backfill (which is also falsifier row (f),
simultaneous start), a 10-minute sustained live-tail, and four further falsifier rows
(staggered start, one throttled actor, kill-mid-flight, mixed backfill+live-tail) — eight
concurrent shipper processes into **one server, one in-process queue, one drain loop** produced
**zero duplicate rows, zero gaps, across every one of 48 actor-checks (8 actors × 6 rows)**,
and every actor's server-side record closed to the same chain digest as its local copy. **Not
every one of those checks was a demonstration — two are guaranteed by this design's
construction, and the note says which, plainly, rather than letting the headline claim more
than the runs showed:**

- **Zero duplicate rows is a database-constraint fact, not a run result.** `events_n`'s primary
  key is `(project, actor_instance, n)` and every insert is `ON CONFLICT ... DO NOTHING` — a
  duplicate row is not possible under this schema, in any run, chaos or not. The dup check
  passing is a check that the constraint is wired correctly, not evidence the chaos rows were
  survived.
- **Zero reorders held everywhere it could be tested, and had exactly one actor-check, of 48,
  where a genuine reorder was structurally possible at all.** Each shipper awaits its own POST
  before forming its next batch (strictly one batch in flight per actor) and the server drains
  with one FIFO loop — so for any actor never killed mid-flight, per-actor `n`-vs-`serial`
  monotonicity is **guaranteed by this design**, not demonstrated by the run. Only a killed
  shipper (a dead process's in-flight request racing a freshly restarted process resending from
  the same cursor) has any path to break that guarantee. Exactly one actor was ever killed
  across all 48 actor-checks — actor-5, row `kill-i` — so that is the one actor-check where
  "zero reorders" is evidence rather than restated construction; the other 47 held because the
  design does not let them do otherwise.
- **What the runs actually demonstrate, and what still needs a concurrent-writer design to
  re-earn:** the gap check (every `n` from 1..max present, no holes) and the chain-digest
  closure (`verifyRecord`, local vs. server, all 48 actor-checks) are both real, run-dependent
  results — either could have failed and did not. **Per-actor ordering under this
  single-queue/single-drain-loop design is guaranteed by construction, not proven by these
  runs; a design with concurrent Postgres writers (multiple connections actually issuing
  overlapping INSERTs) would have to re-earn it, and this spike says nothing about whether it
  would.**

Two things do not travel from this spike alone: the mergeRecords-based per-actor order check
could only be run cleanly on *synthetic* data — real session-log ids collide so heavily, both
within one actor's own log (S2's finding) and **newly, across different actors' logs**, that
id-based attribution from a merged stream is unsafe on this corpus; and a real, unscripted
~2–3 minute server outage during the run — caused by a sibling lane's accidental process kill
on a shared box, not by the design under test — is reported honestly rather than folded into
the falsifier table as if it had been a controlled test.

---

## What this note built, and what "concurrent" means here

**Single in-process queue, single drain loop — the same design S2 used, extended to N
producers, not to N writers.** `server.mjs` is one `node:http` process holding one JS array as
its queue and one `while(true)` drain loop draining it with `INSERT ... ON CONFLICT DO
NOTHING`. Eight shipper processes each POST to that one server concurrently — so
**"concurrent" here means concurrent HTTP arrival from N OS processes into one shared
in-memory queue, drained sequentially by a single writer.** It does **not** mean concurrent
Postgres write transactions: at no point are two INSERTs from two different actors in flight
against the database at the same time. A reader who wants true multi-connection DB write
concurrency (a pool with `max > 1` actually issuing overlapping transactions) will not find it
tested here — see "What this did not test."

Same dual-table design as S2, extended with an `actor_instance` column and namespaced further
by a `project` column (one project per chaos row/variant, so all six runs share one server and
one pair of tables without truncating between rows):

```sql
CREATE TABLE events_n (
  project text, actor_instance text, n integer, id text, ts bigint, type text, line text,
  serial bigserial, PRIMARY KEY (project, actor_instance, n)
);
CREATE TABLE events (
  project text, actor_instance text, event_id text, ts bigint, type text, line text,
  serial bigserial, PRIMARY KEY (project, actor_instance, event_id)
);
```

`events_n` is the lossless table (`n` = 1-based line position in that actor's own ledger,
deterministic from file position, exactly as S2 established); `events` is the briefed schema,
kept for fidelity and because its known defect (S2's finding) is cheap to re-observe at this
scale, not to re-diagnose.

**Actors and data.** N = **8**, an engineering/hardware choice for this box, not a
corpus-measured concurrency figure — S1 never measured how many actors are literally
concurrent on one real machine. Eight distinct real session logs, copies of the first 25,000
lines of each (a bounded slice, not the full ledger — see "What this did not test"), spanning
all three real project dirs S1's machine-2 note found on this box:

| actor | source (role, S1's naming) | source file lines | slice used |
|---|---|---:|---:|
| actor-0 | `server-*` | 1,129,197 | 25,000 |
| actor-1 | `server-*` | 53,217 | 25,000 |
| actor-2 | `server-*` | 144,690 | 25,000 |
| actor-3 | `server-*` | 109,063 | 25,000 |
| actor-4 | `rhizomorph-*` (main checkout) | 169,251 | 25,000 |
| actor-5 | `rhizomorph-*` (main checkout) | 70,079 | 25,000 |
| actor-6 | `rhizomorph-*` (main checkout) | 381,418 | 25,000 |
| actor-7 | `262-clone-by-url-*` (a worktree lane) | 60,062 | 25,000 |

200,000 lines / 58,153,699 bytes total per full-backfill run. Batch rate: S2's own 500
lines/250 ms for the backfill-stress variant, unmodified.

**Two variants, both run, plus five falsifier rows — six runs total, one shared server:**

| run | project | mode |
|---|---|---|
| (a) concurrent full-ledger backfill = (f) simultaneous start | `backfill-f` | all 8 actors' shippers launched in the same instant, cold backfill of their 25k-line slice |
| (b) sustained live-tail | `sustained-b` | all 8 actors append synthetic events at 1/2 s (~1,800/hour/actor, grounding: S1 machine-2's measured peak 1,246–1,406 events/pane-hour) for 600 s wall clock |
| (g) staggered start | `staggered-g` | each actor's shipper starts after an independent random 0–3,000 ms delay |
| (h) one slow actor | `slow-h` | actor-3 throttled +1,500 ms/batch; the other 7 run at full speed |
| (i) kill mid-flight | `kill-i` | actor-5's shipper `SIGKILL`ed 4 times at random 300–800 ms intervals, then run to completion, while the other 7 actors ship continuously and undisturbed |
| (j) mixed regime | `mixed-j` | actors 0–3 cold-backfill their real slice; actors 4–7 live-tail synthetic appends for 120 s — concurrently, same server/table |

---

## A real implementation bug the smoke test caught, before any chaos row ran

**[EXECUTED]** The first smoke run (one actor, 25,000-line slice) shipped **25,005** rows for a
25,000-line file. Cause: the shipper computed newline positions and consumed-byte offsets from
`chunk.toString('utf8')` — a UTF-16 JS string — while `cursor.offset` is a **byte** offset the
next `fs.readSync` call uses directly. The moment a line holds a multi-byte UTF-8 character
(present in real session logs — accented names, box-drawing glyphs in pane previews, emoji in
commit subjects), `string.length` diverges from the buffer's byte length, and the cursor
silently desyncs from the real line boundaries on the next poll. Fixed by scanning the raw
`Buffer` for newline bytes (`chunk[i] === 10`) and only decoding each line's own byte slice to
UTF-8, never the whole chunk. Re-run: 25,000 rows for 25,000 lines, exact. This is reported
because it is exactly the kind of defect this spike exists to catch — found by the harness's
own correctness check, not assumed away.

## The accept-fast/drain decouple, observed under concurrent load

**[EXECUTED]** The 202 response is returned when a batch is **enqueued**, not when it is
inserted — S2's finding, reproduced here under 8-way concurrency. A shipper's own `exit` (all
lines POSTed, all 2xx) is **not** the same moment as "the row exists in `events_n`." Querying
the database immediately after `kill-i`'s orchestrator process exited showed several actors
short of their full 25,000 rows (observed live via `/stats`'s `queueDepth`/`queueDepthPeak`
during the run, peaking in the low hundreds of batches under concurrent 8-actor load — not
captured to a persisted file, so the exact count is not re-derivable from disk after the fact
and is reported as REASONED-from-memory-of-the-run rather than EXECUTED-and-checkable); a
re-query several seconds later showed all 8 complete. This is not data loss — it is the drain
loop still working through the queue — but it means **verification must wait for the queue to
drain, not for the shippers to exit.** `wait-drained.mjs` (poll `/stats` for `queueDepth===0`
three consecutive times) was added and used before every verification query below.

## An unscripted server outage, reported plainly — and its real cause

**[EXECUTED, incidental — not one of the six designed rows]** Partway through the run the
server process died with no error trace in its own log (stdout+stderr both redirected). It
happened after `backfill-f`, `staggered-g`, `slow-h` and `kill-i` had **already completed and
exited cleanly** (all four shippers had their final 2xx before the server died), but **during**
`sustained-b`'s 600-second append window (started before the outage, still running) and during
`mixed-j`'s first ~2 minutes. The server was restarted (fresh process, same database, same
tables) roughly 2–3 minutes later. Both in-flight runs resumed unaided — `mixed-j`'s wall time
(294,968 ms against an ~248,000 ms baseline of append-duration + idle-exit threshold) is fully
accounted for by this gap, and `sustained-b` closed with the same `300/300` rows per actor as
every other row and matching chain digests (see below) — **though its own shippers did not
exit cleanly**: all 8 recorded `code: null` (killed by signal, not a normal exit). The row
counts and digests are unaffected either way — every line each shipper had shipped closed to
its local copy — but "closed clean" below describes the data, not the process exit.

**[EXECUTED, corrected]** This was not process supervision. The sibling lane for issue #167
(`prd48 w2: an ack-after-durable-journal shipper loses no batch when the server dies`) records,
in its own note, killing a concurrent sibling lane's server process by accident during a broad
`ps`/`lsof`-based cleanup — naming **port 5561** and the build area
**`~/rhizomorph-spikes/concurrent-actors/`**. Both match this run exactly: this note's server
runs on port 5561 in that exact directory (see "Reproduction"), so that is this note's server,
not a different process that happened to share the number. This lane's `sustained-b` shippers
all exiting `code: null` (killed by signal) is consistent with the same event and is re-read in
that light, not attributed to sandbox process reaping.

What this side can and cannot verify: the sibling's note records one accidental kill and states
it was not touched again afterward. That accounts for **one** of the server's two apparent
disappearances in this run's timeline — this note cannot independently confirm which, and
cannot verify anything about a second one, since nothing on this side observed the kill itself,
only its effect (the process being gone, then running again). This is **not** a controlled
durability test — S2 already owns that finding precisely (500 lines lost, one measured
instance, `docs/research/2026-08-28-shared-record-s2-shipper.md` row (c)) — but it is real,
unscripted evidence that resume-after-outage held under concurrent, mixed-regime load in this
run, caused by a real shared-box collision between two sibling lanes' spikes rather than by
the design under test, and it is reported as what actually happened rather than smoothed into
the falsifier table as if it had been designed.

---

## Results

### The three checks, per actor, per row — all EXECUTED

**Check 1 — dup/inversion/gap, the architect's exact SQL, scoped to each row's `project`. Read
this table against what each column can and cannot show, stated plainly:**

- **`dup_count` cannot be anything but 0.** `events_n`'s primary key is `(project,
  actor_instance, n)` and every insert is `ON CONFLICT (project, actor_instance, n) DO NOTHING`
  (`server.mjs`). A duplicate row violates the constraint before it can be written. This column
  checks the constraint is wired, not that the chaos rows were survived.
- **"Actors with any inversion" is a guarantee for 47 of the 48 actor-checks, and a real result
  for exactly 1.** Each shipper (`shipper.mjs`) `await`s its own POST before building its next
  batch — one batch in flight per actor, ever — and the server drains with a single FIFO loop
  (`queue.shift()` → `await insertBatch()`, `server.mjs`). So for any actor never killed
  mid-flight, insertion order equals send order equals `n`-ascending order, and `serial` is
  monotonic in `n` by construction — no run of this design can produce an inversion for such an
  actor, chaotic or not. The one actor ever killed mid-flight, anywhere in this spike, is
  actor-5 in row `kill-i` (`SIGKILL`ed four times) — a dead process's already-in-flight request
  racing a freshly restarted process resending from the same unwritten cursor is the one path
  that could break the monotonicity guarantee. That is the one actor-check (of 48) where "0
  inversions" is a demonstrated result rather than restated construction.
- **The gap check is a real result for every actor, every row.** Nothing in the schema or the
  drain loop prevents a hole in `n` — a batch that never arrives, or arrives and is never
  retried, would show up here. This column, together with chain-digest closure below, is what
  actually carries this spike's losslessness finding.

```sql
SELECT count(*) - count(DISTINCT (actor_instance, n)) AS dup_count FROM events_n WHERE project=$1;

WITH s AS (
  SELECT actor_instance, n, serial,
         lag(n) OVER (PARTITION BY actor_instance ORDER BY serial) AS prev
  FROM events_n WHERE project=$1
)
SELECT actor_instance, count(*) AS inversions
FROM s WHERE prev IS NOT NULL AND n <= prev GROUP BY actor_instance;

SELECT a.actor_instance, count(*) AS gaps
FROM (SELECT actor_instance, max(n) AS max_n FROM events_n WHERE project=$1 GROUP BY actor_instance) a
CROSS JOIN LATERAL generate_series(1, a.max_n) AS g(g)
LEFT JOIN events_n e ON e.actor_instance=a.actor_instance AND e.n=g.g AND e.project=$1
WHERE e.n IS NULL GROUP BY a.actor_instance;
```

| row (project) | dup_count (whole row) | actors with any inversion | any actor killed mid-flight? | actors with any gap | rows per actor |
|---|---:|---:|:---:|---:|---|
| `backfill-f` | 0 (structural) | 0 / 8 (guaranteed) | no | 0 / 8 | 25,000 each, `n` 1..25,000 |
| `staggered-g` | 0 (structural) | 0 / 8 (guaranteed) | no | 0 / 8 | 25,000 each, `n` 1..25,000 |
| `slow-h` | 0 (structural) | 0 / 8 (guaranteed) | no | 0 / 8 | 25,000 each, `n` 1..25,000 |
| `kill-i` | 0 (structural) | 0 / 8 (**1 demonstrated** — actor-5) | **yes, actor-5 × 4** | 0 / 8 | 25,000 each, `n` 1..25,000 |
| `mixed-j` | 0 (structural) | 0 / 8 (guaranteed) | no | 0 / 8 | 25,000 (actors 0–3), 60 (actors 4–7) |
| `sustained-b` | 0 (structural) | 0 / 8 (guaranteed) | no | 0 / 8 | 300 each, `n` 1..300 |

Grand total across every row, every actor, one query: `SELECT count(*) - count(DISTINCT
(project, actor_instance, n)) FROM events_n` → **0** (structural, per above — see "The three
checks" preamble for which of these three columns each demonstrate a result versus restate the
schema/design). Total rows shipped across all six runs: **902,640**.

**Check 3 — verifyRecord chain closure, per actor, per row (the crown, S2's method,
unmodified `record/build.ts` / `verify.ts` / `jsonl.ts` via `npx tsx`):**

All **48** actor-checks (8 actors × 6 rows) — `DIGEST_EQUAL: true`, `verify_server_ok: true`,
zero parse errors on either side, zero unknown lines. Representative rows (`backfill-f`, full
64-hex digests in `results/*.crown.log` at the throwaway path):

| row | actor | local_lines | server_rows | chainDigest (both sides, truncated) | verify ok |
|---|---|---:|---:|---|:---:|
| `backfill-f` | actor-0 | 25,000 | 25,000 | `c8a178a27d5ccc4d...` | true |
| `backfill-f` | actor-5 | 25,000 | 25,000 | `e378bb0aff30adc1...` | true |
| `sustained-b` | actor-0 | 300 | 300 | `7746411db18751ca...` | true |
| `sustained-b` | actor-7 | 300 | 300 | `c958d60685ad6cd2...` | true |
| `mixed-j` | actor-3 (backfill half) | 25,000 | 25,000 | `f9d16f1aeb73aba6...` | true |
| `mixed-j` | actor-4 (live-tail half) | 60 | 60 | `2649685bc179da82...` | true |

Every actor in every row: same digest local vs server, `verifyRecord(server) → {ok: true}`,
`unknown: 0`. A ledger that went through concurrent HTTP arrival into a shared queue, five
kinds of chaos, and a shared-drain-loop server that itself died and came back mid-run,
reconstructs to the same hash as the file it came from, for every one of 48 actor-checks.

### Check 2 — mergeRecords per-actor order preservation: real data breaks the *check*, not the tool

**[EXECUTED]** Before trusting `mergeRecords`, per-actor id uniqueness was checked (`jq -r .id
<log> | sort -u | wc -l` vs `wc -l`) — S2's own precondition:

| actor | lines | unique ids | duplicate-id lines |
|---|---:|---:|---:|
| actor-0 | 25,000 | 24,999 | 1 |
| actor-1 | 25,000 | 24,999 | 1 |
| actor-2 | 25,000 | 23,258 | 1,742 |
| actor-3 | 25,000 | 24,871 | 129 |
| actor-4 | 25,000 | 24,999 | 1 |
| actor-5 | 25,000 | **25,000** | **0** |
| actor-6 | 25,000 | **25,000** | **0** |
| actor-7 | 25,000 | 24,999 | 1 |

Six of eight actors reproduce S2's finding (the `evt-NNNNNN` collector-cycle counter repeats
within one log) at a smaller scale than S2's 74.5% (this note's slices are 25,000 lines against
S2's full 63,653-line file — the defect's severity tracks how many collector-cycle boundaries a
slice crosses, not a fixed rate; the `events` briefed-schema table's own loss here is
**1,875/200,000 = 0.94%** aggregate, consistent with that explanation and directly checkable
against the `briefed_schema_rows` column in `results/*.verify.json`).

**A second, new finding this spike adds: ids collide heavily *across* actors too, even where
each actor's own log is internally unique.** `evt-NNNNNN` is a local per-session counter, not a
global one, so two entirely different real sessions both start near `evt-000001`:

```
$ cd ledgers
$ comm -12 <(jq -r .id backfill-actor-5.jsonl | sort -u) <(jq -r .id backfill-actor-6.jsonl | sort -u) | wc -l
22755        # of 25,000 unique ids each — 91% overlap, between two actors BOTH internally unique
```

Across all 28 actor pairs in this dataset, pairwise id overlap ranges **17,025–24,999** out of
25,000 (68–100%). **This means id-membership cannot be used to recover which actor an event in
a merged stream came from** — `mergeRecords`' own dedup key (`actor.instance + event.id`) is
correctly namespaced internally and is not the defect; the defect is that *an external
verifier* reading `MergedRecord.events` (which is `RhizomorphEvent[]`, with no per-event actor
tag — `interleave()` in `merge.ts` deliberately does not carry `TaggedEvent.actorInstance`
through to its output) cannot safely reconstruct attribution from real multi-actor data by id
alone.

**Consequence, following the plan's own fallback exactly:** for all 8 backfill/chaos-row
actors (`backfill-f`, `staggered-g`, `slow-h`, `kill-i`, and `mixed-j`'s backfill half), the
mergeRecords-based subsequence check was **not run** — cited here, not re-diagnosed — and
**check 1's raw per-actor `events_n` order check (0 inversions, 0 gaps, every actor, every row
above) is the load-bearing per-actor-order evidence instead.**

**Where it *could* be run cleanly: `sustained-b`'s synthetic-id actors.** Synthetic lines use
`synth-<actor>-<seq>` ids, globally unique by construction (the actor name is embedded in the
id itself), so id-membership attribution is safe. Paired `(0,1)`, `(2,3)`, `(4,5)`, `(6,7)`,
each pair's own record built from its `events_n` rows, merged via the real `mergeRecords(a,
b)`, each actor's subsequence in the merged output extracted by id-membership and compared to
that actor's own reconstructed order:

| pair | cross-actor id collisions | merged events | subA matches own order | subB matches own order |
|---|---:|---:|:---:|:---:|
| actor-0, actor-1 | 0 | 600 | true | true |
| actor-2, actor-3 | 0 | 600 | true | true |
| actor-4, actor-5 | 0 | 600 | true | true |
| actor-6, actor-7 | 0 | 600 | true | true |

4/4 pairs, clean. This is the check the plan asked for, executed on the one dataset in this
spike where it is safe to execute — the plan anticipated exactly this fallback ("If it bites:
cite S2's finding, do not re-diagnose or fix it — report the raw per-actor events_n order check
as the load-bearing one instead for that actor"), and it did bite, on 6/8 real-ledger actors
plus a newly-found cross-actor form the plan didn't name.

---

## Falsifier verdicts

Per the plan's verdict rule, stated verbatim: *"any interleaving producing one duplicate, one
reorder not explained by a legitimate replay/repair, or one chain that does not close for ANY
actor is a FAIL... Zero across all rows, all actors, is a PASS."* Read against "the three
checks" above: the dup half of that rule cannot trip under this schema regardless of row, and
the reorder half could only have tripped for the one actor ever killed mid-flight (actor-5, row
`kill-i`) — everywhere else, "0 inversions" restates the design rather than surviving a test of
it. The gap and chain-closure columns below are the ones doing real work in every row.

| row | what happened | dup (structural) / inversion (guaranteed unless killed) / gap (real) | chain closure | verdict |
|---|---|---|---|---|
| (f) simultaneous start | all 8 shippers' cold backfill launched in the same instant | 0 / 0 / 0 | 8/8 actors | **PASS** |
| (g) staggered start | independent random 0–3,000 ms start offsets | 0 / 0 / 0 | 8/8 actors | **PASS** |
| (h) one slow actor | actor-3 throttled +1,500 ms/batch (row wall time 76,407 ms, dominated by the throttle: 50 batches × 1.5 s); the other 7 finished at full speed and were not stalled — the shared queue/drain loop absorbs one slow producer without blocking the others, since each shipper is an independent OS process and the drain loop processes whatever the queue holds regardless of source | 0 / 0 / 0 | 8/8 actors | **PASS** |
| (i) kill mid-flight | actor-5 `SIGKILL`ed 4 times at random 300–800 ms intervals mid-ship, resumed each time from its own cursor; the other 7 actors shipped continuously, undisturbed. **This is the one row, and actor-5 the one actor, where the inversion check had any genuine path to fail** | 0 / 0 / 0 | 8/8 actors | **PASS** |
| (j) mixed regime | actors 0–3 cold-backfilling their full 25k slice while actors 4–7 live-tailed synthetic appends for 120 s, concurrently on the same server/table (and incidentally spanning the server outage caused by the sibling #167 lane's accidental kill, above) | 0 / 0 / 0 | 8/8 actors | **PASS** |

**Concurrency-specific falsifier verdict: PASS, stated to the precision the evidence
supports.** This design is lossless (zero gaps, all chain digests close) under five
deliberately adversarial interleavings plus one real, unscripted shared-box outage, across
902,640 rows and 48 actor-checks. **Per-actor ordering is guaranteed by this design's
construction — one shipper in flight at a time, one FIFO drain loop — rather than demonstrated
by these runs**; the one actor-check with any genuine path to a reorder (actor-5, `kill-i`)
held. Concurrent shipping into this single-queue/single-drain-loop design does **not**, on this
evidence, need a design answer before the build PRD. A design with concurrent Postgres writers
(multiple connections issuing overlapping INSERTs) is a different design that would have to
re-earn the ordering guarantee this one gets for free — this spike says nothing about whether
it would, and that qualification is in scope (below), not a hedge on the result reported here.

---

## What this note did not test

- **True multi-connection Postgres write concurrency — and, tied to it, per-actor ordering
  under that different design.** This server design is single queue/single drain loop by
  construction (reused from S2 deliberately) — "concurrent" here is concurrent HTTP arrival,
  not concurrent DB transactions. That same construction is exactly why this note's per-actor
  order check could not fail for 47 of its 48 actor-checks (see "The three checks," above): one
  shipper in flight at a time, drained by one FIFO loop, makes an inversion structurally
  unreachable for any actor that was never killed. A design with N pool connections actually
  issuing overlapping INSERTs from different actors at once is untested, and per-actor ordering
  under it is an open question this spike does not answer — it would have to be re-earned, not
  assumed to carry over, and this spike says nothing about whether Postgres-level write
  contention (lock waits, serialization failures under `SERIALIZABLE`, etc.) is or is not an
  issue for that different design either.
- **The ack-after-journal durability gap.** S2 measured a controlled 500-line loss from the
  accept-fast 202 preceding the INSERT; this note's unscripted outage did not lose data, but it
  was not a controlled test of that mechanism, and re-running S2's row (c) under durable-ack is
  sibling lane `s2-ack-after-journal`'s territory, not re-tested here.
- **Full-ledger concurrent backfill.** Each actor shipped a 25,000-line slice (58 MB total, 8
  actors), not a full multi-hundred-thousand-line ledger like S2's single-actor 63,653-line
  run — a scope choice to keep an 8-actor matrix plus a 10-minute sustained run inside a
  spike's time budget. The single-writer drain loop's throughput at 8× the per-actor volume
  used here is not measured.
- **mergeRecords per-actor order preservation on real multi-actor data.** Blocked by the
  id-collision findings above (both S2's within-actor form and this note's new cross-actor
  form) for 6/8 backfill actors and all cross-actor pairings of real-ledger data; the raw
  `events_n` order check substitutes, per the plan's own fallback.
- **Real network conditions.** Loopback only, one box, shared with other work (loadavg 1.93–6.73
  across the two samples recorded in the header — no continuous loadavg trace was kept, so this
  is the min/max of the two triples actually recorded, not a sampled range).
- **A controlled durability chaos row under concurrency** (S2's row (c), re-run with N actors
  live) — the unscripted outage is suggestive but not a substitute; see above.
- **The veil (S6).** Not this spike's remit; no wire capture was taken here.

## Reproduction

Throwaway: `~/rhizomorph-spikes/concurrent-actors/` (this note's evidence came from there).
`REPO_ROOT` below is your own rhizomorph checkout.

```bash
mkdir -p ~/rhizomorph-spikes/concurrent-actors/{ledgers,cursors,logs,results}
cd ~/rhizomorph-spikes/concurrent-actors
npm init -y && npm install pg tsx

# 8 real, distinct session-log copies, sliced to their first 25,000 lines — never the original
# NOTE: this selects the same 8 files the run used (the 8 largest), but `ls -S` orders them by
# size, which is NOT the actor->file assignment in the table above (that run's actor-1 is the
# 53,217-line log, not the second-largest). Aggregates — row counts, the 902,640 total, the
# id-collision ranges — reproduce either way; the per-actor chain digests quoted above will
# only match if you reproduce the table's own assignment.
i=0
for f in $(ls -S ~/.local/share/rhizomorph/*/session-*.jsonl | head -8); do
  head -n 25000 "$f" > "ledgers/backfill-actor-$i.jsonl"
  i=$((i+1))
done

# one Postgres database, dedicated to this spike (no docker on this box — a client of the
# operator's own local Postgres instance instead; adjust host/port/user to yours)
psql -h 127.0.0.1 -p 5433 -U "$(whoami)" -d postgres -c "CREATE DATABASE rz_spike_concurrent_actors;"

PORT=5561 PGPORT=5433 PGDATABASE=rz_spike_concurrent_actors node server.mjs &   # single queue, single drain loop

# (a)/(f) simultaneous full-ledger backfill, all 8 actors
node orchestrator.mjs simultaneous backfill-f
# (g) staggered start
node orchestrator.mjs staggered staggered-g
# (h) one slow actor (actor-3, +1500ms/batch)
node orchestrator.mjs slow slow-h actor-3 1500
# (i) kill mid-flight (actor-5, 4 kills)
node orchestrator.mjs kill kill-i actor-5 4
# (j) mixed regime (actors 0-3 backfill, 4-7 live-tail, 120s)
node orchestrator.mjs mixed mixed-j 120000
# (b) sustained live-tail, all 8 actors, 10 minutes, ~1 event/2s each
node orchestrator.mjs sustained sustained-b 600000 2000

node wait-drained.mjs                      # poll /stats until queueDepth==0 x3 before verifying
node verify-sql.mjs <project>               # check 1: dup / inversion / gap, per actor
REPO_ROOT=<path-to-your-rhizomorph-checkout> \
  npx tsx crown.mts <project> actor-0:ledgers/backfill-actor-0.jsonl,... [crown|crown+merge]
# check 3 always runs; add crown+merge to also run check 2 (only safe on globally-unique ids)

psql -h 127.0.0.1 -p 5433 -U "$(whoami)" -d postgres -c "DROP DATABASE rz_spike_concurrent_actors;"
```

Ports used: pg `127.0.0.1:5433` (this box's native Postgres, not a fresh container — the same
port number S2's docker container used, since this is a different binding: a native service,
not a container. A sibling lane still following S2's docker recipe on this box would collide on
5433; that is a real, live hazard for `s2-ack-after-journal`, not resolved here), server `5561`
— chosen distinct from S2's `5451/5452` server/proxy ports so this spike's own server does not
collide with a still-running S2 rerun.

Counts verified with the architect's exact SQL (reproduced in full under "Results" above), and
the crown check with:

```sql
SELECT line FROM events_n WHERE project=$1 AND actor_instance=$2 ORDER BY n;
```
