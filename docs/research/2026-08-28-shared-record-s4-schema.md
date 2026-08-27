# s4-schema — one partitioned events table with JSONB payloads, at 10M rows

Lane `s4-schema`, rhizomorph prd-48 (PR #141). Run 2026-08-28 05:20–05:40 UTC+0 local.
Build area: `~/rhizomorph-spikes/schema/`. Throwaway: docker `postgres:16-alpine`,
container `rz-spike-schema-pg` on `127.0.0.1:5434`, volume `rz-spike-schema-pgdata`.
Both removed at the end ([EXECUTED], see Cleanup).

**Box, as measured, not as briefed.** The brief says i9-13900H / 20 cores / 31 GiB.
`nproc` returned **6** and `free -g` returned **15 GiB total** — this session sees a
6-core, 15 GiB WSL2 slice, not the full machine. Every absolute number below is on
that slice, with other fleet lanes running concurrently. Loadavg is quoted per step.

---

## What ran

1. **Census.** No `~/rhizo-spikes/notes/s1-corpus.md` existed at 05:20 (s1 still in
   flight), so the type mix was derived here from the largest real log.
2. **Schema.** `events` partitioned `BY RANGE (ts)` monthly, four partitions
   (2026-06 … 2026-09). The `UNIQUE (project_id, actor_instance, event_id)` attempt
   was run and its refusal captured verbatim.
3. **Load.** 10,000,000 generated rows (4.40 GB COPY-text), single `\copy`, timed.
4. **Indexes.** BRIN on `ts`, then btree `(project_id, lane)`, then — driven by the
   query results, not up front — btree `(type, ts)` and `(lane, ts)`, and one
   covering expression index. Each timed and sized.
5. **Five org queries**, `EXPLAIN (ANALYZE, BUFFERS)`, 4 warm runs each, median of
   the last 3 is the claim.
6. **Retention.** `DROP` of the oldest month vs `DELETE`+`VACUUM`(+`VACUUM FULL`),
   both on the same 5,000,000 rows, with `pg_database_size` before/after.
7. **RLS.** Two login roles, one policy each on `project_id`; cross-project read and
   write refusals executed; ingest measured with the policy on and off.

**Postgres settings** (all non-default, all documented because they flatter ingest):
`shared_buffers=1GB work_mem=64MB maintenance_work_mem=1GB max_wal_size=8GB
checkpoint_timeout=30min fsync=off synchronous_commit=off`, `--shm-size=2g`.
`fsync=off` makes every write number here **optimistic**; the query, retention-ratio
and RLS-ratio claims do not depend on it.

### The census [EXECUTED]

Largest real log: `~/.local/share/rhizomorph/worktrees-challenge-71202028/session-1785739192605.jsonl`
— 25 MB, **63,653 events**, spanning 1785739192632 → 1785895662366 (≈1.8 days).
Every line has exactly `id,ts,source,type,payload` (63,653/63,653).

```
jq -r '.type' <file> | sort | uniq -c | sort -rn
```

| type | count | share | mean bytes/line |
|---|---:|---:|---:|
| pane.activity | 30,632 | 48.1% | 356 |
| llm.usage | 12,246 | 19.2% | 391 |
| trace.span | 8,950 | 14.1% | 649 |
| tool.activity | 5,010 | 7.9% | 375 |
| agent.activeTime | 2,579 | 4.1% | 253 |
| llm.cost | 1,916 | 3.0% | 331 |
| worktree.dirty | 727 | 1.1% | 748 |
| commit.landed | 668 | 1.0% | 822 |
| branch.updated | 417 | 0.7% | 317 |
| agent.status | 116 | 0.18% | 292 |
| 10 more types | 508 | 0.8% | 101–363 |

Sources: `tmux` 30,848 · `otel` 21,109 · `sessionlog` 9,592 · `git` 1,940 ·
`workmux` 116 · `judge` 27 · `system` 21.

`tool.activity` in *this* file carries no `filePath`; newer captures do
(`rhizomorph-5189ebfe/session-1786665720450.jsonl`: 4,095/4,095 `tool.activity`
payloads have `filePath`, and there are 9,708 `"filePath"` occurrences corpus-wide).
The generator uses the newer shape, because question (d) needs it.

**Generated corpus**: 10M rows, this mix (verified at N=20,000: 48.9% / 18.7% /
13.9% / 8.3% — within 1 pt of census), mean **437.6 bytes/row**, 4.40 GB text.
3 projects, 5 actors, 60 lanes, 30 days, ~20,000 distinct file paths.
`ts` is near-monotonic (append-order), which is what makes BRIN meaningful.
Window: 2026-07-17 → 2026-08-16, deliberately placed to split **5,000,000 /
5,000,000** across the July and August partitions [EXECUTED] so the DROP-vs-DELETE
comparison is on equal halves. `NOW` in all queries = `1786838400000` (max ts).

---

## Results

### Finding 1 — the partitioned UNIQUE wrinkle (first-class)

[EXECUTED], verbatim:

```
=== ATTEMPT 1: UNIQUE (project_id, actor_instance, event_id) — omits partition key ts ===
ERROR:  unique constraint on partitioned table must include all partitioning columns
DETAIL:  UNIQUE constraint on table "events" lacks column "ts" which is part of the partition key.
=== ATTEMPT 2: UNIQUE (project_id, actor_instance, event_id, ts) — includes partition key ===
ALTER TABLE
```

Three honest options:

| option | what it buys | what it costs |
|---|---|---|
| **(i) include `ts` in the key** | a real DB-enforced constraint, `ON CONFLICT` works | the key is `(project, actor, event_id, ts)` — it de-duplicates a *replay of the same bytes*, not a *re-send with a corrected ts*. A shipper that re-derives `ts` (clock skew, a re-parse, a timezone fix) inserts a duplicate and the constraint stays silent. |
| **(ii) dedup at ingest** | the natural key is honoured exactly | correctness moves out of the database into the shipper, and is only as good as its state. Concurrent shippers need shared state. |
| **(iii) hash-partition on `(project_id, actor_instance, event_id)`** | the true natural key is enforceable | forfeits range partitioning on `ts` — which is the entire retention story below (3.5 s vs 15.9 s, §Retention) and the pruning that makes query (a) 0.19 ms. |

**Pick (i), with (ii) as a narrow backstop.** The reason is that (iii) trades the
thing that measurably works for the thing that only theoretically breaks: partition
pruning and `DROP PARTITION` are worth 4.5× on retention and three orders of
magnitude on the recency query, and they are load-bearing for *every* org question,
whereas the (i) gap is confined to one failure mode — a re-send whose `ts` changed.
That mode is also the one a shipper can cheaply close: `ts` is assigned once at
capture and carried, never re-derived downstream. So the constraint catches the
common case (at-least-once redelivery of identical bytes) in the database where it
belongs, and the rarer case is closed by a shipper rule that is checkable in review.
Option (ii) alone was rejected because it leaves the database with no statement of
its own invariant at all, which is exactly how a schema drifts.

Cost of the constraint, measured: it is a btree over four columns, and its
per-partition index is in the same class as the others in the table below — but note
it does **not** make ingest idempotent for free; `ON CONFLICT DO NOTHING` on a
partitioned table needs the conflict target to name all four columns.

### Load and size

Loadavg 4.81 at COPY start, 5.12 at end.

| step | time | rate |
|---|---:|---:|
| generate 10M rows → 4.40 GB TSV (node) | **72.3 s** | 138k rows/s |
| `\copy events FROM STDIN`, **no indexes** | **68.4 s** | **146k rows/s, 64 MB/s** |
| `\copy` of 5M rows **with 5 indexes live** (reload step) | **103.3 s** | 48k rows/s |

Indexes cost **3.0×** on ingest (146k → 48k rows/s). That ratio is the claim; the
absolute figures carry `fsync=off`.

| object | size |
|---|---:|
| `events` heap, 10M rows | **5,099 MB** (2,549 + 2,550 per partition) |
| TOAST | **8 kB per partition** — i.e. nothing. No payload reached the TOAST threshold, so jsonb is stored inline and **uncompressed**. 4.40 GB of text became 5.10 GB of heap: **jsonb costs 16% more than the JSON text**, it does not save space at this payload size. |
| BRIN `(ts)`, `pages_per_range=32` | **360 kB** per partition (0.014% of heap) |
| btree `(project_id, lane)` | 34 MB per partition |
| btree `(type, ts)` | 196 MB per partition |
| btree `(lane, ts)` | 217 MB per partition |
| btree `(type, ts, project_id, (payload->>'costUsd')::numeric)` | 325 MB per partition |
| **all indexes** | **1,544 MB** (30% of heap) |

Index build times, on the loaded 10M-row table (loadavg 2.9–3.9):
BRIN **4.8 s** · `(project_id,lane)` **10.1 s** · `(type,ts)` **12.3 s** ·
`(lane,ts)` **9.4 s** · covering expression index **15.4 s**.

### The five org questions

Median of runs 2–4, warm. Loadavg 2.7–3.6 throughout.

| # | question | with BRIN+`(project_id,lane)` only | + `(type,ts)`, `(lane,ts)` | verdict vs 500 ms |
|---|---|---:|---:|---|
| a | lanes by latest `agent.status` per person, last 15 min | 1.92 ms | **0.19 ms** | PASS |
| b | `llm.cost` sum by project by day, 30 d | 1,001 ms | **1,007 ms** (worse) | **FAIL** |
| c | lanes whose latest status is `waiting` >30 min | 746 ms | **40.3 ms** | PASS |
| d | two actors on one `tool.activity` `filePath` within 24 h | 118 ms | **60.7 ms** | PASS |
| e | one ~60k-row session read, ingestion order | 899 ms | **452 ms** | PASS |

(d) returns real answers, not an empty set: **64 distinct paths** touched by >1 actor
in the 24 h window, top row `packages/core/src/fence126.ts`, 3 actors, 127 touches.

(e) is 60,092 rows for one lane over a 10.8-day window — matched deliberately to the
63,653-row real session. It needs `(lane, ts)`; `(project_id, lane)` cannot serve a
lane-only predicate.

**(b) is the one that fails, and it does not respond to indexing.** Its plan
[EXECUTED]:

```
Parallel Bitmap Heap Scan on events_2026_07 ... rows=42049
  Buffers: shared hit=10 read=107163      <- 838 MB
Parallel Bitmap Heap Scan on events_2026_08 ... rows=63060
  Buffers: shared read=107040             <- 836 MB
Execution Time: 863.926 ms
```

301,000 `llm.cost` rows are spread ~1.4 per 8 kB block across a 5.1 GB heap, so
answering a 90-row aggregate reads **1.67 GB**. The bitmap index scan itself is
39 ms; the other 820 ms is heap I/O for rows whose 437 useful bytes are 0.7% of what
gets moved. Two fixes were tested:

- **Covering expression index** `(type, ts, project_id, ((payload->>'costUsd')::numeric))`,
  325 MB/partition, built in 15.4 s, `VACUUM ANALYZE` run so the visibility map was
  current. The planner **never chose an index-only scan** — not with the index
  present alongside `(type,ts)` (863–1,010 ms), not with `(type,ts)` dropped so the
  covering index was the only candidate (866/975/1,010/998 ms), and not with
  `enable_seqscan=off, enable_bitmapscan=off, enable_sort=off` (854 ms, plain
  `Index Scan`, `width=379` — still fetching the heap tuple). **Covering the jsonb
  expression does not buy an index-only scan here.** [EXECUTED]
- **Materialised rollup.** `CREATE TABLE cost_daily AS SELECT project_id, day,
  sum(...)` — **2.04 s** to build, 90 rows, and the org question then answers in
  **0.13 ms** (median of 0.130 / 0.124 / 0.206). A 7,700× improvement over the
  best indexed form. [EXECUTED]

So the single-table-with-JSONB design answers 4 of the 5 questions under 500 ms with
ordinary btrees, and the fifth needs a projection — not a bigger index.

**Honest caveat on (a) and (c).** `agent.status` is 0.18% of the census, so it is
~18,000 of the 10M rows. These two queries are fast partly because the corpus is
emit-on-change. A fleet emitting a 30 s status heartbeat for 60 lanes over 30 days
would produce ~5.2M `agent.status` rows and would dominate the table. The census mix
was honoured as instructed; that is the sensitivity to check before trusting (a)/(c)
at 0.19 ms and 40 ms.

### Retention

Same 5,000,000 rows both ways. Partition total size at the time of the DROP:
**3,322 MB**; at the time of the DELETE: **3,916 MB** (an incrementally-built index
is less dense than one built after load — the 594 MB gap is that, not a measurement
error).

| approach | time | bytes returned to the OS | lock |
|---|---:|---:|---|
| `DROP TABLE events_2026_07` | **3.53 s** | **3,322 MB, immediately** (db 7,238 → 3,916 MB) | AccessExclusive, held for 3.5 s |
| `DELETE FROM events WHERE ts < <Aug-1>` | **7.2 s** | **0 MB** (db 7,831.7 → 7,831.7 MB) | row locks, MVCC bloat retained |
| … then `VACUUM (ANALYZE)` | +8.7 s | 2,549.8 MB (65% of the partition) | concurrent-safe |
| … then `VACUUM FULL` | +1.7 s | +1,365.6 MB → **3,915.4 MB total** | AccessExclusive |
| **DELETE path total** | **17.6 s** | 3,915.4 MB | needs an AccessExclusive window anyway |

**DROP is 5.0× faster than DELETE+VACUUM+VACUUM FULL and 2.5× faster than
DELETE+VACUUM alone, and it is the only one of the three that returns the bytes in
one step.** It is O(seconds) and, structurally, O(1) in row count — it unlinks files.

Two honest qualifications, both [REASONED]:
- The DELETE here is the **best case** for DELETE: every row in the partition
  matched, so `VACUUM` could truncate the heap outright. A retention DELETE that
  leaves live rows behind reclaims far less without `VACUUM FULL`, and `VACUUM FULL`
  rewrites the whole partition.
- `DELETE` at 7.2 s for 5M rows (694k rows/s) is flattered by `fsync=off` and by
  having no FKs or triggers. `DROP` is not — it is metadata plus `unlink`.

### RLS

Policies installed, both directions proven [EXECUTED]:

```
app_a: select project_id, count(*) from events group by 1
 rhizomorph | 3286868          <- one project only, of three
app_b: e-scene    | 3336518
app_a: select count(*) from events where project_id='e-scene'
 rows_visible = 0              <- explicit cross-project read returns nothing
app_a: insert ... ('e-scene', ...)
 ERROR:  new row violates row-level security policy for table "events"
app_a: insert ... ('rhizomorph', ...)
 INSERT 0 1
```

**Finding 2 — RLS bans `COPY FROM` outright.** [EXECUTED]

```
ERROR:  COPY FROM not supported with row-level security
HINT:  Use INSERT statements instead.
```

This is a hard blocker for the design as briefed, not a performance note: the 146k
rows/s bulk path is *unavailable* to any role a policy applies to. An RLS deployment
must ingest through a trusted role or a `SECURITY DEFINER` function that bypasses the
policy (and re-checks the tenant itself), or accept the `INSERT` path.

Ingest cost on the `INSERT … SELECT` path that RLS *does* allow, 500,000 rows into a
fresh partitioned table with the same five indexes, two rounds:

| | round 1 | round 2 |
|---|---:|---:|
| RLS **off** | 6.46 s | 7.26 s |
| RLS **on** (`WITH CHECK (project_id='rhizomorph')`) | 4.93 s | 5.07 s |

RLS-on was **faster in both rounds** (−24%, −30%). That is not a claim that RLS
speeds up ingest — it is a claim that **the RLS `WITH CHECK` cost is below the
run-to-run variance of this box**, which is ~12% between identical rounds. The
ordering was fixed (off always ran first after `TRUNCATE`), so some of the gap is
almost certainly warm-cache ordering, not the policy. Either reading puts the
overhead far under 20%.

Read path, same query as superuser (no policy) vs `app_a` (policy applied):
2.36 / 4.27 / 5.97 ms vs **1.28 / 1.62 / 2.26 ms**. Again no measurable penalty —
`project_id = 'rhizomorph'` is a cheap constant filter and does not disable index use.

---

## Falsifier verdicts

| falsifier | verdict | the number that decided it |
|---|---|---|
| **Any org question >500 ms at 10M rows post-index?** | **FAIL — one does** | (b) `llm.cost` by project by day over 30 d: **1,007 ms** median, floor **854 ms** even with seqscan and bitmapscan disabled. (a) 0.19 ms, (c) 40.3 ms, (d) 60.7 ms, (e) 452 ms all pass. The failure is heap I/O — 1.67 GB read to produce 90 rows — and a covering expression index does **not** fix it. A 2.04 s daily rollup does: **0.13 ms**. |
| **Partition-drop not O(seconds)?** | **PASS — it is O(seconds)** | `DROP TABLE events_2026_07` (5,000,000 rows, 3,322 MB): **3.53 s**, all bytes returned immediately. vs **17.6 s** and two lock windows for DELETE+VACUUM+VACUUM FULL. |
| **RLS ingest cost >20%?** | **PASS — under 20%** | RLS-on `INSERT…SELECT` of 500k rows was **4.93 s / 5.07 s** vs RLS-off **6.46 s / 7.26 s** — i.e. ≤0% overhead, against ~12% run-to-run variance. **But** see Finding 2: RLS makes `COPY FROM` impossible, which is a 3× ingest-path change that this percentage does not capture. |

**Overall answer to the brief's question.** Yes, with two amendments: one partitioned
`events` table with jsonb payloads answers four of the five org questions in
0.19–452 ms at 10M rows on ordinary btrees, and `DROP PARTITION` is workable
retention at 3.5 s. The cost rollup needs a materialised projection beside the
events table, and RLS needs an ingest path that is not `COPY`.

---

## What this did not test

- **Single machine, contended.** 6 cores / 15 GiB WSL2 slice with other fleet lanes
  running (loadavg 1.8–5.1, quoted per step). No replication, no network client, no
  connection pool. Client and server shared the box via `docker exec` stdin, so the
  COPY figure includes a docker pipe the real shipper would not use.
- **`fsync=off`, `synchronous_commit=off`.** Every write number is optimistic. The
  ratios (index cost 3.0×, DROP vs DELETE 5.0×, RLS ≤0%) are the durable claims.
- **Cold cache.** All query medians are warm (runs 2–4). Run 1 was consistently
  1.3–2.4× slower — e.g. (b) 1,954 ms, (e) 1,121 ms. A dashboard hitting a cold
  instance sees those, not the medians.
- **`agent.status` density.** Honoured the census (0.18%), which is emit-on-change.
  A heartbeat-emitting fleet inverts the type mix and would change (a) and (c)
  materially. Not modelled.
- **No concurrency at all.** Every query ran alone. No ingest-during-query, no
  multiple readers, no lock contention against the 3.5 s AccessExclusive that
  `DROP PARTITION` takes.
- **Payload realism ceiling.** Generated payloads use the real key sets and hit the
  census's mean sizes, but no payload exceeded the TOAST threshold, so **the TOAST
  and compression path was never exercised**. A real `pane.activity` preview or a
  large `trace.span` attribute bag would change the size and the heap-I/O numbers for
  (b) and (e) in the wrong direction.
- **`jsonb_path_ops` GIN was never built.** Question (d) reached 60.7 ms with a plain
  `(type, ts)` btree and a `GROUP BY` on `payload->>'filePath'`, so by the brief's own
  rule ("only if a query needs it") no query needed it. The untested sibling is the
  *point lookup* — "who else touched this exact path" — which a GIN or an expression
  index on `(payload->>'filePath')` would serve and which none of the five questions
  asked for.
- **The UNIQUE constraint was never load-tested.** Its refusal and its accepted form
  were executed on an empty table; the 10M-row load ran without it, so its ingest cost
  and its `ON CONFLICT` behaviour under duplicate replay are unmeasured.
- **Multi-month retention.** 30 days spans two partitions. Nothing here says what
  `DROP` costs at 24 monthly partitions, nor what the planner does with pruning at
  that count.
- **RLS with more than one policy per role**, policy on a non-partition-key column,
  or `FORCE ROW LEVEL SECURITY` against the table owner. Not tested.

---

## Reproduction

Throwaway lives at `~/rhizomorph-spikes/schema/` (scripts kept; the 4.40 GB
`events.tsv` and `rz.tsv` were deleted at cleanup — regenerate with `gen.js`).

```bash
cd ~/rhizomorph-spikes/schema

# 1. server
docker run -d --name rz-spike-schema-pg --shm-size=2g \
  -p 127.0.0.1:5434:5432 -e POSTGRES_PASSWORD=spike -e POSTGRES_DB=spike \
  -v rz-spike-schema-pgdata:/var/lib/postgresql/data postgres:16-alpine \
  -c shared_buffers=1GB -c work_mem=64MB -c maintenance_work_mem=1GB \
  -c max_wal_size=8GB -c checkpoint_timeout=30min -c fsync=off -c synchronous_commit=off
# ./psql.sh is: docker exec -i -e PGPASSWORD=spike rz-spike-schema-pg psql -U postgres -d spike "$@"

# 2. census (read-only against the real data dir)
F=~/.local/share/rhizomorph/worktrees-challenge-71202028/session-1785739192605.jsonl
jq -r '.type' $F | sort | uniq -c | sort -rn
jq -rc '[.type,(.|tostring|length)]|@tsv' $F | \
  awk -F'\t' '{s[$1]+=$2;n[$1]++} END{for(t in s) printf "%-22s n=%-7d mean=%d\n",t,n[t],s[t]/n[t]}'

# 3. schema + the UNIQUE wrinkle
./psql.sh -v ON_ERROR_STOP=1 -q < ddl.sql
./psql.sh -c 'ALTER TABLE events ADD CONSTRAINT k UNIQUE (project_id, actor_instance, event_id);'      # ERROR
./psql.sh -c 'ALTER TABLE events ADD CONSTRAINT k UNIQUE (project_id, actor_instance, event_id, ts);'  # ok
./psql.sh -c 'ALTER TABLE events DROP CONSTRAINT k;'

# 4. 10M rows + timed COPY
node gen.js > events.tsv                     # 72 s, 4.40 GB
S=$(date +%s.%N); ./psql.sh -q -c "\copy events FROM STDIN" < events.tsv; \
  E=$(date +%s.%N); echo "COPY $(echo "$E-$S"|bc) s"

# 5. indexes, then queries (q.sh runs each 4x warm; median of last 3 is the claim)
./psql.sh -c "CREATE INDEX events_ts_brin ON events USING brin (ts) WITH (pages_per_range=32);"
./psql.sh -c "CREATE INDEX events_proj_lane ON events (project_id, lane);"
./psql.sh -c "CREATE INDEX events_type_ts  ON events (type, ts);"
./psql.sh -c "CREATE INDEX events_lane_ts  ON events (lane, ts);"
./psql.sh -c "ANALYZE events;"
./psql.sh -t -c "select lane,count(*) from events group by 1 order by 2 desc limit 1;" | awk '{print $1}' > lane.txt
./q.sh

# 6. rollup that fixes question (b)
./psql.sh -c "CREATE TABLE cost_daily AS SELECT project_id,
  (to_timestamp(ts/1000) AT TIME ZONE 'UTC')::date d,
  sum((payload->>'costUsd')::numeric) usd, count(*) n
  FROM events WHERE type='llm.cost' GROUP BY 1,2;"

# 7. RLS  (rls.sql, rls-ingest.sql)
./psql.sh -q -v ON_ERROR_STOP=1 < rls.sql
docker exec -i -e PGPASSWORD=a rz-spike-schema-pg psql -h 127.0.0.1 -U app_a -d spike \
  -c "select count(*) from events where project_id='e-scene';"                       # 0
docker exec -i -e PGPASSWORD=a rz-spike-schema-pg psql -h 127.0.0.1 -U app_a -d spike \
  -c "insert into events values ('e-scene','x@y','smuggled',1786000000000,'agent.status','workmux','l','/w','{}');"
                                                                                     # RLS violation
./psql.sh -q -v ON_ERROR_STOP=1 < rls-ingest.sql   # then COPY-as-app_a -> "COPY FROM not supported with RLS"

# 8. retention
./psql.sh -c "select pg_database_size('spike');"
time ./psql.sh -c "DROP TABLE events_2026_07;"                    # 3.53 s
# reload July, then:
time ./psql.sh -c "DELETE FROM events WHERE ts < 1785542400000;"  # 7.2 s, 0 bytes back
time ./psql.sh -c "VACUUM (ANALYZE) events_2026_07;"              # 8.7 s, 2549.8 MB back
time ./psql.sh -c "VACUUM FULL events_2026_07;"                   # 1.7 s, 1365.6 MB more

# 9. cleanup  [EXECUTED — verified empty]
docker rm -f rz-spike-schema-pg
docker volume rm rz-spike-schema-pgdata
docker ps -a --format '{{.Names}}' | grep rz-spike   # no output
docker volume ls -q               | grep rz-spike    # no output
```

The real data dir was only ever read (`jq`, `find`, `grep`). No writes to
`~/.local/share/rhizomorph`, no writes to `~/rhizomorph`, no credentials on disk
(the two throwaway role passwords lived only inside a container that no longer
exists), no `langfuse-*` container or port touched, ports used: `127.0.0.1:5434`
only.
