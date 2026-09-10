-- 0001_events — the events table (prd-51 ruling 5).
--
-- The events table is the rebuildable truth: every projection in 0002 is a fold
-- over these rows and can be dropped and rebuilt from them. Nothing else in this
-- schema is authoritative.
--
-- ============================================================================
-- THE RULING 4 / RULING 5 COLLISION — RESOLVED
-- ============================================================================
--
-- EDITING AN APPLIED MIGRATION IS LEGAL EXACTLY ONCE, AND THIS WAS IT.
-- `checksumOf` hashes the whole file INCLUDING these comments, and the runner's
-- plan phase refuses any run where a recorded checksum differs. No database has
-- applied 0001 anywhere: the package stands up no Postgres, and the ingest lane
-- meets a real host in wave 4. So there is no _migrations row to invalidate,
-- and this is the last commit in which that is true. Do not read this edit as
-- precedent — from here on the collision-record-and-supersede path is a new
-- numbered migration, exactly as 0002's own header already says.
--
-- What was ruled (docs/prds/prd-51-the-split.md, the amendment of 2026-09-08 —
-- cited, not restated; the two rejected options and their measured failures
-- live there):
--
--   1. Ruling 4's clause is UNCHANGED. `INSERT ... ON CONFLICT
--      (project_id, actor_instance, n) DO NOTHING` stands exactly as written.
--      What changed is the relation it is aimed at: the fold inserts into the
--      partition covering the batch's ts, never into this parent. Against a
--      partition the targeted inference finds that partition's own unique index
--      and behaves as ruling 4 intends.
--
--   2. The unique index lives on EACH PARTITION, added by 0004_events_dedup.sql
--      for the partitions this file's DO block created and by
--      `buildMonthlyPartitionDdl` for every partition made after it. Ruling 5's
--      sentence is amended to "the natural unique key cannot exist on the
--      partitioned table; it exists on each partition" — the original
--      observation was true of the parent and was read as true of the design.
--      The error below is still the reason it cannot live here.
--
--   3. THE INVARIANT THIS RESTS ON, which nothing stated before the amendment:
--      the same (project_id, actor_instance, n) always carries the same ts.
--      Per-partition uniqueness cannot see across a partition boundary, so a
--      shipper that ever recomputed ts rather than reading it from the event
--      line would silently break dedup at every month boundary, with no error
--      anywhere. It holds by construction today — ts is read from the line, and
--      n addresses that line — and it is written down here because dedup
--      depends on it.
--
-- The error that makes the key impossible on this table, quoted verbatim from
-- docs/research/2026-08-28-shared-record-s4-schema.md, Finding 1:
--
--     ERROR:  unique constraint on partitioned table must include all partitioning columns
--     DETAIL:  UNIQUE constraint on table "events" lacks column "ts" which is part of the partition key.
--
-- ============================================================================
-- Four decisions inside this file, each with its reason
-- ============================================================================
--
-- 1. `ts` is `timestamptz`, not `bigint`. Core's `ts` is epoch milliseconds
--    (packages/core/src/events/common.ts, `timestampSchema`) and the adapter
--    converts. Monthly RANGE bounds, ruling 10's partition drop under a date
--    ceiling, and `spend_by_project_day`'s day grouping all need a date type;
--    milliseconds to microseconds is lossless, and the byte-fidelity claim rests
--    on `line`, not on `ts`.
--
-- 2. `pages_per_range = 32` is the spike's measured value: 360 kB per partition,
--    0.014 % of heap (docs/research/2026-08-28-shared-record-s4-schema.md).
--
-- 3. No covering expression index. Same note: the covering form
--    `(type, ts, project_id, ((payload->>'costUsd')::numeric))` was built,
--    VACUUM ANALYZEd, and "the planner never chose an index-only scan" — not
--    alongside `(type, ts)`, not with `(type, ts)` dropped, and not with
--    `enable_seqscan=off`. The fifth org question needs a projection, not a
--    bigger index, and 0002 is that projection.
--
-- 4. No CONCURRENTLY anywhere. `applyMigration` runs each file inside one
--    transaction, and CREATE INDEX CONCURRENTLY cannot run in one.
--    `schema-law.test.ts` holds this so the next author discovers it at
--    `npm test` rather than at 3 a.m. on a live box.
--
-- `event_id` is stored and is never a key: it appears in no index, no PRIMARY
-- KEY, no ON CONFLICT and no WHERE. That is wave 1's finding — event ids restart
-- on session resume and keying on one discarded 74.5 % of a real ledger — carried
-- across the package boundary.

CREATE TABLE IF NOT EXISTS events (
  project_id     text        NOT NULL,
  actor_instance text        NOT NULL,
  n              bigint      NOT NULL,
  event_id       text        NOT NULL,
  ts             timestamptz NOT NULL,
  type           text        NOT NULL,
  source         text        NOT NULL,
  lane           text,
  worktree       text,
  payload        jsonb       NOT NULL,
  line           text        NOT NULL
) PARTITION BY RANGE (ts);

-- The monthly window: last month through twelve months ahead, fourteen
-- partitions. It is a window and not a promise — `TeamStorage.ensureMonthlyPartition`
-- is the top-up path, and wave 3 schedules it. A range-partitioned table with no
-- partition for an incoming `ts` rejects the insert, so the window has to be
-- maintained rather than merely created.
DO $$
DECLARE
  m     date := date_trunc('month', now())::date - interval '1 month';
  stop  date := date_trunc('month', now())::date + interval '12 months';
BEGIN
  WHILE m <= stop LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      'events_' || to_char(m, 'YYYY_MM'),
      m,
      (m + interval '1 month')::date
    );
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS events_ts_brin      ON events USING brin (ts) WITH (pages_per_range = 32);
CREATE INDEX IF NOT EXISTS events_project_lane ON events (project_id, lane);
CREATE INDEX IF NOT EXISTS events_type_ts      ON events (type, ts);
CREATE INDEX IF NOT EXISTS events_lane_ts      ON events (lane, ts);
