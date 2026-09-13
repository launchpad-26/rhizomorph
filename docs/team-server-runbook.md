# Team server runbook

`packages/team` — one image, Postgres and Caddy, from `init.sh` (prd-51 ruling 13,
`docs/adr/0035-the-watcher-is-never-a-container.md`). This document is the operator's
copy of that ruling: what the host needs, how to boot it, and — the load-bearing part —
what order restore must run in.

## Prerequisites

The host needs exactly three things:

- Docker, with the Compose plugin (`docker compose`, not the standalone `docker-compose`).
- `bash`.
- `openssl`.

Nothing else. Node and `tsx` live only inside the image Docker builds — the host that
runs `init.sh` before any container exists does not need Node installed.

## First boot

```
cd packages/team/deploy
RZ_TEAM_PROJECT=<project-id> ./init.sh   # generates secrets, prints the ingest key ONCE — save it now
docker compose build
docker compose up -d
docker compose ps                        # wait for all three services healthy
```

`RZ_TEAM_PROJECT` names the project the first ingest key is scoped to — a key is valid
for exactly one project (prd-51 ruling 8), and a batch shipped to any other is refused
with *"wrong project"*. It defaults to `default`, which is a real project id and not a
placeholder: whatever is set here is the value `rhizomorph connect team --project` must
be given.

`init.sh` is idempotent by the presence of the deploy directory's `.env` file (generated,
gitignored, never tracked): running it again on a host that already has one prints a
one-line confirmation and touches nothing. The
ingest key is generated once and printed once, to standard output, on the run that
creates `.env`.

**Only the key's SHA-256 is stored — never the key.** The plaintext exists on your
terminal and nowhere else: `.env` carries `RZ_TEAM_INGEST_KEY_SHA256`, the app is given
that digest, and the `ingest_keys` table has no column that could hold a key. So there is
nothing to recover from the host, from a backup, or from an image layer. If the value is
lost, "Rotating the ingest key" below mints a new one and revokes the old.

## Second boot / redeploy says so

Migrations run on boot, from the SQL files tracked under `packages/team/src/migrations/`
against the `_migrations` table. A boot that finds nothing new to apply says so rather
than looking identical to one that silently did nothing — `docker compose logs app` on
any `up` after the first shows a line in this shape (`packages/team/deploy/report.ts`):

```
migrations: 0 applied, 5 already applied (0001_events, 0002_projections, 0003_roles_rls, 0004_events_dedup, 0005_ingest_keys) — nothing to do
```

A boot that actually applied something shows the count and the names in the `applied`
half instead, and omits "nothing to do". If a redeploy's log shows "0 applied" when you
expected new migrations to run, that is real information — check the deployed code
actually carries the migration file you expect.

## Restore ordering — read this before you ever restore anything

**Restore runs into the empty database before the app's first boot against it.** This
is not a preference; it is a hard ordering requirement discovered and reproduced during
the S8 install spike
(`docs/research/2026-08-28-shared-record-s8-install.md`).

The reversed order — the app boots and applies its migrations first, and the dump is
restored afterward — produces `duplicate key` / `already exists` errors, because
migration-on-boot and the restored dump both try to create the same schema objects and
rows. Ruling 13 states the ordering explicitly for exactly this reason.

The correct sequence, restoring `backup.sql` into a fresh deployment:

```
docker compose up -d postgres
docker compose exec -T postgres pg_isready -U rhizomorph   # wait for healthy
docker compose exec -T postgres psql -U rhizomorph -d rhizomorph < backup.sql
docker compose up -d app caddy
```

Postgres comes up alone, and only after it reports healthy does the dump go in — into an
empty database, before the app (and its on-boot migrations) has ever touched it. Only
then do `app` and `caddy` start.

Wave 6's drill is what times and proves this sequence on the real host. This runbook
states the ordering; it does not itself constitute the drill.

**A plain `pg_dump` of this schema is not a complete restore on its own, even in the
right order.** Executed while building this deployment: restoring a `pg_dump` taken
after migrations had run, into a genuinely fresh Postgres container (no prior roles),
produced **16 `role ... does not exist` errors across three roles** —
`rz_viewer` ×8, `rz_readonly` ×4, `rz_ingest` ×4 — and **all 12 of the dump's `GRANT`
statements are among the failures** (4 tables × the 3 roles each is granted on). The
row-level-security policies in migration `0003_roles_rls.sql` name `rz_viewer` and
`rz_readonly` directly in `CREATE POLICY ... TO rz_viewer, rz_readonly` (Postgres reports
only the first missing role per statement, which is why `rz_viewer` alone accounts for
half the total), and `rz_ingest` appears only in the `GRANT` statements. Roles are
cluster-level objects a per-database dump does not carry. A database restored this way
ends up with its schema and data intact but **no privileges granted to any of the three
application roles** — not a partial restore so much as a restore with the access layer
missing.

This is a different failure from the ordering collision above (no `duplicate key` or
`already exists` appeared, and every data-restoring statement succeeded) — it is a gap in
what "restore" means for this schema, not a ruling-13 ordering violation. It is documented
here rather than fixed: a complete fix exists in principle (restore the three roles first,
e.g. with `pg_dumpall --globals-only` before the schema/data restore above) and could be
written into this same runbook without touching anything outside it, but building and
proving that restore path is backup work, and "backups are parked" below already states
that no complete, proven recovery story exists for this deployment yet. This paragraph
exists so an operator who does attempt a restore knows precisely what they get, rather
than discovering the missing grants live.

## Backups are parked

**No off-VPS backup destination exists.** A database dump written to this same VPS is
not a backup — it fails alongside whatever destroys the VPS. There is no recovery story
for this deployment until an off-VPS destination is provisioned. Do not read the restore
procedure above as a working backup story: it documents how a restore must be ordered
*if* a dump exists, not that a reliable way to produce and keep one exists today.

## The Linode account

The Linode account this VPS runs on belongs to the academy, not the cohort. The team
holds root on the machine itself but not the account it runs under — the instance can be
resized, rebuilt or removed without notice, and that cannot be fixed from inside the
machine.

## What is not wired up yet

Bringing the image up is not the same as the ingest pipeline being end-to-end. Two
things are deliberately unbuilt:

- **The fold worker is not started.** The ingest route durably accepts and journals
  batches, but nothing folds them into Postgres's `events` table or the projections yet
  — the journal grows and nothing reads it.
- **There is no `doctor` for the team server yet.** Nothing in this deployment should be
  read as implying one exists.

Minting a key **from the team viewer** is also not here, because the viewer is not: the
one key this deployment holds is the one `init.sh` seeds. That is a narrowing of ruling
8's *"a member mints a key in the viewer"*, not a gap in the verification below.

## Rotating the ingest key

```
cd packages/team/deploy
rm .env
RZ_TEAM_PROJECT=<project-id> ./init.sh   # mints a new key, prints it once, stores only its digest
docker compose up -d                     # NOT `restart` — see below
```

**This is revocation, and it is enforced.** The boot that follows seeds the new digest
and revokes every other key the project held, by setting a row flag. A shipper still
configured with the old value is refused from its next batch with a 403 naming the reason
— *"revoked key"* — rather than silently continuing to be accepted.

Three things worth knowing before you run it:

- **`docker compose up -d`, not `docker compose restart app`.** `restart` re-runs the
  container with the environment it was created with; it does not re-read `.env`. A
  rotation followed by a `restart` leaves the server seeded with the OLD digest, so the
  key you just wrote down is refused and the one you meant to retire still works.
- **The revocation lag is one batch interval.** The row flag is read once per batch
  (ruling 8), so a batch already in flight when the boot happens completes; every batch
  after it is refused.
- **Pass the same `RZ_TEAM_PROJECT`.** A key is scoped to one project. Rotating under a
  different project id mints a key for that other project and leaves the original
  project's key live, which is not what "rotate" means.

To revoke without minting a replacement — a key you believe is compromised, with no
shipper to re-key yet — there is no command for that today: it is a row update against
`ingest_keys`, and a mint-and-revoke path from the viewer is wave 7's.
