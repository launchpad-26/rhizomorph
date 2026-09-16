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

## Signing in with GitHub (the human plane)

**(a) What this is, and that it is optional.** Two identity planes that never fuse
(`docs/adr/0050-two-identity-planes.md`): people sign in through a GitHub App and the
boundary is membership of one organisation; machines hold `rzk_` ingest keys and never
touch GitHub. A deployment with none of this set boots normally, ships events normally,
and answers `/auth/github/start` and `/auth/github/callback` with **503** naming the
missing variables.

**(b) Register a GitHub App — not an OAuth App.** At
`https://github.com/organizations/<org>/settings/apps/new`, owned by the org.

- **Callback URL: `https://<host>/auth/github/callback`** — exactly this. The server
  deliberately sends no `redirect_uri` (`packages/team/src/auth/signin.ts`), so what is
  registered on the App is where GitHub sends the browser, and a wrong value here is
  something this server cannot detect.
- **Webhook → Active: unchecked.** The App receives nothing.
- **Permissions: Organization → Members → Read-only, and nothing else.** No repository
  permission of any kind — ADR-0050 rejected repository read precisely because it would
  hand the server every private repo each member can reach in order to answer one
  yes/no question.
- An OAuth App is the wrong thing and the ADR says why: it acts *as* whichever person
  authorised it, so the access boundary becomes a property of each person's grant
  rather than of the organisation.

**(c) Install it on the organisation.** Org → Settings → GitHub Apps → Install. This
needs an organisation **owner**; a non-owner's attempt becomes a request an owner has
to approve, and until they do there is no installation and no installation id.

**Third-party access restriction — it does not apply to this App, and that is worth
stating because the question comes up.** GitHub's third-party application access
policy governs **OAuth Apps**. A GitHub App is *installed*, not *approved* under that
policy, so an org that restricts third-party access does not need to approve anything
here — ADR-0050 records that consequence explicitly. What an owner does have to do is
approve the **installation** (and, if the org restricts which Apps members may request,
allow this one). If somebody tells you to "approve third-party access for rhizomorph"
in the org's OAuth policy page, that is a different control and it will not fix a
refused sign-in.

**(d) The six values, and where each is found.** A table: `.env` name → where in the
GitHub UI.

| `.env` name | Where |
|---|---|
| `RZ_TEAM_GITHUB_ORG` | the organisation login — the `<org>` in `github.com/<org>`, the org the App is installed on |
| `RZ_TEAM_GITHUB_APP_ID` | App settings → **About** → **App ID** (a number) |
| `RZ_TEAM_GITHUB_INSTALLATION_ID` | Org → Settings → **GitHub Apps** → **Configure** beside the App. The id is the last segment of that page's URL (`…/installations/<id>`). It is not the App ID and the two are easy to swap. |
| `RZ_TEAM_GITHUB_CLIENT_ID` | App settings → **Client ID** |
| `RZ_TEAM_GITHUB_CLIENT_SECRET` | App settings → **Generate a new client secret**. Shown once; if you lose it, generate another and delete the old. |
| `RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH` | not a GitHub value — the **host path** of the `.pem` from App settings → **Private keys** → **Generate a private key** |

**(e) The private key is a file.** A compose `.env` truncates a multi-line value at its
first newline, and the failure surfaces later as an unreadable JWT rather than as a
config error — so the key lives on disk instead. The recipe:

```
install -m 600 -D ~/rhizomorph-team-server.private-key.pem /srv/rhizomorph/github-app-private-key.pem
chown 1000:1000 /srv/rhizomorph/github-app-private-key.pem
```

and in `.env`: `RZ_TEAM_GITHUB_APP_PRIVATE_KEY_PATH=/srv/rhizomorph/github-app-private-key.pem`.

Two warnings that belong here and nowhere else:

- **uid 1000 is the `node` user the image runs as** (`packages/team/Dockerfile`). A key
  file that is mode 600 and owned by `root` is unreadable inside the container, and the
  boot report will say so — `<key file unreadable: …: EACCES …>`.
- **Keep the key outside the repository.** The build context is the **repository root**
  (`compose.yml`'s `context: ../../..`), and the runtime stage copies this directory wholesale —
  `COPY packages/team/deploy packages/team/deploy`. `.dockerignore` carries five rules, and the only
  two that concern this directory are its generated `.env` and `.env.tmp.*` files (the rest
  exclude `node_modules` and `.git`). No rule excludes a key, so a `.pem` left anywhere in the
  repository is copied into an image layer, where it outlives every rotation recipe in this
  document.

**(f) An existing deployment's `.env` does not gain these names.** `init.sh` refuses to
regenerate an `.env` that already exists — by design, so it can never reprint or rotate
the ingest key by accident. Append the block by hand (give it verbatim: the six names,
empty, with their comments), then `docker compose up -d` — **not**
`docker compose restart app`, for the reason "Rotating the ingest key" already gives.

**(g) What the boot report says.** `docker compose logs app` now opens with every
effective value, one per line, each naming who set it and where — with the two secrets
redacted:

```
config: 8 effective values
  databaseUrl = postgres://***@postgres:5432/rhizomorph (set by environment, RZ_TEAM_DATABASE_URL)
  migrationsDir = /repo/packages/team/src/migrations (set by default, packages/team/src/config/config.ts)
  githubOrgLogin = <org> (set by environment, RZ_TEAM_GITHUB_ORG)
  githubAppId = 123456 (set by environment, RZ_TEAM_GITHUB_APP_ID)
  githubInstallationId = 87654321 (set by environment, RZ_TEAM_GITHUB_INSTALLATION_ID)
  githubAppPrivateKey = <redacted> (set by environment, RZ_TEAM_GITHUB_APP_PRIVATE_KEY_FILE)
  githubClientId = Iv1.0000000000000000 (set by environment, RZ_TEAM_GITHUB_CLIENT_ID)
  githubClientSecret = <redacted> (set by environment, RZ_TEAM_GITHUB_CLIENT_SECRET)
```

Then the four things `githubAppPrivateKey` can say, and what each means:

- `<unset>` — no key configured at all. Sign-in answers 503.
- `<redacted>` — a key was read. The report never prints it, in any form.
- `<key file empty: …>` — the path resolved to an empty file. Usually a mount pointing
  at `/dev/null` or at a file the operator has not written yet. **Not the same as
  `<unset>`**, and deliberately so.
- `<key file unreadable: …>` — the read failed, with the reason. `ENOENT` is a wrong
  path or a mount that did not happen; `EACCES` is the ownership problem in (e);
  `EISDIR` means the host path did not exist when compose started and Docker created a
  directory in its place.

A fault also gets its own `stderr` line at boot, naming what to fix.

**(h) What a wrong value looks like from outside.** Lead with the honest sentence:
**several of these are genuinely indistinguishable from GitHub's side** — GitHub
answers a non-member, a misspelt org and a never-accepted invitation with the same
`404` — so read the boot report and the `reason` field before guessing.

| What you see | What to suspect |
|---|---|
| `/auth/github/start` → **503**, *"no GitHub sign-in configured"* | `RZ_TEAM_GITHUB_CLIENT_ID` or `RZ_TEAM_GITHUB_CLIENT_SECRET` is empty. Nothing to do with the key, the org or the installation. |
| GitHub sends the browser to the wrong host, or to a 404 | the App's registered **Callback URL** is not `https://<host>/auth/github/callback`. This server never sends `redirect_uri`, so it cannot detect or override it. |
| callback → **400**, `"refusal":"bad-state"` | the state cookie did not come back — the callback was opened directly, or more than ten minutes passed. Not a credential. |
| callback → **401**, `"refusal":"github-refused"` | wrong `RZ_TEAM_GITHUB_CLIENT_SECRET`, a client id and secret from two different Apps, or a code already exchanged. GitHub answers a bad secret with **HTTP 200 and an `error` body**, so a wrong secret looks exactly like a replayed code — if it fails on every first attempt, suspect the secret. |
| callback → **503**, `"refusal":"membership-unconfigured"` | one of `RZ_TEAM_GITHUB_ORG`, `_APP_ID`, `_INSTALLATION_ID` or the private key is empty. The boot report names which: it prints `<unset>`. |
| callback → **500**, `"refusal":"membership-error"` | the installation-token mint failed, and the **operator log** carries the detail the response deliberately does not: *"mint was refused (status 404)"* → wrong `_INSTALLATION_ID`, or the App is not installed on that org; *status 401* → the private key does not belong to that `_APP_ID`; *"could not be minted … check RZ_TEAM_GITHUB_APP_PRIVATE_KEY and RZ_TEAM_GITHUB_INSTALLATION_ID"* → the PEM did not parse, classically because it was pasted into `.env` and truncated at its first newline. |
| callback → **403**, `"refusal":"not-a-member"` | read the `reason` beside it. `no-such-membership` is a **404 from GitHub** and covers three different facts it cannot separate: genuinely not a member, a misspelt `RZ_TEAM_GITHUB_ORG`, or an invitation that was never accepted ("Pending" in the org's People tab is not a member). `credential-rejected` is a 401/403 on the membership call itself — the App's own token was refused, which is an operator fault wearing a member's error; check the installation still exists. `network-error` is the host's egress, not GitHub. |

Close with the one command that separates them from the host:

```
docker compose logs app | grep -E "config:|installation token|GitHub App private key"
```

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
produced **17 `role ... does not exist` errors across three roles** —
`rz_viewer` ×8, `rz_readonly` ×4, `rz_ingest` ×5 — and **all 13 of the dump's `GRANT`
statements are among the failures**. The 13 derives: `rz_viewer` and `rz_readonly` 4 each, on the
four tables `0003_roles_rls.sql` grants them `SELECT` on; `rz_ingest` 5 — `INSERT` on `events`, the
three projection tables, and `SELECT` on `ingest_keys` from `0005_ingest_keys.sql`.

**That count is an as-of measurement, re-derived 2026-09-16 against migrations `0001`–`0005`
(#514's drill), and it has already moved once.** It read 16 with `rz_ingest` ×4 when first written;
`0005_ingest_keys.sql` then added a GRANT and nothing re-derived the number. Re-measure it against
the migration set rather than trusting it, and say which set you measured. The
row-level-security policies in migration `0003_roles_rls.sql` name `rz_viewer` and
`rz_readonly` directly in `CREATE POLICY ... TO rz_viewer, rz_readonly` (Postgres reports
only the first missing role per statement, which is why `rz_viewer` alone accounts for
8 of the 17), and `rz_ingest` appears only in the `GRANT` statements. Roles are
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

### The three questions

Three read-only pages, for members of the organisation:

```
GET /v1/rhizomorph/where?project=<id>    where is work      (lane_state)
GET /v1/rhizomorph/cost?project=<id>     what does it cost  (spend_by_project_day)
GET /v1/rhizomorph/stuck?project=<id>    who is stuck       (collisions)
```

Sign in first at `/auth/github/start`. Membership of the organisation is checked **per request**,
so removing someone from the org closes their access at their next page load rather than at their
next sign-in. A pending, never-accepted invitation is not membership.

**`RZ_TEAM_PROJECT` now decides what a viewer may read, not only which project the seeded ingest
key is scoped to.** `init.sh` always writes it (defaulting to `default`), and a request naming any
other project is refused with a 404. That is a narrowing, not an authorisation model: **membership
of the organisation is the boundary**, and if you ever run a deployment with that variable empty,
any member may read any project it holds.

**The pages read as `rz_viewer`, never as the owner**, which is what makes the per-project policies
in `0003_roles_rls.sql` mean anything — the header there records the measurement, and
`0006_viewer_role_membership.sql` is the grant that makes it possible. Each read also sets
`rhizomorph.project_id`; without it the policies admit nothing and a page is empty rather than
wrong. A page that is empty when you expect rows is more likely the fold (above) than the scope.

A database that cannot answer gives **503** and a log line naming the cause; the page never
carries it.

Minting a key **from the team viewer** is not here, because minting is not — the viewer reads and
does not write: the
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
