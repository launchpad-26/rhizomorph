# prd-51 machine-plane drill — the ingest path meets a real host

**Tree:** `origin/main` at `cfbaf6c7085787121d778d9be59f0335705896b6`

- **Issue:** #514. **Date:** 2026-09-16. **Ran by:** the operator, driven from a Claude Code session.
- **Host:** a 4-core Ubuntu 24.04 VPS, referred to throughout as `<team-host>`. Real hostname, IP,
  account names and home directories are substituted; this repository is public.
- **What this is:** the machine plane alone, on real hardware, before four more lanes build on it.
  It is **not** #171, the full drill — there is no viewer to reach, so "a working team view" is out
  of scope by construction.

A dated artefact. Every claim is a record of that tree at that commit, not a live claim.

---

## Verdict

The ingest path works end to end on a real host, and the two things it does **not** do are both
already written down. Nothing here is a code defect. Two issues came out of it, and **both were
filed wrong and corrected before anyone acted on them** — that correction is the most useful thing
in this document and is recorded in full below.

| # | finding | grade |
|---|---|---|
| 1 | `init.sh` from nothing: key printed exactly once, `.env` 0600, no plaintext key stored | EXECUTED |
| 2 | Second `init.sh` run refuses and does not re-print | EXECUTED |
| 3 | First boot is legible: 21 lines total, 9 notices at one line each | EXECUTED |
| 4 | All four ingest refusals distinct, with the right statuses and strings | EXECUTED |
| 5 | A valid batch is accepted 202 after the journal fsync | EXECUTED |
| 6 | Torn journal tail detected, repaired at open, appended to afterwards | EXECUTED |
| 7 | Restore into the empty database before first boot: ordering holds | EXECUTED |
| 8 | Restore drops all `rz_` roles, grants and policies — documented, count drifted 16→17 | EXECUTED |
| 9 | The fold worker is not started, and nothing schedules starting it | EXECUTED |

---

## 1–2. `init.sh`, from nothing (ruling 13)

```
$ ./init.sh
first boot. Postgres and app secrets generated and written to <deploy>/.env (mode 600).
ingest key for project default (save this now — it will not be printed again): rzk_<REDACTED>
only its SHA-256 was stored. There is no way to recover this value from the host…

keys printed                       : 1
.env mode                          : 600
plaintext keys inside .env         : 0
```

Second run, same directory:

```
secrets already exist at <deploy>/.env (mode 600) — not regenerating, ingest key not re-printed.
keys printed on run 2              : 0
```

**EXECUTED.** Ruling 13's "prints the first ingest key exactly once" holds, and the guard against a
second run re-minting holds with it.

## 3. The first boot is legible (#551)

21 lines total, of which 9 are Postgres notices — each **one line**, not the eight an unfiltered
notice costs. `migrations: 5 applied (0001…0005)`, `ingest key: seeded for project default`,
`listening on 0.0.0.0:8787`.

**EXECUTED.** #551's claim survives contact with a real first boot, which is where it was found.

## 4–5. The refusal matrix (ruling 8)

Seven cases, run from inside the container network:

| case | status | the string, abbreviated |
|---|---|---|
| no key header | **401** | `no x-rz-ingest-key header on the request…` |
| malformed key | **401** | `that is not an ingest key… Refused on shape alone — this server did not look it up` |
| unknown, well-formed | **401** | `that rzk_ key is not one this server holds. Refused: unknown key.` |
| valid key, wrong project | **403** | `not scoped to project "not-this-one". Refused: wrong project.` |
| valid key, valid batch | **202** | `{"accepted":1,"journalSeq":1}` |
| replay of that batch | **202** | `{"accepted":1,"journalSeq":2}` |
| `GET` on the ingest path | **405** | `GET is not allowed on /v1/rhizomorph/ingest; a batch is POSTed` |

**EXECUTED.** Four distinct refusals, each naming its own reason, 401 for "not a key we know" and
403 for "a key, but not for this" — `keys/verify.ts`'s split, holding on a real host.

**A false pass in the harness, recorded because it nearly became evidence.** The first run of this
matrix sent `x-rhizomorph-ingest-key`. Every request was therefore refused for *having no key
header at all*, and cases 2 and 3 **passed while testing nothing** — the exact "a test that cannot
fail for the reason it claims" shape this repo warns about. The header is `x-rz-ingest-key`
(`ingest/handle.ts`). Caught by reading the response bodies rather than the status codes; a matrix
that had only asserted statuses would have reported 7/7 green.

**The replay is accepted twice, and that is correct.** An append-only journal must accept it;
`journalSeq` goes 1 → 2. Dedup is the fold's job, against the month's partition. Which is finding 9.

## 6. The torn tail (ADR-0046, #398)

The `kill -9` did **not** produce a torn tail. A burst of ~270 batches with the container SIGKILLed
mid-flight (exit 137) left the journal at 76,296 bytes ending in a clean `}]}\n` — the per-record
`writeSync`+`fsyncSync` leaves almost no window to land in. **That is a finding, not a failure**: the
crash the format exists for is hard to produce on purpose.

So the tear was **induced** — truncating the file mid-record — and is graded separately for that
reason:

```
journal before          : 76,259 bytes
truncated to            : 76,230 bytes   (mid-JSON, deliberately)
after the app opened it : 76,014 bytes, 542 lines
```

76,014 is exactly the offset the detector names. The framing is ADR-0046's:

```
RZJ1 1 265 f29eb2eb
{"seq":1,"receivedAtMs":…,"project":"default","actorInstance":"drill-actor-1",…
```

And the clause that matters is #398's — *repaired at open, not escalated by the next append*:

```
POST after the repair -> 202 {"accepted":1,"journalSeq":272}
tail of journal       -> RZJ1 272 254 ffb18501
```

271 records survived, the next is 272, no gap.

**A second apparatus error, recorded for the same reason as the first.** An earlier attempt at this
produced `journal … has a torn tail at byte 76014 that could not be truncated: EACCES`. That was
**my fault, not the product's**: the container that induced the tear ran as root and left the file
`root:root`, so the app's own uid could not truncate it. Re-run with ownership preserved, the repair
succeeded. An `EACCES` reported as a product defect would have been a fabricated finding.

Worth noting on the way past: with an unrepairable journal the app **crash-looped rather than
serving on a log it could not fix**. That is the right direction to fail in, and it was observed
only because of the mistake above.

## 7–8. Restore (ruling 13)

Correct order — dump, `docker compose down -v`, Postgres up empty, restore, *then* the app:

```
restore exit code : 0     (no duplicate key, no already exists — every data statement succeeded)
app boot          : migrations: 0 applied, 5 already applied — nothing to do     health=healthy
```

**EXECUTED.** Ruling 13's ordering holds.

The restore also emitted **17** `role "rz_…" does not exist` errors, and afterwards:

```
rz_ roles present   : (NONE)
policies on events  : 0
grants to rz_ roles : 0
rls enabled/forced  : true / true
migrations recorded : 5
```

**This is documented behaviour, not a discovery.** `docs/team-server-runbook.md` describes it in
detail, names the three roles, explains that roles are cluster-level objects a per-database dump does
not carry, and even names the fix. What this drill adds is one drift and two unstated consequences:
the runbook records **16** errors (`rz_ingest` ×4) where there are now **17** (`rz_ingest` ×5),
because `0005_ingest_keys.sql` added a GRANT after that measurement; `_migrations` records `0003` as
applied so it never re-runs; and RLS stays **enabled and FORCED with zero policies**, so the obvious
check answers "protected" on a database with no access control in it. Filed as #565.

## 9. The fold worker is not started

```
POST (valid key, 1 event) -> 202 {"accepted":1,"journalSeq":1}
select count(*) from events -> 0      (still 0 after 8s)
/data/journal/ingest.log    -> 572 bytes, records present
```

`fold/worker.ts` exports `runOnce`; nothing outside `*.test.ts` calls it; `serve.ts` passes no
`onBatch`; `compose.yml` has three services and the `Dockerfile` `CMD` is `serve.ts`.

**Also documented** — the runbook's "What is not wired up yet" calls it *deliberately* unbuilt. The
finding is therefore not the gap but the **schedule**: no issue in any wave, open or closed, starts
it, while #557 is groomed to read the three projections it would maintain. Filed as #564.

Ruling 4's ordering is intact throughout — ack after fsync, `journalSeq` increments, records on
disk. This is unfolded data, not lost data.

---

## Both issues were filed wrong first

#564 was filed as a Bug titled *"the deployed server journals a batch and never folds it"*. #565 was
filed as an Urgent Bug claiming a *silent, undocumented* loss of the access layer. Both framings were
wrong, and wrong the same way: **the runbook already documented each one, and I filed before reading
it.** Both were corrected in place — retitled, reframed as the smaller thing that actually remains,
and re-graded (#564 Bug → Task; #565 Urgent → Medium) — before anyone acted on them.

The lesson is cheap to state and was expensive to learn twice in one afternoon: on a drill, **read
what the deployment already says about itself before writing down what you found.** A drill that
rediscovers documented behaviour and files it as a defect spends a reviewer's credibility on nothing,
and the second filing would have been the one nobody checked.

## What this drill did NOT check

- **A working team view.** There is no viewer, no doctor route and no mint surface. Three routes
  exist in total. That is #171's, and it needs waves 11 and 12 first.
- **The human plane on *this* stack.** The drill stack was brought up with no GitHub App credentials,
  so its six `RZ_TEAM_GITHUB*` values are `<unset>` and sign-in answers 503 by design. It **was**
  verified against the live deployment separately: `GET /auth/github/start` there returns 302 to
  `github.com/login/oauth/authorize` with a real `client_id` and `state`. Member, non-member and
  pending-invitee outcomes were **not** exercised end to end on either stack.
- **Backup verified by digest.** Impossible as specified: no off-VPS destination is provisioned, and
  a dump beside its own database is not a backup. The PRD's 2026-09-08 amendment already narrows
  this to the ordering, which is what finding 7 proves.
- **A migration against a populated database.** Blocked by finding 9 — with no fold worker, `events`
  cannot be populated through the product path at all. Synthesising rows would have tested a
  fixture rather than the system.
- **A real host crash.** The server was SIGKILLed; the host was never rebooted. A power-loss-class
  event remains unwitnessed, and the torn tail in finding 6 was induced rather than crash-produced.
- **The live deployment's own sha.** Its checkout sits in a home directory the drill account cannot
  read without a password. It is known only to be **older than PR #556**: a no-key POST there answers
  400, where this tree answers 401 (#550). The live stack was otherwise left untouched.
- **Anything about the other five accounts on that host**, deliberately.
