-- 0001_events — the events table (prd-51 ruling 5).
--
-- The events table is the rebuildable truth: every projection in 0002 is a fold
-- over these rows and can be dropped and rebuilt from them. Nothing else in this
-- schema is authoritative.
--
-- ============================================================================
-- THE RULING 4 / RULING 5 COLLISION — flagged here, NOT resolved here
-- ============================================================================
--
-- Ruling 4 specifies `INSERT ... ON CONFLICT (project, actor_instance, n) DO
-- NOTHING`. That statement cannot be written against this table, and the reason
-- is captured verbatim in docs/research/2026-08-28-shared-record-s4-schema.md,
-- Finding 1:
--
--     ERROR:  unique constraint on partitioned table must include all partitioning columns
--     DETAIL:  UNIQUE constraint on table "events" lacks column "ts" which is part of the partition key.
--
-- Three honest options, from that note:
--
--   (i)   include `ts` in the key — a real DB-enforced constraint and a working
--         upsert, but the key becomes (project, actor, n, ts), which de-duplicates
--         a replay of the same bytes and not a re-send with a corrected `ts`.
--   (ii)  dedup at ingest — the natural key is honoured exactly, but correctness
--         moves out of the database into the shipper.
--   (iii) hash-partition on the natural key — enforceable, but forfeits range
--         partitioning on `ts`, which is the whole retention and pruning story.
--
-- The spike recommended (i). Ruling 5 instead states the natural key cannot exist
-- and assigns dedup to ingest, i.e. (ii). Both cannot be followed, and this
-- migration follows the issue that commissioned it: the Definition of done
-- enumerates this schema and its four indexes and names no unique constraint.
--
-- The deferral is cheap and reversible in exactly the way the alternative is not.
-- Migrations are append-only, so the ingest lane can add `0004_events_unique.sql`
-- without touching this file, whereas an unwanted constraint would need a second
-- migration to drop it and would have been enforcing the wrong invariant in
-- between. It is the ingest issue's ruling to make.
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
