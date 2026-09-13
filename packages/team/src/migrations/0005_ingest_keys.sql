-- 0005_ingest_keys — the machine plane, at rest (prd-51 ruling 8).
--
-- Ruling 8: "`rzk_` ingest keys: 32 random bytes, stored only as SHA-256, shown
-- once at mint, scoped to one project, revoked by a row flag checked once per
-- batch -- which bounds revocation lag to one batch interval."
--
-- Four columns, and the interesting one is the one that is absent.
--
-- 1. NO PLAINTEXT COLUMN, EVER. "Stored only as SHA-256" is the whole clause,
--    and it is the clause an implementation loses by adding a second column
--    "for support". `key_hash` is the primary key: the hot path looks a key up
--    by its own digest, so the natural key IS the only key, and there is no
--    second thing to store. `schema-law.test.ts` case 31 asserts this table's
--    column list exactly, and asserts over the WHOLE schema that any column
--    whose name mentions a key ends in `_hash` -- so the mutation that plants
--    `plaintext text` here, or `ingest_key text` anywhere, goes red.
--
-- 2. THE INDEX EARNS ITS PLACE, and it is the first index in this schema that
--    is not on `events`. `key_hash` is the primary key and serves the once-per-
--    batch read. `ingest_keys_by_project` serves the only OTHER access path
--    there is: revoking a project's keys, which is what makes the runbook's
--    rotation procedure actual revocation rather than housekeeping. A primary
--    key on the digest cannot serve a project-scoped update, and that update
--    runs on every boot.
--
-- 3. ENABLE ROW LEVEL SECURITY, BUT DELIBERATELY NOT FORCE -- and this is the
--    line to read before copying 0003's four-line block. 0003's own header
--    records the behaviour, measured on PostgreSQL 18.4:
--
--        plain owner, FORCE ON   -> sees none
--        plain owner, FORCE off  -> sees every project's rows
--
--    The app connects as the database OWNER (`RZ_TEAM_DATABASE_URL` in
--    packages/team/deploy/init.sh names the `rhizomorph` user), and the
--    once-per-batch read is the app's, not `rz_ingest`'s, until a later wave
--    splits the connection. A FORCE here with no policy would therefore deny
--    the server its own key check and refuse every batch as an unknown key --
--    fail-closed, but closed against the operator rather than against an
--    attacker. ENABLE alone is still worth having: no viewer role is granted
--    anything on this table, and RLS with no policy denies anyone who later is.
--
-- 4. THE `rz_ingest` GRANT LIVES HERE, NOT IN AN EDIT TO 0003. 0003 gives
--    `rz_ingest` INSERT on `events` and nothing else; the per-batch check needs
--    SELECT on this table. Migration files are tracked and checksummed
--    (`runner.ts`'s plan phase refuses a run whose recorded checksum differs),
--    and 0001's header records that the one legal retroactive edit has been
--    spent. So a new migration is the only path, and this is it.
--
--    No SELECT for `rz_viewer` or `rz_readonly`. A viewer has no reason to read
--    key digests, and a digest is a credential's shadow rather than a fact about
--    a project.
--
-- No CONCURRENTLY: `applyMigration` runs each file inside one transaction, the
-- same decision 0001 and 0004 record.

CREATE TABLE IF NOT EXISTS ingest_keys (
  key_hash text PRIMARY KEY,
  project_id text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS ingest_keys_by_project ON ingest_keys (project_id);

ALTER TABLE ingest_keys ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON ingest_keys TO rz_ingest;
