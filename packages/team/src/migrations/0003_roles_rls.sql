-- 0003_roles_rls — roles and row-level security (prd-51 ruling 5, last bullet).
--
-- The ingest writer is its own role and bypasses RLS on writes; every viewer
-- role sits behind per-project RLS. Those two facts are the whole of this file,
-- and `schema-law.test.ts` reads them back — including the one that makes
-- per-project isolation fiction if it is ever broken: no role granted SELECT on
-- `events` may also carry BYPASSRLS.
--
-- BYPASSRLS is a role ATTRIBUTE and granting it requires a superuser. Standing
-- the database up with a superuser that can run this is ruling 13's deployment
-- half, which is wave 3's (`init.sh`). This migration only expresses the policy.
--
-- Which connection sets `rhizomorph.project_id`, and how it is proven to match
-- the authenticated caller, is also wave 3's. A policy that reads a setting
-- nobody sets denies everything, which is the safe direction to be incomplete in.
--
-- WHO RLS DOES NOT CONSTRAIN, measured on PostgreSQL 18.4 rather than reasoned,
-- because the answer is not the intuitive one:
--
--   superuser owner, FORCE off  -> sees every project's rows
--   superuser owner, FORCE ON   -> sees every project's rows, UNCHANGED
--   plain owner,     FORCE ON   -> sees none
--   plain owner,     FORCE off  -> sees every project's rows
--
-- FORCE ROW LEVEL SECURITY is set below and is worth setting: it closes the
-- plain-owner case. It does NOT close the superuser case, and nothing in SQL
-- does -- a superuser bypasses RLS unconditionally. Since the header above says
-- this file is applied by a superuser, the isolation guarantee therefore rests
-- on a deployment fact this migration cannot enforce: **wave 3 reads as
-- `rz_viewer` or `rz_readonly`, never as the owner and never as a superuser.**
-- Stated here rather than left implicit, because the failure mode is a later
-- reader assuming ENABLE ROW LEVEL SECURITY covers everybody.
--
-- `rz_viewer` and `rz_readonly` are deliberately identical today: same policy
-- membership, same grants, same predicate. `rz_readonly` exists for the
-- agent-parsable noticeboard read (ruling 5) and may later become unscoped for
-- backups or analytics; scoping it per project now is the conservative default,
-- and if the two ever diverge it is that change's job to say how.
--
-- CREATE ROLE has no IF NOT EXISTS before PG 16, so each is wrapped in a
-- DO block that swallows `duplicate_object`. Re-running this file is then a
-- no-op even outside the `_migrations` guard — which matters, because a partial
-- restore or a hand-run is exactly when someone re-runs it.

DO $$ BEGIN
  CREATE ROLE rz_ingest NOLOGIN BYPASSRLS;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE ROLE rz_viewer NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE ROLE rz_readonly NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_by_project_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE lane_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE collisions ENABLE ROW LEVEL SECURITY;

-- FORCE applies the policies to the table OWNER too. `rz_ingest` is not the
-- owner and carries BYPASSRLS, so its writes are unaffected -- EXECUTED under
-- FORCE. See the header for what FORCE does and does not reach.
ALTER TABLE events FORCE ROW LEVEL SECURITY;
ALTER TABLE spend_by_project_day FORCE ROW LEVEL SECURITY;
ALTER TABLE lane_state FORCE ROW LEVEL SECURITY;
ALTER TABLE collisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_by_project ON events;
CREATE POLICY events_by_project ON events
  FOR SELECT TO rz_viewer, rz_readonly
  USING (project_id = current_setting('rhizomorph.project_id', true));

DROP POLICY IF EXISTS spend_by_project_day_by_project ON spend_by_project_day;
CREATE POLICY spend_by_project_day_by_project ON spend_by_project_day
  FOR SELECT TO rz_viewer, rz_readonly
  USING (project_id = current_setting('rhizomorph.project_id', true));

DROP POLICY IF EXISTS lane_state_by_project ON lane_state;
CREATE POLICY lane_state_by_project ON lane_state
  FOR SELECT TO rz_viewer, rz_readonly
  USING (project_id = current_setting('rhizomorph.project_id', true));

DROP POLICY IF EXISTS collisions_by_project ON collisions;
CREATE POLICY collisions_by_project ON collisions
  FOR SELECT TO rz_viewer, rz_readonly
  USING (project_id = current_setting('rhizomorph.project_id', true));

GRANT INSERT ON events TO rz_ingest;

-- SELECT here is not a widening for reading's sake: PostgreSQL requires it on
-- every column named in a WHERE clause and on the existing row that
-- `ON CONFLICT ... DO UPDATE` reads. A projection is maintained by exactly that
-- upsert, so INSERT and UPDATE without SELECT is a role that cannot perform the
-- write it exists for -- `permission denied for table spend_by_project_day`,
-- EXECUTED, and controlled by restoring and re-revoking the grant. `events`
-- needs no SELECT: ingest appends to it and never reads it back, which is why
-- that grant above stays INSERT-only.
GRANT SELECT, INSERT, UPDATE ON spend_by_project_day, lane_state, collisions TO rz_ingest;
GRANT SELECT ON events, spend_by_project_day, lane_state, collisions TO rz_viewer, rz_readonly;
