-- 0004_events_dedup — the natural key, on each partition (prd-51 ruling 4).
--
-- Cited, not restated: docs/prds/prd-51-the-split.md, the amendment of
-- 2026-09-08, "the fold's dedup targets the partition, not the parent". The two
-- rejected options and their measured failures live there. Two server errors
-- from that amendment are quoted here because they are what this file exists to
-- answer, and a reader who only has this file should see them:
--
--     ERROR:  unique constraint on partitioned table must include all partitioning columns
--     DETAIL:  UNIQUE constraint on table "events" lacks column "ts" which is part of the partition key.
--
--     ERROR:  there is no unique or exclusion constraint matching the ON CONFLICT specification
--
-- The first says the key cannot live on the parent. The second says ruling 4's
-- clause, aimed at the parent, does not execute. Ruling 4's clause is unchanged;
-- what changed is the relation it targets. Each partition carries the unique
-- index, and the fold inserts into the partition covering the batch's ts.
--
-- Why this is a DO block over pg_inherits rather than a list of CREATE INDEX
-- statements: 0001 built its partitions in a loop from now(), so which
-- partitions exist depends on when 0001 ran. There is no list to write.
--
-- No CONCURRENTLY. `applyMigration` runs each file inside one transaction and
-- CREATE INDEX CONCURRENTLY cannot run in one — the same decision 0001 records
-- as its fourth, and `schema-law.test.ts` holds it over every tracked file.
--
-- No event_id, here or anywhere. Ruling 5 stores it and never keys it, and the
-- amendment names the cost of doing otherwise: with a SECOND unique index on
-- the partition, an untargeted ON CONFLICT DO NOTHING silently dropped a row
-- carrying a brand-new (project_id, actor_instance, n), which is the gap in n
-- ruling 3 forbids, created with no error emitted anywhere.
--
-- Partitions created AFTER this migration get the same index from
-- `buildMonthlyPartitionDdl` in packages/team/src/storage/postgres.ts, which
-- emits the table and its index together. A partition without the index accepts
-- no targeted upsert at all, so the two must never be created apart.

DO $$
DECLARE
  part text;
BEGIN
  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'events'::regclass
    ORDER BY c.relname
  LOOP
    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (project_id, actor_instance, n)',
      part || '_pos_uq',
      part
    );
  END LOOP;
END $$;
