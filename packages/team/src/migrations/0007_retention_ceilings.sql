-- 0007_retention_ceilings — the admin's ceiling, at rest (prd-51 rulings 9 and 10).
--
-- Ruling 9: "the organisation admin may name ceilings: how long raw events are
-- kept per project, and a storage quota per project ... Every effective value on
-- the server names who set it and where."
--
-- Ruling 10: "The server never invents an age. With no ceiling named, partitions
-- accumulate ... with a ceiling named by the admin, the fold worker drops whole
-- monthly partitions past it. ... An archive of the partition before the drop is
-- the admin's choice, made once at ceiling time, never silently."
--
-- Seven columns, and the interesting fact is the row that is absent.
--
-- 1. THERE IS NO DEFAULT AGE AND NO SEED ROW, AND THAT IS THE MIGRATION'S WHOLE
--    POINT. `max_age_days` carries no DEFAULT, nothing inserts here at boot, and
--    an empty table is the state this schema ships in. An empty table means
--    NOTHING IS EVER DROPPED -- the server did not invent an age, because there
--    is nowhere for an age it invented to live. A DEFAULT 30 here would be a
--    thirty-day retention policy nobody typed, applied to every project, and
--    discoverable only by reading this file; prd-51's success 6 names that state
--    as the falsifier in as many words.
--
-- 2. `set_by` AND `source` ARE NOT NULL, WHICH IS RULING 9 WRITTEN INTO THE
--    SCHEMA. A ceiling that cannot say WHO named it and WHERE is not storable at
--    all: the column is NOT NULL, so the refusal is the database's and not a
--    convention some later caller can forget. `packages/team/deploy/ceiling.ts`
--    is the only thing that writes here, and it refuses to guess either value.
--
-- 3. `archive_dir` IS THE ONE NULLABLE COLUMN, and it is nullable because
--    `archive_before_drop = false` has no directory to name. The pair is the
--    admin's choice recorded ONCE, at ceiling time -- ruling 10's clause. The
--    sweep reads it and never asks again, and it never drops a partition the
--    admin asked to have archived first: this server does not archive, because
--    ruling 11's lifecycle is "a different act on a different machine and is not
--    triggered by anything the server decides".
--
-- 4. ENABLE ROW LEVEL SECURITY, DELIBERATELY NOT FORCE, AND NO GRANT TO ANY
--    ROLE. This follows `0005_ingest_keys.sql`'s reasoning exactly and for the
--    same measured reason: the app connects as the database OWNER
--    (`RZ_TEAM_DATABASE_URL` in packages/team/deploy/init.sh names the
--    `rhizomorph` user), and 0003's own header records that a plain owner under
--    FORCE with no policy sees nothing -- so a FORCE here would deny the server
--    the ceiling read the sweep exists to make.
--
--    No role is granted anything at all. A retention ceiling is an admin fact:
--    `rz_ingest` never reads it (it appends events and nothing else), and a
--    viewer has no reason to learn another project's retention policy. That
--    absence is also what keeps both clauses of `schema-law.test.ts`'s RLS law
--    green BY DERIVATION rather than by an exemption -- not FORCEd, so the
--    forced-with-no-policy clause is silent; no non-bypassing reader, so the
--    readable-with-no-policy clause is silent. Grant a viewer SELECT here
--    without also writing a policy and the second clause names this table.
--
-- 5. NO INDEX. `project_id` is the primary key, and the only two access paths
--    are "read them all" (the sweep, once per drain, over a table with one row
--    per project) and "upsert one" (the host command). `schema-law.test.ts`
--    case 20 pins the whole schema's index set by table and by body; an index
--    here would redden it, correctly, and there is nothing to add.
--
-- 6. THE DROP IS NOT IN THIS FILE. Dropping a partition is a runtime act under a
--    named ceiling, not a schema change: it lives in
--    `packages/team/src/storage/ports/retention/sql.ts`, which is the only
--    module in the package that may carry the statement, and it is reached only
--    through `sweepRetention` in `packages/team/src/fold/worker.ts`.
--
-- No CONCURRENTLY and no DDL that needs its own transaction: `applyMigration`
-- runs each file inside one, the same decision 0001, 0004, 0005 and 0006 record.

CREATE TABLE IF NOT EXISTS retention_ceilings (
  project_id text PRIMARY KEY,
  max_age_days integer NOT NULL CHECK (max_age_days > 0),
  archive_before_drop boolean NOT NULL,
  archive_dir text,
  set_by text NOT NULL,
  source text NOT NULL,
  set_at timestamptz NOT NULL
);

ALTER TABLE retention_ceilings ENABLE ROW LEVEL SECURITY;
