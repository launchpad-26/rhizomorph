# prd-51 — the upgrade drill on a real host

**Tree:** `origin/main` at `d70902a0`

**Ran:** 2026-09-17T22:22:38Z → 2026-09-17T22:47Z, on the live team host (`<team-host>`), by the
operator at the keyboard with an agent reading the output. **#171**, absorbing **#567**.

Every figure below is **EXECUTED** unless the line says REASONED. Commands and their real output,
not paraphrase. Host identifiers are substituted per the table at the bottom; nothing here names a
real machine or a real person's home.

---

## What this drill could NOT evidence, first

Recorded before the results, because a capture that leads with its wins and buries its gaps is the
shape this programme keeps finding in its own instruments.

**1. "Three routes before and eight after" — the delta was already spent.** The host at
`6dca7018` already served all eight. Measured both sides:

```
$ curl -s https://<team-host>/no-such-route
{"error":"no route \"/no-such-route\"; this server serves POST /v1/rhizomorph/ingest,
GET /auth/github/start, GET /auth/github/callback, GET /v1/rhizomorph/where,
GET /v1/rhizomorph/cost, GET /v1/rhizomorph/stuck, GET /v1/rhizomorph/keys,
POST /v1/rhizomorph/keys"}
```

Byte-identical before and after the upgrade. The 75 commits between `6dca7018` and `d70902a0`
**add no routes**. The 3→8 jump happened at an earlier upgrade, before this issue was re-scoped to
the upgrade path.

**2. "One migration against a populated database" — NOT met.** An earlier claim that the
2026-09-17 `0006`/`0007` run satisfied this was **withdrawn during the drill** on measurement:

```
 relname              | n_live_tup
----------------------+------------
 _migrations          |          7
 ingest_keys          |          2
 events               |          0     (and all 12 partitions: 0)
 collisions           |          0
 lane_state           |          0
 retention_ceilings   |          0
 spend_by_project_day |          0
```

`0007_retention_ceilings` acts on event partitions. Applied over **zero events** it is not
meaningfully distinguishable from a fresh schema for the thing it touches.

**3. "Backup and restore verified by digest" — would be vacuous, so it was not run.** A digest
comparison across empty tables proves the mechanism executed, not that it preserved anything. Same
root cause as 2. A backup **was** taken before the upgrade (`pg_dump --format=custom`, plus a copy
of `.env`), as the safety net it is; it is not offered as evidence of restore.

**4. `wrong-project` — the fourth ingest refusal was not reached.** It needs a key minted for a
second project, which needs the mint surface and a project that does not exist on this host. Named
here rather than substituted for, which is the failure this drill exists to correct (see §4).

**5. The three sign-in `reason` values were NOT exercised — and this omission is the one the
issue was widened to prevent.** #171's Definition of done requires `no-such-membership`,
`credential-rejected` and `network-error` distinguished on the real host. That bullet was
*deliberately moved into #171* on 2026-09-16, because #514's own drill ran on an isolated stack
built without GitHub App credentials and the item would otherwise have been dropped when #514
closed. This drill did not reach it: it needs a member, a non-member and a pending invitee against
the real GitHub org, which is a different act from anything above. **Caught by review, not by the
author.** It needs a home before #171 closes.

**6. The runbook was not corrected.** #171 requires *"the runbook is corrected against what
actually happened, in the same commit as the capture that falsified it."* `docs/team-server-runbook.md`
is untouched here. The two prose findings moved into #171 from #565 — the post-restore `nothing to
do` line, and `rls enabled/forced: true / true` printed beside `policies on events: 0` — could not
be re-measured, because no restore ran (gap 3). Their own grooming note calls them *"findings from
one afternoon at `cfbaf6c7`, not standing facts."* Skipping the edit is defensible; **not recording
that it was considered was not**, and that is corrected here.

**7. A genuinely fresh provision remains owed.** Untouched by this drill and unchanged from the
2026-09-17 re-scope: this host was provisioned 2026-09-15 and carries its own state.

---

## 1. The upgrade — EXECUTED, timed

| | |
|---|---|
| start | **2026-09-17T22:33:40Z** |
| all containers healthy | **2026-09-17T22:35:45Z** |
| elapsed | **2m 05s** |
| from | `6dca7018` (prd-51 wave-12 merge) |
| to | `d70902a0` |
| behind by | **75 commits** |
| diff | 103 files, +10,304 / −1,278 |

```
$ git pull --ff-only origin main
Updating 6dca7018..d70902a0
Fast-forward
 103 files changed, 10304 insertions(+), 1278 deletions(-)
```

**On the count: it was 71 in the baseline comment, and that was wrong by the time the pull ran.**
`git rev-list --count 6dca7018..d70902a0` is **75**; 71 is the count to `d70902a0^^`, correct when
taken at `22:28:05Z` and stale by `22:33:40Z`, because `main` moved four commits in between and the
pull took all of them. Caught at review. It is the same shape as the near-miss in section 3 — a
figure that still looks right against a range it no longer describes — and unlike that one it
reached the document. The conclusion is unaffected: 75 commits add no routes just as 71 do.

**The `--ff-only` succeeding is itself a finding**: the host carried no local modifications. A
deployment that has been hand-edited would have refused here.

**Honest qualifier on the 2m 05s.** The build inside that window was interrupted once and re-run,
so the figure covers a partial build plus a largely-cached rebuild, **not a cold build**. A cold
`docker compose build` on this host was not timed.

```
$ docker compose up -d
 ✔ Container deploy-postgres-1  Healthy    1.5s
 ✔ Container deploy-app-1       Healthy    7.3s
 ✔ Container deploy-caddy-1     Running    0.0s
```

```
$ docker compose ps
deploy-app-1        deploy-app             app        Up 20 seconds (healthy)
deploy-caddy-1      caddy:2-alpine         caddy      Up 28 hours
deploy-postgres-1   postgres:18.4-alpine   postgres   Up 22 hours (healthy)
```

### The team view answers, gated — EXECUTED

#171's title asks for *"a working team view"*, and three healthy containers are not that. The
request the title implies:

```
$ curl -s -o /tmp/where.json -w 'HTTP %{http_code}\n' https://<team-host>/v1/rhizomorph/where
HTTP 401
<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rhizomorph</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<h1>rhizomorph</h1><p>Sign in to see this. Start at /auth/github/start.</p></body></html>
```

**401 with a real page, not a bare status.** The member gate is serving, which is more than the 404
enumeration proves — that shows a route *registered*, this shows it *live and gating*. What it does
not show is a member getting through it; that is gap 5, and the honest reading of this line is
"the view is reachable and refuses correctly", not "a member reached it".

**`postgres` was not recreated.** That matters: the 2026-09-17 incident's first defect was a new
password minted against a volume that ignores it. An upgrade that leaves the database container
alone cannot reproduce it.

## 2. The doctor, before and after — the measurement that replaces the route table

**8 checks → 11.** The three new ones are #581's, and this is **the first time they have run
against a real database** rather than a scratch cluster.

Before (`6dca7018`), abbreviated — all `ok`, exit 0:

```
[ok  ] database / migrations / partition window / ingest key /
       GitHub App / journal directory / fold cursor / fold tick
All checks passed.
```

After (`d70902a0`) — the three additions, verbatim:

```
[ok  ] role catalog: all 3 rz_ roles the migrations create exist in pg_roles
       (rz_ingest, rz_readonly, rz_viewer), out of 20 roles in the cluster
[ok  ] row level security: 6 tables enable it; 4 carry a policy in pg_policy
       (collisions, events, lane_state, spend_by_project_day); ingest_keys and
       retention_ceilings carry no policy, which is the deny-all their migrations
       declare rather than a gap — nothing outside the owner and a BYPASSRLS role
       may read them
[ok  ] viewer membership: rhizomorph is a member of rz_viewer (granted by
       0006_viewer_role_membership), so a read may SET LOCAL ROLE rz_viewer and
       the per project policies apply to it
```

Exit 0. Three findings worth naming:

- **The RLS check distinguishes deny-all-by-design from a gap**, on real catalogs. That is the
  clause-A/clause-B logic #581 needed two review rounds to get right, confirmed outside a fixture.
- **`viewer membership` passes**, so `0006`'s `GRANT … WITH INHERIT FALSE` — measured on a scratch
  PostgreSQL 18.4 — does what it was measured to do on the actual deployment.
- **#592's warning-counting summary is present but UNEXERCISED.** Nothing warned, so the line still
  reads `All checks passed.` and is correct. This drill does not evidence that fix.

## 3. Rotation on a live host — prd-51's largest open gap, CLOSED

**The claim that had no test.** #591 shipped `./init.sh --rotate-ingest-key` on the strength of an
incident capture plus unit tests: the docker daemon was down on both the building and the verifying
machine, so **nothing had ever booted a container against a rotated `.env`**.

Two rotations were run, at `22:41:32Z` and `22:45:05Z`. After each, `docker compose up -d`.

**All three conditions hold:**

| claim | evidence |
|---|---|
| no variable lost | **12 names before, the same 12 after** — the 2026-09-17 incident destroyed six |
| database untouched | `postgres` **`Up 22 hours`**, never recreated |
| **container boots on a rotated `.env`** | app **recreated, healthy**, both times |

The variable list, names only, identical either side:

```
POSTGRES_DB, POSTGRES_PASSWORD, POSTGRES_USER, RZ_TEAM_DATABASE_URL,
RZ_TEAM_GITHUB_APP_ID, RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH, RZ_TEAM_GITHUB_CLIENT_ID,
RZ_TEAM_GITHUB_CLIENT_SECRET, RZ_TEAM_GITHUB_INSTALLATION_ID, RZ_TEAM_GITHUB_ORG,
RZ_TEAM_INGEST_KEY_SHA256, RZ_TEAM_PROJECT
```

**A near-miss worth recording, because it is this programme's own defect class.** The first version
of that check was `grep -oE '^[A-Z_]+=' .env`, which excludes any name containing a digit — so it
silently dropped **`RZ_TEAM_INGEST_KEY_SHA256`**, the one variable a rotation actually rewrites. It
returned 11 names and looked right. Caught before it became a claim, but only just: a check
reporting success while measuring the wrong thing is exactly what #592, #596 and #598 each fixed
elsewhere. The corrected pattern is `^[A-Z0-9_]+=`.

**Revoke and mint are atomic — FIVE consecutive times, to the millisecond:**

```
 hash_prefix  |         created_at         |         revoked_at
--------------+----------------------------+----------------------------
 7a81ac9e6473 | 2026-09-15 04:06:09.225+00 | 2026-09-17 01:05:27.659+00
 22e80e66632c | 2026-09-17 01:05:27.659+00 | 2026-09-17 22:41:32.02+00
 38101850b472 | 2026-09-17 22:41:32.02+00  | 2026-09-17 22:45:05.47+00
 bbb24bbb9202 | 2026-09-17 22:45:05.47+00  | 2026-09-17 23:49:18.316+00
 7982ac5f6de4 | 2026-09-17 23:49:18.316+00 | 2026-09-17 23:50:39.188+00
 6d87f812c0b2 | 2026-09-17 23:50:39.188+00 |
```

Each revocation's timestamp equals the next mint's, exactly. Five rotations, five exact matches.

### A rotation does not take effect until the app restarts — EXECUTED, found by accident

**The most operationally useful finding of the drill, and it came from a mistake in the command
sequence.** A `curl` was issued with a freshly rotated key *before* `docker compose up -d`, and the
server answered **401 `unknown`** rather than accepting it.

The cause is in the design and is not a defect: `./init.sh --rotate-ingest-key` writes the new
digest to `.env`, but the `ingest_keys` **row is created by `seedProjectIngestKey` at boot**. Until
the container restarts and re-reads `.env`, the new key has no row and the **old key is still
live**.

The table above proves it rather than merely illustrating it: `bbb24bbb…` was revoked at
**`23:49:18.316`**, which is the moment of the **restart**, not of the rotation command that
preceded it. The rotation alone changed nothing in the database.

**Consequence for an operator:** between rotating and restarting there is a window in which the new
key is refused as `unknown` and the superseded key still works. A rotation procedure that does not
state the restart leaves the operator holding a key that does not work and an old key that does —
which is the reverse of what they think they have just done. `init.sh`'s own success line does say
*"now run: docker compose up -d"*; the point is that the step is load-bearing, not advisory. Digest prefixes only; a 12-character
prefix of a SHA-256 is not a credential and the plaintexts appear nowhere.

## 4. The four ingest refusals — three of four, and the one that mattered

**#567's whole subject.** #514's Definition of done named *"wrong, malformed, revoked and unknown"*,
and its drill ran **no key header, malformed, unknown and wrong-project** — recording the result as
*"All four ingest refusals distinct"*. That is a different four: `revoked` was substituted out
silently, and `no key header` is not an `IngestKeyRefusal` at all.

Every request below used the **identical** `{}` body, so the statuses are attributable to the key
rather than the payload. Each was a single `curl`, of this shape — only the key header varied, and
the no-header row omitted it entirely:

```
$ curl -s -o /tmp/out.json -w 'HTTP %{http_code}\n' \
    -X POST https://<team-host>/v1/rhizomorph/ingest \
    -H 'x-rz-ingest-key: <the key under test>' \
    -H 'content-type: application/json' --data '{}'
```

| key presented | status | refused by |
|---|---|---|
| a non-`rzk_` string | **401** | `malformed` — *"Refused on shape alone — this server did not look it up."* |
| well-formed, never held | **401** | `unknown` — *"that `rzk_` key is not one this server holds."* |
| **revoked (`38101850…`)** | **403** | **`revoked`** — *"The flag is read once per batch, so a batch already in flight completes and every batch after it is refused."* |
| live (`bbb24bbb…`) | **400** | not the key — reached the body: *"no protocolVersion on the request"* |
| no header at all | **401** | `handle.ts` before `checkKey()` — *"no `x-rz-ingest-key` header on the request"* |

Each body matched `packages/team/src/keys/verify.ts` **verbatim**.

### The same-key comparison #567 actually asked for — EXECUTED

The matrix above was **not sufficient for #567 on its own**, and review caught it. That issue rules
out the weaker form in the same breath as it asks for the stronger: *"the **same key before
revocation** is accepted, and the **same request after** is refused. A 403 from a key that was never
accepted proves nothing."* The matrix showed a 403 from `38101850…` and a 400 from a **different**
key, which is exactly the shape #567 names as proving nothing.

Run afterwards, with one key (`7982ac5f…`) and one unchanged `{}` body:

```
# minted, then the container restarted so the boot seeds it
$ docker compose up -d && curl -s -o /tmp/k5-live.json -w 'HTTP %{http_code}\n' \
    -X POST https://<team-host>/v1/rhizomorph/ingest \
    -H 'x-rz-ingest-key: rzk_<REDACTED>' -H 'content-type: application/json' --data '{}'
HTTP 400
{"error":"no protocolVersion on the request; this build speaks protocol version 1. ..."}

# rotated again, restarted, SAME key presented
$ docker compose up -d && curl -s -o /tmp/k5-revoked.json -w 'HTTP %{http_code}\n' \
    -X POST https://<team-host>/v1/rhizomorph/ingest \
    -H 'x-rz-ingest-key: rzk_<REDACTED>' -H 'content-type: application/json' --data '{}'
HTTP 403
{"error":"that rzk_ key has been revoked. Refused: revoked key. The flag is read once per
batch, so a batch already in flight completes and every batch after it is refused — ship
with a replacement key."}
```

**400 then 403, same key, same body.** The key is shown to have worked and then to have stopped
working, and the only thing that changed between them is the `revoked_at` flag — `7982ac5f…` live
from `23:49:18.316` to `23:50:39.188` in the table above. That is the refusal attributable to the
row and nothing else.

**`revoked` is the row-flag case.** It is the only one of the four decided by a database round trip
against `revoked_at` rather than by shape or a missed lookup, which is why a unit test could not
stand in for it and why #567 existed. Obtaining it required **two** rotations: the first mints a key
whose plaintext the operator holds, the second revokes it.

**The live-key row is the ordering proof.** The same `{}` that a garbage key was refused for on
shape reached the body parser when the key was valid — so the key is verified **before** the body is
parsed, as `handle.ts` documents and #550 ordered. EXECUTED here rather than asserted.

**`wrong-project` was not reached** — see §4 of the gaps above.

## 5. Smaller findings

- **`./init.sh --help` is an error.** It prints `unknown argument: --help` and then the usage block.
  The usage text is good; a script whose own help flag is rejected is a small defect. Not fixed here.
- **`docker compose build 2>&1 | tail -N` looks hung.** `tail` buffers, so a multi-minute build
  prints nothing until it finishes. An operator reasonably reads that as a hang; this drill did, and
  interrupted a build because of it. Worth keeping out of the runbook.

## Sanitisation

Applied after capture and before commit, per `AGENTS.md`. No unsubstituted value reaches this file.

| real | written here |
|---|---|
| the host's DNS name | `<team-host>` |
| the deployment path and OS user | `/home/operator/…`, `operator` |
| the GitHub org | `<team-org>` |
| every ingest key plaintext | never captured; the operator held them privately |
| `.env` values | never read into the transcript; only variable **names** were ever printed |

Ingest-key SHA-256 **prefixes** (12 chars) are kept: they carry the row sequence that the
atomicity finding rests on, and they are not credentials.
