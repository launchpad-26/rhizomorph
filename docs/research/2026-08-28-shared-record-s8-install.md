# s8-install: how close is "one command on a fresh VPS"?

Build area: `~/rhizomorph-spikes/install/` (compose.yml, app/server.js, Caddyfile,
migrations/, init.sh, drill.log, backup.sql — all throwaway, cleaned at end).
Box: WSL2 Ubuntu, i9-13900H 20c/31GiB, docker 29.7.1. Other lanes were active
throughout (loadavg 4.9–7.2 across the run; see per-step notes).

## What ran

Stack: `postgres:16-alpine` (named volume) + a 30-line inline `node:22-alpine`
app (npm-installs the `pg` driver on boot, runs `/migrations/*.sql` idempotently
via a tracked `_migrations` table, serves `/healthz`, `POST /api/events`
(bearer-keyed insert), `GET /api/summary`) + `caddy:2` reverse-proxying to the
app on `:8443` with `tls internal`. `init.sh` generates `.env` (random
32-byte-hex postgres password, one `rzk_`-prefixed ingest key printed once) and
runs `docker compose up -d`.

1. Cold up (images pulled fresh for `node:22-alpine` + `caddy:2`; `postgres:16-alpine`
   was warm from another lane's live container sharing this box's image cache —
   see gaps) → healthz green.
2. Insert 3 rows via `POST /api/events` (bearer auth, no SQL typed).
3. `pg_dump` to file.
4. `down` (keep volume) → `up`: verify data survives.
5. Full `down -v` → fresh `up` → restore from dump → verify.
6. Migration drill: add `migrations/002_add_col.sql`, `compose restart app`,
   verify column + data.
7. Full cleanup: `down -v`, confirmed zero `rz-spike-install-*` containers/volumes.

One real deviation from the brief: host port 5435 (my assigned postgres port)
was already bound by an unrelated lane's stray process (`~/rhizomorph-spikes/shipper`'s
`proxy.mjs`) for the full duration of this drill — confirmed via `ss -ltnp` to
a `node proxy.mjs` process, not a leftover of mine. I did not kill another
lane's process. All timed runs below used `HOST_PG_PORT=5436` (compose.yml
takes the override via `${HOST_PG_PORT:-5435}`; default stays 5435). This has
no bearing on the falsifiers — it's a box-sharing artifact, not a defect in the
stack.

## Results

| Step | Wall time | Notes |
|---|---|---|
| Cold `init.sh` → containers created | 12.6 s | `node`+`caddy` pulled fresh (~48 MB total layers); `postgres` warm |
| → healthz green (first 200) | **14.2 s** total from init.sh start | 4th poll attempt, 0.5s interval |
| Insert 3 rows (3× `POST /api/events`) | <1 s combined | all `201`, zero SQL typed |
| `pg_dump` | instant | 127-line plain-SQL dump, 3 `COPY` rows |
| `down` (keep vol) → `up` → healthy | 14.7 s | data intact: 3/3 rows, unchanged ids/timestamps |
| Full `down -v` → `up db` → restore → `up` (app+caddy) → healthy | 18.0 s | 3/3 rows restored, **zero errors** (see fix below) |
| Migration drill: add `002_add_col.sql`, `compose restart app` → healthy | 12.7 s | column present, 3/3 rows, `source='unknown'` backfilled by `DEFAULT` |
| Cleanup (`down -v`) | instant | verified zero `rz-spike-install-*` containers/volumes remain |

Two real bugs found and fixed during the drill (not cosmetic — both would have
broken a genuine "one command" fresh-VPS run):

1. **`node_modules` named volume under a read-only bind mount fails outright.**
   `./app:/app:ro` + a volume at `/app/node_modules` → `OCI runtime create
   failed: ... read-only file system` trying to create the mountpoint. Fixed by
   dropping `:ro` from the app source mount. [EXECUTED] — first cold-up attempt
   died here, second attempt (after the fix) succeeded.
2. **`tls internal` on a bare `:8443` site address plus a SNI-less client
   (curl → literal IP) → TLS handshake fails with `internal error`, no useful
   HTTP-level error.** Root cause via `debug` Caddy logs: Caddy issued certs for
   `127.0.0.1` and `localhost` (from an explicit `https://127.0.0.1:8443,
   https://localhost:8443` site block) but the incoming ClientHello had no SNI,
   so cert selection fell back to matching the *container's internal IP*
   (`172.19.0.4`), which has no cert → `no certificate available for
   '172.19.0.4'`. Fixed with a global `default_sni 127.0.0.1` option. [EXECUTED]
   — reproduced the exact failure (`tls.handshake` debug log line), applied the
   fix, reproduced the 200. This is specific to IP-only access without a real
   domain; a real VPS with a real hostname and Caddy's automatic ACME path
   would not hit it — flagging it here because the brief's local drill is
   IP-only by construction.

Restore had a third, non-blocking finding: taking the `pg_dump` *before* the
`down -v`, then restoring into a DB the app had already auto-migrated on boot,
produced `duplicate key` / `already exists` errors (schema recreated by both
migration-on-boot and the dump) and required one hand-typed `TRUNCATE` to
force through — a falsifier-relevant failure. Redone correctly: `up db` alone,
restore into the still-empty database, *then* `up app caddy` — zero errors,
zero hand-typed SQL, migration's `_migrations` guard sees `001_init.sql`
already present in the restored dump and skips it. **The correct restore
order is db-first, app-second**, not "bring the whole stack up then restore."
An install runbook that says "restore the dump" without that ordering will
reproduce the noisy failure.

## Falsifier verdicts

- **Cold-up > 20 min?** **PASS.** 14.2 s init-start-to-healthz-green
  [EXECUTED, drill.log]. Even the very first (failed) attempt only cost 17 s
  before erroring — nowhere near the 20-minute bar. Caveat: this run's
  `postgres:16-alpine` pull was warm (shared cache with another lane's live
  container I could not remove); a genuinely all-cold three-image pull on this
  box's link speed would add low-single-digit seconds based on the ~48 MB
  node+caddy pull taking ~10 s of the 12.6 s create phase — still far under
  the bar. [REASONED extrapolation for the postgres leg only]
- **Any step requiring a hand-typed SQL command?** **PASS, with a caveat
  logged.** The final, correct drill path (insert via API, dump via `pg_dump`,
  restore via `psql < file`, migrate via SQL *files* the app applies itself)
  required zero hand-composed SQL. The *first* restore attempt did require one
  (`TRUNCATE ... RESTART IDENTITY`) because of the ordering bug above — logged
  as a real failure mode, not swept under the rug, and fixed by reordering
  rather than by adding SQL. [EXECUTED, both attempts in drill.log]
- **Restore losing a row?** **PASS.** 3/3 rows present after full `down -v` →
  restore, same `id`/`payload`/`created_at` values as before destruction.
  [EXECUTED]
- **Migration needing downtime?** **PASS, with a precise caveat.** No manual
  intervention, no lock ceremony, no separate migration step — `compose
  restart app` alone applies it. There IS an unavoidable ~12.7 s window where
  the single app container is unreachable (a `restart`, not a rolling update)
  — that is downtime in the literal sense (single instance stops before it
  starts), but it is not the kind of downtime the falsifier is probing for
  (a migration requiring extra manual steps beyond a normal deploy). If
  "downtime" is read strictly as "any request fails during rollout," this is
  UNRESOLVED for anyone running single-instance without a second app replica
  or a maintenance page — worth deciding which reading matters before this
  becomes a real runbook claim. [EXECUTED for the mechanics, REASONED for the
  strict-downtime interpretation]

## What this did not test

- **Real TLS / real DNS.** `tls internal` was exercised (and its IP-only SNI
  failure mode found and fixed), but Caddy's automatic-HTTPS-via-ACME path
  against a real domain was not — that needs a real VPS with a public IP and
  DNS record.
- **Single-machine artifact:** the `default_sni` fix was needed only because
  this drill accesses Caddy by bare IP with no hostname. A real deployment
  reached by domain name would send SNI normally and might never hit this
  failure mode at all — so its severity outside this spike is unclear without
  testing the real-domain path.
- **Concurrent load / multi-replica.** One app container throughout; the
  "migration needing downtime" question is genuinely open for a
  multi-replica or zero-downtime-deploy setup, which this spike doesn't have.
- **Backup integrity beyond structural restore.** Verified 3 rows round-trip
  correctly; did not test a large dataset, a dump taken mid-write, or
  corruption/truncation of the dump file.
- **The five items below**, per the brief — each is a real gap only a real
  VPS answers:

| Remainder | Est. operator-minutes | Why local can't answer it |
|---|---|---|
| DNS + real TLS (Caddy auto-HTTPS via ACME) | 5–15 min | needs a public IP + A/AAAA record propagation; `tls internal` sidesteps ACME entirely |
| GitHub OAuth callback URL | 2–5 min | needs a stable public HTTPS origin to register with GitHub's OAuth app settings |
| Ingress firewall (ufw/security-group rules) | 5–10 min | no real network perimeter in a container-only local drill |
| Unattended upgrades (host OS patching cadence) | 5 min setup, ongoing | no host OS lifecycle in a WSL2 container sandbox |
| Backup destination off-box (S3/rsync target) | 10–15 min | `pg_dump > file` proves the mechanics; shipping it off the box needs real credentials/destination this spike explicitly may not touch |

Total realistic remainder: **~30–50 operator-minutes** beyond what `init.sh`
covers, concentrated in one-time account/DNS/network setup rather than
anything the drill above showed as fragile.

## Reproduction

```
cd ~/rhizomorph-spikes/install
HOST_PG_PORT=5436 ./init.sh        # use 5436 if 5435 is taken on a shared box; omit for the real default
# poll: curl -sk https://127.0.0.1:8443/healthz
curl -sk -X POST https://127.0.0.1:8443/api/events \
  -H "Authorization: Bearer $(grep INGEST_KEY .env | cut -d= -f2)" \
  -H "Content-Type: application/json" -d '{"payload":"x"}'
docker compose exec -T db pg_dump -U rhizomorph rhizomorph > backup.sql
docker compose down            # keep volume
docker compose up -d
docker compose down -v         # full destroy
docker compose up -d db
docker compose exec -T db psql -U rhizomorph -d rhizomorph < backup.sql
docker compose up -d           # app + caddy
cp migrations-staged/002_add_col.sql migrations/  # migration drill
docker compose restart app
docker compose down -v         # cleanup
```
