# 0035. The watcher is never a container; the team server always is

- **Status:** proposed (with prd-51; becomes accepted when prd-51 is blessed)
- **Date:** 2026-09-03

## Context and Problem Statement

`docs/research/2026-08-07-docker-and-distribution.md` asked for a container ruling and none was
written. `docs/metamorphosis/system-design.md` stated the direction — *"Never containerize the
watcher"*; Docker is *"stage 3, for the server"* — as direction, not law. prd-51 now builds the
second thing that could be containerised, so the ruling is needed once, on the record, before two
deployables exist with two different answers nobody wrote down.

The two programs are different species. The local instrument **observes a machine**:
`~/.claude/projects`, the repo, its worktrees, tmux, the `git` binary, the member's home directory
layout. The team server **observes nothing**: it accepts an authenticated batch, journals it, folds
it into Postgres and serves pages. prd-48's S8 spike ran the server shape — one image + Postgres +
Caddy — from `init.sh` to healthz in 14.2 s, drilled backup and restore, and applied a live
migration (`docs/research/2026-08-28-shared-record-s8-install.md`).

## Considered Options

- **A — Containerise both.** One packaging story. The watcher's bind mounts must then enumerate
  every path it observes, on every host layout, and tmux and git must be reachable through a
  container wall.
- **B — Containerise neither.** The team server becomes a Node process an admin installs by hand
  beside a Postgres they install by hand, with the restore ordering and migration discipline
  living in a runbook rather than an image.
- **C — Containerise the server and never the watcher.** Two packaging stories, each matching
  what the program is.

## Decision Outcome

Chosen: **C**.

- **The local instrument is never containerised.** It runs on the host it observes, as the
  neighbours that observe a filesystem do and the neighbours that receive data do not. A container
  wall between the watcher and what it watches is bind-mount sprawl for negative value. Electron is
  the local packaging story (prd-30's territory), and it is orthogonal to this record.
- **The team server is always a container**, one image, with Postgres and Caddy beside it in one
  `compose.yml`. Migrations are SQL files the app applies on boot, tracked in `_migrations`.
  `init.sh` generates secrets and prints the first ingest key exactly once. It is identical on a
  member's spare box, a VPS or a cluster; what changes at scale is what sits behind the ingest API,
  not the image.

**A was rejected** because the watcher's value is in reading the host as the host is, and every
mount the container needs is a place the packaging can be wrong on a machine the author never
saw. **B was rejected** by S8's own drill: the one ordering rule it discovered — restore into the
empty database *before* the app's first boot, or the migration-on-boot collides with the dump —
is exactly the kind of fact that survives in an image and dies in a runbook.

## Consequences

**Good.** "Install the team server" has one meaning and one timed drill (prd-51 wave 4).

**Good.** The Trust section can keep saying the local instrument runs on your machine and reads
your files, because it does.

**Bad.** The admin runs Docker. On a $5 VPS that is the expected cost; on a member's spare box it
may not be, and a one-binary alternative with embedded Postgres was named in the design brief
(§8, "S8b") and not spiked. Open, not ruled.

**Bad.** A single app container restarts for a migration: 12.7 s of unreachability in S8's drill.
Zero-downtime deploys need a second replica or a maintenance page, and neither is v1.

**Neutral.** Nothing here decides *where* the container runs. Self-host-anywhere is the
requirement; a managed cloud is a separate product decision priced on its own.
