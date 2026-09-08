-- 0002_projections — the three projections (prd-51 ruling 5).
--
-- Required, not optional. `events` is the rebuildable truth; these three are
-- what the org's three questions read — where is work, what does it cost, who
-- is stuck. The spike measured the cost question at 820 ms of heap I/O against
-- the events table with the best index it could be given, and 0.13 ms against a
-- materialised rollup: a 7,700x difference
-- (docs/research/2026-08-28-shared-record-s4-schema.md). That is why these are
-- tables rather than views.
--
-- Maintaining them is the fold worker's job (wave 3). Creating them is this
-- migration's, and nothing here folds anything.
--
-- The columns are the minimum the three questions need. When a later wave needs
-- more, it APPENDS a new migration — this file is never edited, because a
-- checksum change on an applied migration is a refusal by design.

CREATE TABLE IF NOT EXISTS spend_by_project_day (
  project_id text           NOT NULL,
  day        date           NOT NULL,
  cost_usd   numeric(18,6)  NOT NULL DEFAULT 0,
  events     bigint         NOT NULL DEFAULT 0,
  updated_at timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, day)
);

CREATE TABLE IF NOT EXISTS lane_state (
  project_id     text        NOT NULL,
  lane           text        NOT NULL,
  state          text        NOT NULL,
  worktree       text,
  last_event_ts  timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, lane)
);

CREATE TABLE IF NOT EXISTS collisions (
  project_id text        NOT NULL,
  path       text        NOT NULL,
  lanes      text[]      NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen  timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, path)
);
