# s3-localstore: does the local instrument need a database?

Lane s3-localstore, prd-48 (PR #141). Box: WSL2 Ubuntu, i9-13900H, 31 GiB,
`node v22.23.2`. `nproc` inside this shell reports 6 (not the full 20 cores —
noted, not investigated further). loadavg at test time: `5.18, 2.78, 1.31`
(other lanes sharing the box, per brief).

## What ran

Data: `~/.local/share/rhizomorph/worktrees-challenge-71202028/session-1785739192605.jsonl`,
the largest single session log on the box (26,325,198 bytes, 63,653 lines),
copied out to `~/rhizomorph-spikes/localstore/session.jsonl`. Schema per line:
`{id, ts, source, type, payload}`; 30,701 of 63,653 events (48%) carry
`payload.lane`, spread across 51 distinct lanes.

Three engines, same task: read `session.jsonl`, build a lane index (distinct
lanes, per-lane event count, per-lane max `ts`), report load/build time, query
time, cold-open time, and size on disk.

1. **none** — `baseline.js`: `readline` + `JSON.parse` into an array, then a
   `Map`-based lane aggregation. Run fresh (cold) and then re-aggregated over
   the same in-memory array (warm — models prd-44's parse-cache hit, where a
   repeat read is free because the parsed events are already resident).
2. **node:sqlite** — `sqlite_load.js` / `sqlite_query.js`. `node:sqlite`
   (`DatabaseSync`) is available in this node build **without**
   `--experimental-sqlite`; it still prints an `ExperimentalWarning` on
   `require`, so the flag is not required but the feature is not stable.
   Schema: `events(id TEXT, ts INTEGER, type TEXT, lane TEXT, payload TEXT)`
   with `CREATE INDEX idx_lane ON events(lane)`, loaded row-by-row inside one
   transaction via a prepared statement.
3. **@electric-sql/pglite** — `pglite_load.js` / `pglite_query.js`, v0.5.8,
   installed fresh with `npm install @electric-sql/pglite` (only dependency in
   `node_modules`). Same schema (`BIGINT` for `ts`), same one-row-at-a-time
   load inside a single `BEGIN`/`COMMIT`, same aggregation query translated to
   Postgres SQL (`SELECT lane, COUNT(*), MAX(ts) ... GROUP BY lane ORDER BY
   count DESC`).

Rebuild proof (step 4): both engines' store directories/files were deleted and
rebuilt from `session.jsonl`, then re-queried; results below are from the
*rebuilt* stores, and top-5 lanes were diffed against baseline's top-5 —
identical for all three engines (see Results).

All timings below are `[EXECUTED]`, 3 fresh-process runs per engine, via
`/usr/bin/time -f "wall=%es"` wrapping each `node <script>.js` invocation
(process-level, includes node startup) plus in-process `process.hrtime.bigint()`
splits (phase-level, excludes node startup). Commands are in **Reproduction**.

## Results

### Phase-level timings (in-process, excludes node startup), 3 fresh-process runs each

| Engine | Load/build (once) | Cold-open (fresh process) | Query (lane-index) | Cold-open + query |
|---|---|---|---|---|
| none (baseline, cold read+parse) | n/a (read *is* the load) | n/a | 252–266 ms (read+parse+aggregate) | 252–266 ms |
| none (warm, parse-cache-equivalent) | n/a | n/a | 3.9–5.9 ms (aggregate only, no re-read) | 3.9–5.9 ms |
| node:sqlite | 493–556 ms (63,653 row-by-row inserts, 1 txn) | 0.15–0.27 ms | 12.0–21.6 ms | 12.1–21.9 ms |
| @electric-sql/pglite | 17,306–18,458 ms (63,653 row-by-row inserts, 1 txn, async wasm) | 278–345 ms | 66–126 ms | 345–471 ms |

### Process-level wall clock (`/usr/bin/time`, includes node startup), 3 runs each

| Engine | Wall clock, cold-open+query |
|---|---|
| none (cold read+parse+aggregate) | 0.28–0.31 s |
| node:sqlite (cold-open+query) | 0.03–0.05 s |
| @electric-sql/pglite (cold-open+query) | 0.45–0.50 s |

### Footprint / size on disk

| Engine | node_modules | store size on disk | store format |
|---|---|---|---|
| none | 0 (no dependency) | 0 (no store; source log is 26 MB, already counted as input) | n/a |
| node:sqlite | 0 (built into node 22.23.2) | 32,428,032 bytes (32.4 MB) `events.sqlite` | single file |
| @electric-sql/pglite | 26 MB | 102 MB `pgdata/` | directory (full Postgres data dir) |

### Correctness (rebuild proof)

All three engines' lane index agree exactly on top-5 lanes by event count after
delete-and-rebuild, e.g. top-1: `159-connective`, count 3170, lastTs
1785811844231 — byte-identical across baseline / sqlite / pglite outputs.
51 distinct lanes reported by all three.

## Falsifier verdicts

1. **"PGlite cold start >1 s or footprint >30 MB?"** → **PASS** (neither
   triggers, but footprint is close). Cold start (process open to first query
   result, in-process `hrtime`) measured 278–345 ms, well under 1 s; full
   process wall clock (node startup included) 0.45–0.50 s, also under 1 s.
   `node_modules` footprint is 26 MB, under the 30 MB line — but that excludes
   the on-disk store, which is 102 MB for this 26 MB source log (≈4x). If
   "footprint" is meant to include the running store rather than just the
   package, this falsifier reads as **borderline/context-dependent** — flagging
   rather than silently picking the reading that passes.

2. **"Is any engine's lane-index query actually faster than the warmed
   parse-cache baseline?"** → **FAIL** (no). Warmed baseline aggregation is
   3.9–5.9 ms — the fastest of anything measured here. node:sqlite's query
   alone is 12.0–21.6 ms (~3–4x slower than warm baseline); pglite's is
   66–126 ms (~15–25x slower). Both databases are faster than baseline's
   *cold* path (252–266 ms) because they skip re-parsing 63k lines of JSON —
   but neither beats the case prd-44 already ships, which is exactly "don't
   re-read, don't re-parse, keep it in memory."

## What this did not test

- **Windows-native gap: untested here.** This entire spike ran on WSL2 Ubuntu.
  `node:sqlite` and `better-sqlite3`-style native modules, and pglite's wasm
  build, may all behave differently under native Windows node (path handling,
  native module prebuild availability, wasm memory ceilings) — none of that is
  covered by anything above.
- Single machine, single run of the box's actual load (loadavg ~5 during
  timing, other lanes active) — no isolated/idle-box baseline was captured to
  separate "engine cost" from "box contention cost." The 3-run spread per
  engine is small enough (baseline ±14ms, sqlite ±9ms, pglite ±67ms on cold
  open) that contention doesn't look dominant, but this wasn't controlled for.
- Load/insert path used naive row-by-row `INSERT` in both databases, not
  bulk/batch loading (e.g. sqlite's `.exec` with multi-row VALUES, or COPY-style
  bulk load for pglite). pglite's 17–18s load number in particular is almost
  certainly dominated by per-statement wasm round-trip overhead, not an
  inherent property of the engine — a batched load would likely look very
  different and this spike doesn't have that number.
- Only one query shape was tested (distinct lanes / count / max ts, unindexed
  by ts). No range queries, no joins, no concurrent-writer scenario, no
  crash-recovery/WAL behavior under kill -9, no multi-process concurrent
  access — all of which matter more than this one aggregate for a real local
  instrument.
- No measurement of update/append cost (appending new events to an existing
  store vs the full rebuild-from-scratch tested here), which is closer to the
  instrument's actual write pattern than a one-shot bulk load.
- Only one session log (26 MB, 63,653 lines) was used; no scaling curve across
  smaller/larger logs, so the size/time numbers above are one data point, not
  a trend line.

## Reproduction

Throwaway lives at `~/rhizomorph-spikes/localstore/` (not tracked in the repo).

```
# setup (already done)
cd ~/rhizomorph-spikes/localstore
cp ~/.local/share/rhizomorph/worktrees-challenge-71202028/session-1785739192605.jsonl session.jsonl
npm install @electric-sql/pglite

# 1. baseline (none)
node baseline.js session.jsonl

# 2. node:sqlite
node sqlite_load.js session.jsonl events.sqlite
node sqlite_query.js events.sqlite

# 3. pglite
node pglite_load.js session.jsonl ./pgdata
node pglite_query.js ./pgdata

# 4. rebuild proof
rm -f events.sqlite && node sqlite_load.js session.jsonl events.sqlite && node sqlite_query.js events.sqlite
rm -rf pgdata && node pglite_load.js session.jsonl ./pgdata && node pglite_query.js ./pgdata

# process-level wall clock
/usr/bin/time -f "wall=%es" node <script>.js <args>
```
