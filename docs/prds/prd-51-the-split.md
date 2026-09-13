# prd-51 — the split: the ledger ships up, and nothing leaves the team

> **Status:** **BLESSED** — ciaran-slow, 2026-09-03, in session. Milestone `prd51`. Rulings 6 and 9
> stand as written. Drafted 2026-09-03 in session with ciaran-slow, written *from* prd-48's
> twenty research notes (`docs/research/2026-08-2*-shared-record-*.md`,
> `2026-09-02-shared-record-*.md`, all on `main` since #254) and the synthesis at
> `docs/research/2026-08-28-shared-record-architecture.md`. This is **the build PRD prd-48 named
> as its output** ("the split", prd-48 status line). It carries the constitutional paperwork
> prd-48 said must be written *with* it: three ADRs landed beside this document and were accepted with the
> blessing (rulings 2, 3 and 13), and the README Trust rewrite is a wave-2 deliverable bound to the
> shipper's own commit (ruling 12). Consumes prd-37 (parked) as the product half and does not
> unpark it. Absorbs prd-48's two open issues: #169 becomes a wave-3 issue here and #171 becomes
> wave 4. **Blessing this document rules the two questions prd-48 reserved for the leads** —
> ruling 6 (`author.email`, and what else crosses) and ruling 9 (org precedence) — as written;
> the leads amend them before blessing or not at all.

## Problem

Every rhizomorph is an island. Each member's instrument keeps a hash-chained, verifiable ledger
of what their agents did, and no one else can read it: the interesting questions — where is the
team's work happening, what is it costing, who is stuck — exist nowhere, because the only way a
record crosses a machine boundary today is by a human's hand, like a screenshot. prd-37 named the
product and was parked; the metamorphosis named the shape and was nearly lost; prd-48 measured
the unknowns so nobody would build on a guess. The team now has a GitHub organisation and a VPS
arriving on 2026-09-04, and no code that could put a byte on it.

The cost of building it wrong is named in the evidence: the ingest key the earlier designs
assumed silently discards three quarters of a real ledger; an ack that precedes durability loses
a batch per process death; a viewer with a mutation surface would move lab launches off the
machine that owns them; and a shipper that sends what the code happens to emit rather than what
the schema declares put terminal text carrying a hostname and a username on the wire.

## Evidence

Every number below was executed in a prd-48 spike and is cited to its note; boxes and loads are
recorded there. Ratios are durable, absolute milliseconds are one box's afternoon.

- **The ledger is already the best-designed part of the system, and it is 93 % noise by
  volume.** One box: 216 MB, largest session 63,653 events / 26 MB; five high-frequency classes
  carry 93.19 % of lines and 92.88 % of bytes; gzip ≈ 10× (`2026-08-28-shared-record-s1-corpus.md`
  §2, §4). Across four machines bytes/event holds at **280–415 B, centre ~360 B, spread 1.48×**,
  while the durable-fact share varies **70×** and events/day **20×** — size a server on bytes/event
  and the per-pane ceiling, never on a percentage (`2026-08-29-shared-record-s1-corpus-machines-2-3.md`
  §"named falsifier", §"durable-fact spread"). `pane.activity` is a ~2 s poll, so one pane cannot
  exceed ~1,800 events/hour ≈ **648 KB per pane-hour** (same note, §4 machine 3).
- **Event ids are not identities, and the shipped merge key said they were.** `evt-000001` appears
  15× in one real log; a key on `(project, actor, event_id)` dropped **47,435 of 63,653 lines
  (74.5 %)** and reported success (`2026-08-28-shared-record-s2-shipper.md` §schema defect).
  Between two actors the id overlap is **91 %** (`2026-08-29-shared-record-s2-concurrent-actors.md`
  §cross-actor). Fixed in shipped code by #173/#204: `packages/core/src/record/merge.ts:149`
  keys on `${hash}:${actorInstance}` and every folded event carries its actor.
- **Position is the key that is lossless and idempotent.** Keyed on `(project, actorInstance, n)`:
  a 63,653-line backfill in **9.82 s**, 20 `kill -9` with a parseable cursor every time, a 5,000-line
  replay with delta 0, a 64-byte garbage cursor cold-starting and self-repairing, and a record
  rebuilt from server rows closing to the **identical `chainDigest`** as the local export
  (s2-shipper §chaos matrix, §crown). Eight concurrent shippers, **902,640 rows, 0 duplicates,
  0 gaps, 8/8 chains closed** (s2-concurrent-actors §verdicts).
- **The ack means durable or it means nothing — at both layers.** Accept-fast-into-memory lost
  exactly **one 500-line batch** when the server died after its 202 (s2-shipper row c). Ack after
  `writeSync`+`fsyncSync` of an append-only journal: **75 kills, 0 lost, 1,129,197 lines in 15.32 s**
  (`2026-08-29-shared-record-s2-ack-after-journal.md` §verdicts). Advancing the fold cursor
  *before* the transaction commits lost **15,000 lines in 30 kills — exactly one batch per kill**;
  commit-then-advance lost none in 30 (`2026-09-02-shared-record-s2-fold-worker-ordering.md`
  §4.1–4.2). Its ruling: *the build PRD should carry both orderings*, and `synchronous_commit=off`
  is the sibling that reintroduces the mutation without the mutation (§6).
- **The schema allowlist protects the record, not the wire.** Shipping raw log bytes put
  `pane.activity.preview` — real terminal content — on **30,627** wire events and **0** record
  lines; re-serializing through the current schema costs nothing and is what makes the digest
  identical (s2-shipper §veil, §ruling). The inventory of 2,351,102 string values found **zero**
  prompt or completion text; what does cross is paths (10 event types, 12 fields), commit subjects
  and bodies verbatim, and the git author email — **668×** in one log
  (`packages/core/src/events/git.ts:60`, `common.ts:63-66`).
- **Postgres, one partitioned table, and the rollup is not optional.** At 10 M rows four of the
  org's five questions answer in **0.19–452 ms** on ordinary btrees; cost-by-project-by-day
  **fails at 1,007 ms** (1.67 GB of heap I/O for 90 rows) and a materialised daily rollup answers
  in **0.13 ms** (`2026-08-28-shared-record-s4-schema.md` §five questions). Retention as
  `DROP PARTITION`: **3.53 s**, bytes returned immediately, against **17.6 s** and two lock windows
  for DELETE+VACUUM (§retention). A unique constraint on a ts-partitioned table must include `ts`,
  so dedup lives at ingest (§finding 1); **RLS forbids `COPY FROM`**, so the ingest role must
  bypass it (§finding 2).
- **No local database, on any platform.** The parse cache prd-44 ships answers the lane index in
  **3.9–5.9 ms** warm; `node:sqlite` takes 12–21.6 ms and PGlite 66–126 ms with a store **4× the
  log** (`2026-08-28-shared-record-s3-localstore.md`). Native Windows: **3.0–3.2 ms vs 20.3 vs
  65.9** — the parse cache is the platform-neutral one. Windows also refuses unlink, rename and
  rmdir while a handle is open (`EBUSY`) and `node:sqlite` fails silently above a **251-character**
  path (`2026-08-29-shared-record-s3-windows.md` §Windows-only behaviour).
- **Identity is borrowable; the key design is unbuilt.** `GET /orgs/{org}/members/{user}` →
  **204** for a member, **404** otherwise, minimum scope `read:org`; device flow is the only OAuth
  flow that needs no secret in a shipped binary (`2026-08-28-shared-record-s5-identity.md`). The
  `rzk_` key — 32 random bytes, stored only as SHA-256, revocation checked per batch — is a
  design proposal with no executed server (same note, §what this did not test). The pending-invite
  state was never witnessed (#169).
- **Seal → archive → prune composes, conditionally.** Archives land at **14–23 %** of the raw log;
  **15 kill-9 checks, 0 violations**; but a pruned lane with no transcript sidecar **vanishes**
  from the lane index (`2026-08-28-shared-record-s7-retention.md` §verdicts). A 621-byte
  tombstone manifest closes that with zero changes to `retention.ts` — for telemetry-attributed
  lanes only, and only if nothing can reach prune without it
  (`2026-08-29-shared-record-s7-archive-tombstone.md` verdicts 4 and 5).
- **Install is 14.2 s locally, and the real-host remainder is a list.** `init.sh` → compose →
  healthz **14.2 s**; a restore must run into the empty database *before* migration-on-boot; a
  live migration took **12.7 s** of single-container downtime; the VPS remainder is DNS, TLS,
  OAuth callback, firewall, off-box backup, unattended upgrades — **~30–50 operator-minutes**
  (`2026-08-28-shared-record-s8-install.md` §results, §remainder).
- **The constitution says no, in four places, by name.** ADR-0009 rejects "a federation protocol …
  or a shared database both instances read" (`docs/adr/0009:22-23,35-38`);
  `docs/record-format.md:336-339` Law 2: *"Nothing auto-transmits"*; ADR-0019 grant 3 *"The hand
  has no clock"* (`:84-85`) and grant 5 *"It holds no secret"* (`:89-91`), with option E — a
  credential-holding hand — rejected because *"a hand that holds a credential has something worth
  stealing"* (`:65-67`); `README.md:149-161` *"What it sends, and to whom: nothing, ever, off this
  machine."* And one shipped string is already a promise about this PRD:
  `packages/web/src/settings/registry.ts:240` — *"no team server is configured, so there is no
  other end for an opt-in to reach."*

## Success

1. **A member's real ledger reaches the cohort's VPS losslessly.** A portable record re-exported
   from the server's rows verifies and closes to the same `chainDigest` as the local export, for
   every actor, after every chaos row prd-48 ran (kill mid-batch, server death after ack, offline,
   replay, garbage cursor, cold backfill) re-run against the real host. **Not met while** any row
   produces a gap or a duplicate in `n`, or any chain fails to close.
2. **What crosses the wire is exactly a portable record's body, and it is proven by capture.** A
   session run with planted markers in prompts, agent output and pane text, captured at the proxy,
   yields zero marker hits; the field inventory of the captured bytes equals the field set the
   current event schema declares. **Not met while** any field the schema does not declare crosses,
   or while the veil claim rests on reading code rather than grepping bytes.
3. **The local instrument opens nothing.** It still binds `127.0.0.1` only, the `Host` guard is
   untouched, and the shipper is an outbound HTTPS client that holds one project-scoped key in a
   `0600` file under the data root. **Not met while** any inbound socket, any second credential,
   or any path from a collector or a poll to enabling the shipper exists.
4. **Membership is the boundary and revocation is bounded.** A non-member of the GitHub org gets
   nothing from the team server; a pending invitee is refused a key and refused ingest; a revoked
   key is refused within one batch — each witnessed on the cohort's own org, not reasoned.
   **Not met while** a pending invite cannot be distinguished from a member, or while any of the
   three is asserted from documentation alone.
5. **A fresh VPS reaches a working team view in one init step, timed, with its remainder named.**
   The three questions — where is work, what does it cost, who is stuck — answer from a browser
   and from a read-only SQL role against the real host; backup and restore are drilled with the
   restore verified by digest; one migration is applied to a populated database. **Not met while**
   any step needs hand-typed SQL, or while "one step" is claimed for what the operator remainder
   list still does by hand.
6. **No default age, anywhere, and pruned reads as pruned.** The server prunes only under a
   ceiling the admin named; the local instrument keeps prd-44's law; a local archive-and-prune
   leaves a lane that reads as pruned, including lanes only git knows about, or says out loud
   which lanes it cannot name. **Not met while** any code path reaches prune without the archive
   and tombstone before it, or while a 30-day anything exists that nobody typed.
7. **The instrument's own words are true again.** The README Trust section says exactly what
   leaves, when, to whom and under whose key, in the same commit as the shipper; the settings copy
   at `registry.ts:240` no longer claims there is no other end. **Not met while** a shipped string
   describes a world without a team server.
8. **The paperwork lands before the code it licenses.** The three ADRs are `accepted` and the
   fifth hand's law test exists before any shipper source is committed. **Not met while** a
   shipper commit precedes its ADR on `main`.

## Non-goals

- **prd-37's surfaces.** Colonies, identity colour, the org roll-up as a scene — product, parked,
  its own blessing. This PRD's team view is the three questions as read-only pages and a SQL
  role, nothing prettier.
- **The mesh.** Viewing one machine through Tailscale or Cloudflare identity is a separate,
  smaller thread the metamorphosis keeps distinct. Nothing here forecloses it.
- **Anything flowing down.** No teammate's history on a member's disk, no replicated database, no
  S9 projection in v1 (open question below).
- **Words.** v1 ships facts only. Transcripts are a separate storage class (one 17.25 MB
  transcript sat beside a 15.6 MB log, s1-corpus §gaps) and prd-37 ruling 3's per-person opt-in
  with collector-side redaction governs any future words plane. No opt-in path is built here.
- **A retention default.** prd-44 #38 ruled it: *"there is no default age, and that is the
  ruling."* The server inherits the ruling, not a number.
- **Federation, a managed cloud, a words-plane, a rung above one container + Postgres + Caddy.**
  Named in the metamorphosis as later; still later.
- **A local database.** Measured out on two platforms. SQLite stays the documented fallback if a
  local query surface is ever demanded; PGlite is rejected.

**Rejected alternatives.** *Peer-to-peer sync* — rejected by name in the metamorphosis and prd-37;
not reopened. *A replicated database on every machine* — O(team) storage on every disk, N-way
retention, a veil unenforceable after the fact (brief §3B). *Event id as the wire key* — 74.5 %
silent loss, executed. *Accept-fast into memory* — one batch per death, executed. *Shipping raw
log bytes* — 30,627 removed-field leaks, executed. *SQLite-first on the server* — the metamorphosis
direction, deviated from on measurement: the target is a VPS from day one, partition drop is the
retention story, RLS is the tenancy story, and the storage interface keeps the door open in
either direction. *A `--team` flag on the local server* — a flag makes the fifth hand a
configuration detail, the exact shape ADR-0001 refuses (`0001:49-52`); the team server is a
separate package and image. *Web flow for anything shipped to members* — a client secret in a
binary is public (s5 §flow choice).

## What already exists (do not rebuild)

- **The portable record**: `buildRecord`, `verifyRecord`, `readRecord`, `sessionRecordSchema`
  with `signature: z.null()` (`packages/core/src/record/`); `mergeRecords` with the hash-keyed
  dedup and `MergedEvent` (`merge.ts:149`, #173/#204). The wire ships what `buildRecord` would
  serialize; the server re-exports with it.
- **The event schema as allowlist**: `rhizomorphEventSchema` (`packages/core/src/events/index.ts:23`),
  non-strict `z.object`, so parsing strips undeclared keys — the veil's mechanism.
- **The retention grammar**: `planRetention` / `readRetentionPlan` / `applyRetentionPlan` /
  `voiceRetentionPlan`, `RetentionAnswerRefused`, `LaneHistoryLoss.silent`
  (`packages/server/src/log/retention.ts`); `missingRecordingGap` (`lane-index.ts:209`).
- **The data-dir override**: `RHIZOMORPH_DATA_DIR` (`paths.ts:6`, #170) and every path
  constructor beside it.
- **The parse cache**: `parsedSessionLogCache` (`lane-index.ts:628`, ADR-0028) — the reason there
  is no local database.
- **`/connect`'s vocabulary**: `LinkState`, `ChainLink` with its `reason`+`command` remedy pair
  and `fact`+`ts` verified pair (`packages/web/src/connect/links.ts:52-141`); the server doctor
  (`api/doctor.ts:92`). The `team server` row and the server's own doctor reuse both.
- **The ingest-route precedent**: ADR-0018's body-shape routing and its pinned `ROUTE_CLASSES`
  count — the discipline a new route inherits.
- **The loopback fences**: `cli/run.ts:183` and `mutation-guard.ts:94` — read, never widened.
- **prd-38's list of where a credential never lives** (`parked/prd-38:108-115`) — the shipper's
  key obeys it verbatim.

## Rulings

## Ruling 1 — the ledger ships up; the noticeboard is served; nothing flows down in v1

Shape A of the design brief, confirmed by measurement. Each instrument keeps its JSONL ledger as
the only local truth. A **shipper** tails it and posts batches to one team server; the server
journals, folds into Postgres and serves the team view itself. A member's local instrument is
unchanged — loopback, offline-capable, showing its own fleet. Nothing is pushed back to a member's
machine in v1; the S9 projection is an open question, not a wave. This is the shape the brief
argued and every spike executed against; B and C stay rejected.

## Ruling 2 — the shipper is the fifth hand, and it has a clock and holds a key, bounded

ADR-0001 grants powers as named hands, each an amendment on the record. The shipper is the fifth:
after the observer, the laboratory, the recorder and the concierge. It breaches ADR-0019's grants
3 and 5 as written — it runs on a batch timer, and it holds a credential — and reopens option E on
the merits. The bound that makes it acceptable is stated in full, and each clause is a law test:

- **Outbound only.** It opens no socket for listening; the instrument's bind and `Host` guard are
  untouched.
- **One credential, one shape.** A single `rzk_` ingest key, project-scoped, revocable server-side,
  stored `0600` under the data root and nowhere on prd-38 ruling 4's never-list; `doctor` reports
  its presence, never its value.
- **Enabled by a human act, per repo.** `rhizomorph connect team <url>` is the only path to an
  enabled shipper; no collector, poll or boot enables it. Once enabled it runs on its timer, and
  the enabled state is visible on `/connect` for as long as it holds (ruling 12).
- **It sends only what the record would carry** (ruling 6). Nothing else ever.

The paperwork is **ADR-0034 — the fifth hand** (proposed, beside this PRD), a new top-level ADR
that amends 0001's grant list and 0019's grants 3 and 5, in the form `docs/adr/README.md:133-138`
prescribes. Its law test (`packages/server/src/shipper/hand-law.test.ts`, holding the import
graph to "no listener, one key path, no enable path from a collector") lands **before** the
shipper's code, the way ADR-0019's namespace law preceded the concierge.

## Ruling 3 — the wire is a versioned protocol keyed on position, and the record is what it carries

ADR-0009's rejection of "a protocol" is amended, not its choice of the portable record.
**ADR-0033 — the record travels by protocol v1** (proposed, beside this PRD) records the contract;
this ruling binds the build to it:

```
POST /v1/rhizomorph/ingest            x-rz-ingest-key: rzk_…
{ protocolVersion: 1, project, actorInstance, batch: [ { n, line } … ] }
202 { accepted, journalSeq }          only after the journal write is durable
```

- **`n` is the 1-based position in the source ledger.** Dedup and ordering key on
  `(project, actorInstance, n)`, never on the event id. The lossless invariant is *no gaps and no
  duplicates in `n`*, not monotone arrival, because a legitimate repair violates the latter.
- **`line` is re-serialized through the current event schema before it leaves.** Never raw log
  bytes. This is the veil's load-bearing clause and the reason a server-side re-export closes to
  the local digest.
- **The cursor is byte offset + `n`, written tmp-then-rename, advanced only on 2xx**, and byte
  offsets are computed on raw `Buffer`s, never on decoded strings (the +5 rows bug,
  s2-concurrent-actors §bug). A garbage or absent cursor cold-starts from 0; replay is absorbed by
  the key.
- **Protocol version is on every request**, and a server refuses a version it does not speak by
  name, in prd-19's remedy voice. `docs/record-format.md` Law 2 is amended to say what now
  transmits and under whose act.

## Ruling 4 — the ack follows a durable journal, and the fold cursor follows the commit

Two orderings, both binding, because the executed mutation of either loses exactly one batch per
death:

1. Validate → build journal record → `writeSync` → `fsyncSync` → **then** notify the fold queue and
   send 202. A 4xx never touches the journal; a write or fsync that throws never sends 202.
2. In the fold worker: `BEGIN` → `INSERT … ON CONFLICT (project, actor_instance, n) DO NOTHING` →
   `COMMIT` → **then** persist the fold cursor (tmp-then-rename). The cursor may skip fsync — every
   reachable post-crash state is behind-or-equal to the committed truth, and a rewind costs time,
   not rows.

Postgres runs `synchronous_commit=on`. Turning it off is the mutated ordering arriving without the
mutation, and the install refuses to start against it. A torn tail on the journal is legal only at
EOF and reads as never-acked; a parse failure anywhere earlier aborts loudly. Rotation of the
journal is out of scope for v1 and said so.

## Ruling 5 — Postgres on the server, one partitioned events table, projections required

The metamorphosis said SQLite-first; this PRD deviates on measurement, and keeps the one
discipline that made SQLite-first safe: **storage behind an interface, no SQL in route handlers**,
so the engine remains a re-deployment, not a rewrite. The shape:

- `events (project_id, actor_instance, n, event_id, ts, type, source, lane, worktree, payload
  jsonb, line text) PARTITION BY RANGE (ts)`, monthly partitions. The natural unique key cannot
  exist on a ts-partitioned table; dedup is ingest's (ruling 4) and `line` is stored verbatim so
  any actor's stream can be re-exported and re-verified byte for byte.
- Indexes: BRIN on `ts`; btrees `(project_id, lane)`, `(type, ts)`, `(lane, ts)`. No covering
  expression index for the cost question — the planner never chose it.
- **Projections the fold worker maintains, required not optional**: `spend_by_project_day`,
  `lane_state`, `collisions`. The events table is the rebuildable truth; the projections are what
  the org's three questions read. A fifth question cannot be answered by a bigger index.
- **The ingest writer is its own role that bypasses RLS on writes**; every viewer role sits
  behind per-project RLS, and the read-only SQL role that makes the noticeboard agent-parsable is
  one of them.

## Ruling 6 — what leaves is exactly a portable record's body, and the record's contents are facts within the team

The veil for v1 is stated as an equality, not a list: **the bytes a member ships are the lines
`buildRecord` would serialize for that session, and nothing else.** The README already tells a
person what a record carries before they hand it to anyone (`README.md:215-227`): paths including
the home directory and username, commit subjects with the author's name and email, branch and
lane names, stderr from failed git or tmux commands. Within a project all of that is already in
`git log` and on the disk of every member with the repo; the team boundary (ruling 8) is what
makes it a fact rather than a leak.

**Consequently — and this is the ruling prd-48 reserved for the leads — git `author.email` is a
fact**, and so are commit messages and worktree paths. Words are model I/O and terminal text:
prompts, completions, transcripts, pane content. None of it is in a record, so none of it
crosses. Two constraints travel with the ruling: the org roll-up never ranks people on any fact
(prd-37 ruling 5, restated here as binding on the noticeboard), and Success 2's capture is the
proof, re-run whenever the schema changes a field.

The alternative — hashing or pseudonymising the email and stripping path prefixes at the shipper
— was weighed and loses for v1: it breaks the digest identity that proves losslessness, and it
removes the only cross-machine identity prd-37 ruling 2 builds on. It is named in Open questions
as the thing that would come back if the team boundary ever widens past one org.

## Ruling 7 — no local database; the cursor is a JSON file; Windows is a first-class platform

The lane index stays on the parse cache; the shipper's state is one JSON cursor file under the
data root. Measured on WSL2 and native Windows: nothing beats what prd-44 ships. Two Windows facts
bind every design that touches files here: a file a reader holds cannot be unlinked, renamed or
have its directory removed (`EBUSY`), so prune, rotate and archive each need a Windows answer
before they claim to work; and 251 characters is the path budget for any per-project,
per-actor, per-session store. Both are tested on the `windows-suite` leg, not assumed from POSIX.

## Ruling 8 — two identity planes that never fuse: org membership for humans, `rzk_` keys for machines

- **Humans** sign into the team view with GitHub. The team boundary is membership of one GitHub
  organisation — the cohort's new org — checked with `read:org` against
  `GET /orgs/{org}/members/{user}`: 204 is a member, anything else is not, and **`state: pending`
  is not a member** (#169, wave 3). The OAuth web flow is used for the browser viewer only,
  because its client secret lives in the team server's own environment and nowhere shipped.
- **Machines** hold `rzk_` ingest keys: 32 random bytes, stored only as SHA-256, shown once at
  mint, scoped to one project, revoked by a row flag checked **once per batch** — which bounds
  revocation lag to one batch interval. Refusal text names the key prefix and the exact reason.
- **The planes never meet.** No GitHub token is ever accepted on the ingest route; no key is ever
  derived from a GitHub token; the ingest hot path never calls GitHub. A member mints a key in the
  viewer and pastes it once into `rhizomorph connect team`; device flow for a CLI-side mint is an
  open question, not v1.

## Ruling 9 — the org sets a ceiling on the server, and a person's veil and disk are theirs

Simpler than the brief's ceiling-and-floor. In v1 the organisation admin may name **ceilings**:
how long raw events are kept per project, and a storage quota per project. There is no floor, no
org default, and no reach into a member's disk. Local retention remains prd-44's explicit act; the
words veil has no organisational override and nothing here builds a words path. Every effective
value on the server names who set it and where. A floor for audit is a later ruling if anyone
asks for one with a reason.

## Ruling 10 — retention on the server is `DROP PARTITION` under a named ceiling, and no ceiling means nothing is dropped

The server never invents an age. With no ceiling named, partitions accumulate and the disk budget
warns in the honest-gap voice; with a ceiling named by the admin, the fold worker drops whole
monthly partitions past it — 3.53 s and bytes returned immediately, against 17.6 s and two lock
windows for a DELETE. An archive of the partition before the drop is the admin's choice, made
once at ceiling time, never silently. The local archive lifecycle (ruling 11) is a different act
on a different machine and is not triggered by anything the server decides.

## Ruling 11 — locally, seal → archive → verify → tombstone → prune is one command, in that order, or it does not run

The portable record is the archive format; gzip lands it at 14–23 % of the raw log. A single
`rhizomorph archive` composes the steps against `retention.ts`'s grammar without editing it:
build the record, gzip, `verifyRecord` the archive, **write the tombstone manifest at the
transcript-capture path while the log still exists**, then and only then `applyRetentionPlan` for
that candidate. Prune is not reachable from this command by any other route. Two things the
tombstone spike named travel as requirements: the manifest's lane list is cross-checked against
the log before the log goes, so a tombstone can never conjure a lane that never ran; and lanes
only git knows about — a worktree with commits and no instrumented agent — are either named by
widening the writer's lane source to `laneHandlesOf`, or the command says out loud that it cannot
name them. `attributedFrom` gains `'tombstone'` as a declared value. On Windows the command
answers `EBUSY` by refusing the candidate with the holder named, never by pretending.

## Ruling 12 — the instrument's own words change in the same commit as the code that makes them false

The README Trust section's *"nothing, ever, off this machine"* and the settings copy at
`registry.ts:240` are true today and become false the moment a shipper can be enabled. The
rewrite — what leaves, when, to whom, under whose key, and how to see that it is on — lands in the
shipper's own commit, not before (a README describing an unbuilt hand) and not after (a README
lying about a built one). The Langfuse-forwarder gate in `docs/roadmap.md:328-331` is closed by
name in the same edit, and `/connect` gains one row, `team server`: VERIFIED only when a batch was
acknowledged, with the fact and its timestamp; BROKEN with the exact remedy; UNPROVEN until then.
"Connected" never means preconditions passed.

## Ruling 13 — the watcher is never a container; the team server always is

Recorded once, as the 2026-08-07 research note asked. The local instrument observes a filesystem,
tmux and git and is never containerised; the team server observes nothing and is one image plus
Postgres plus Caddy in one `compose.yml`. Migrations run on boot from SQL files tracked in
`_migrations`; `init.sh` generates secrets and prints the first ingest key exactly once; restore
runs into the empty database **before** the app's first boot; the server has a `doctor` in the
local one's discipline, one line per check with its exact remedy. The paperwork is **ADR-0035 —
the server is the one thing that is a container** (proposed, beside this PRD).

## Ruling 14 — the team server is a separate package, and the local server does not learn about it

`packages/team` is a new workspace package with its own entrypoint and image, sharing
`@rhizomorph/core` for the event schema and the record. The local server gains the shipper
(`packages/server/src/shipper/`) and the `connect team` command, and nothing else: no tenancy
layer, no ingest route, no `--team` mode. The `mutation-guard`'s loopback set and the `Host` hook
are read by the shipper's law test and widened by nothing. The metamorphosis's "same Fastify
server grown a tenancy layer" is the one line of its stack table this PRD does not follow, for the
reason ADR-0001 gives about flags.

## Sequencing (waves, each gated as ever)

**Territory.** `docs/research/` is prd-48's and is read, not edited. `packages/web/src/scene/`,
`fleet/` and every product surface are prd-37's (parked) and prd-33's; no wave enters them.
`scripts/gate.sh` and `.github/workflows/` are prd-25/45/46's. `README.md` is touched by exactly
one issue in this PRD (wave 2's shipper, ruling 12) and its fence is recorded there; prd-43's
open lanes (#24, #66) name README too, so that issue checks before it starts. `packages/team` is
new ground and unclaimed. Every wave consumes wave 1's contract module and follows it.

**Wave 0 — operator acts, booked not skipped. Not dispatchable.** The leads bless this document,
ruling 6 and ruling 9 as written or amended first · the cohort's GitHub organisation exists and
an owner is named · the VPS exists (2026-09-04) with a hostname, and an admin is named · the
OAuth app is registered on the org with the real callback URL, and org third-party access is
approved if the org restricts it · the first project's key holder is named · the three ADRs move
`proposed → accepted` in the blessing.

**Wave 1 — the Keystone, additive, zero-claimant.**
`prd51 w1: the wire contract exists and re-serializes a ledger line by position` —
`packages/core/src/wire/`: protocol v1 types, the `(project, actorInstance, n)` key, the
re-serialize-through-schema function with the veil test (a pre-#292 log's `preview` field does
not survive it), the cursor codec with its Buffer-offset law · the fifth hand's law test skeleton
(`packages/server/src/shipper/hand-law.test.ts`) asserting the shipper directory is empty of
listeners and enable paths before it has any code · `docs/record-format.md` Law 2 amended.

**Wave 2 — parallel, fenced apart:**
`prd51 w2: a shipper tails the ledger and holds one key, outbound only` (`packages/server/src/
shipper/`, `cli/connect-team.ts`, the README Trust rewrite and `registry.ts:240` — ruling 12) ·
`prd51 w2: the ingest journals before it acks and folds after it commits` (`packages/team/src/
ingest/`, `journal/`, `fold/`, the storage interface, migrations `001–00N`, the fault-point harness
from #167/#205 as tests) · `prd51 w2: membership is the boundary and a key is a hash` (`packages/
team/src/auth/`: OIDC web flow, the 204/404 check, `rzk_` mint/revoke/per-batch check) ·
`prd51 w2: seal, archive, verify, tombstone and prune are one local command` (`packages/server/
src/log/archive.ts`, `cli/archive.ts`, `transcript-capture.ts`'s `attributedFrom` union; Windows
`EBUSY` answered on the suite leg — ruling 11, absorbing prd-48's #172 residue).

**Wave 3 — parallel, each consuming wave 2:**
`prd51 w3: the three questions answer from a browser and a read-only role` (`packages/team/src/
view/`: projections `spend_by_project_day`, `lane_state`, `collisions`; the pages; the SQL role
behind RLS) · `prd51 w3: a pending invite is refused a key and refused ingest` (#169, re-homed;
witnessed on the cohort's org) · `prd51 w3: an admin names a ceiling and a partition drops under
it` (`packages/team/src/retention/`, the quota warning, who-set-it on every value — rulings 9, 10)
· `prd51 w3: the team server has a doctor and /connect has a team-server row` (`packages/team/src/
doctor/`, `packages/web/src/connect/links.ts` one row — ruling 12's second half) · `prd51 w3: one
image, Postgres and Caddy come up from init.sh with the key printed once` (`packages/team/deploy/`:
`compose.yml`, `init.sh`, restore-before-boot in the runbook — ruling 13).

**Wave 4 — the integration pass, on the real host.**
`prd51 w4: a fresh VPS reaches a working team view, timed` (#171, re-homed: compose + init +
backup/restore verified by digest + one migration on a populated database, every keystroke
recorded, the remainder list timed) · `prd51 w4: the chaos matrix holds against the real host`
(all of prd-48's rows plus the host-crash gap every fsync note named as unclosed — a VPS reboot
mid-batch is the one condition no spike could run) · `prd51 w4: the veil is proven on the wire`
(planted markers, mitmproxy at the real TLS edge, the field inventory equal to the schema —
Success 2).

**Sweep, last.** `prd51 w5: every doc that says "nothing leaves the machine" says what leaves`
(`docs/`, `SECURITY.md`, `docs/telemetry.md:457-499`, ADR-0009's status line) — runs after wave 4
so it describes what was witnessed, not what was planned.

**Unfiled work implied, described not numbered:** the S9 projection down to the local scene (on a
ruling); the words plane with per-person opt-in and collector-side redaction (prd-37 ruling 3,
unparked or not); device-flow key mint from the CLI; a floor for audit; journal rotation on the
team server; multi-replica or zero-downtime migration; an archive destination off the VPS;
prd-37 itself, whose product this data layer exists to serve and whose unparking is a separate
blessing.

## Open questions

- **Does any member ever need teammates in their local picture (S9)?** Decides whether anything
  flows down, and therefore whether the veil and retention questions apply to a projection. Open,
  not ruled.
- **Pseudonymising `author.email` and stripping path prefixes at the shipper** — the alternative
  ruling 6 declined for v1, at the price of the digest identity. Comes back if the team boundary
  ever widens past one organisation or if the leads flip ruling 6 at blessing. Open, not ruled.
- **Device flow for a CLI-side key mint**, so a member never pastes a key from a browser. The
  secret-free flow is proven by documentation only (s5). Open, not ruled.
- **Does spend by person need consent separate from the words veil?** prd-37's own question,
  answered here only by construction (no ranking, no per-person comparison surface). Open, not
  ruled.
- **Journal rotation and a `DROP` at 24+ monthly partitions** — neither measured; v1 says out of
  scope. Open, not ruled.
- **Who admins the VPS and holds the first project's key** — an operator act the wave-0 list
  books; the answer is recorded on the wave-4 issue, not here. Open, not ruled.

## Amendment — the human plane is a GitHub App, and wave 0 is recorded (operator, 2026-09-08)

Ruled in session after wave 1 landed. Ruling 8's machine plane — `rzk_` keys, the hash, the
per-batch revocation check — and its "the planes never meet" clause are **untouched**. Only the
human half changes, and wave 0's list is recorded rather than restated.

### Ruling 8's human plane, amended

Ruling 8 says the browser viewer signs in through **the OAuth web flow**. It does not. What was
built is a **GitHub App**, and the difference is the reason it was chosen: an OAuth App acts *as*
whichever person signed in, borrowing their permissions; a GitHub App is its own identity,
installed on an organisation, its powers chosen from a list at creation and readable by anyone
afterwards.

As built on 2026-09-07:

- The app is **`rhizomorph-team-server`**, installed on **`rhizomorph-team`** — rhizomorph's own
  organisation, not the cohort's coursework org. Membership of that org remains the entire access
  boundary, exactly as ruling 8 has it.
- Its permissions are **Organization → Members → Read-only, and nothing else**. No repository
  access of any kind. The rejected alternative was repository read, which would have handed the
  server every private repository each member can reach in order to answer one yes-or-no question.
- Humans are identified by **user-to-server authorization through the App**, whose callback is
  `https://rhizomorph.devacademy.life/auth/github/callback`. The **membership check runs on an
  installation token**, not the signed-in person's — so the boundary does not depend on any
  individual's grant, and one member consenting more widely than another cannot widen it.
- **The org third-party-access clause is deleted.** It was an OAuth App concern: a GitHub App is
  *installed*, not approved, so there is no restriction to approve and nothing to check. Wave 0's
  line naming it is superseded by this paragraph.
- The app receives no webhooks; the webhook is off.

Unchanged and still binding: the check is `GET /orgs/{org}/members/{user}` — 204 is a member,
anything else is not, and **`state: pending` is not a member** (#169). An invitee who never
accepted returns 404 by construction, so the pending clause survives the switch with no special
handling.

### Wave 0, recorded

Wave 0 was booked as six operator acts. Where it actually stands, so this document stops implying
all six happened at the blessing:

| act | state |
|---|---|
| the leads bless this document, rulings 6 and 9 as written | **done** — 2026-09-03 |
| the three ADRs move `proposed → accepted` | **done** — 0033, 0034, 0035 |
| the organisation exists and an owner is named | **done** — `rhizomorph-team`, 2026-09-07 |
| the VPS exists with a hostname, and an admin is named | **done** — `rhizomorph.devacademy.life` |
| the identity app is registered and installed | **done** — as amended above |
| the first project's key holder is named | **ruled otherwise** — below |

**Responsibility is collective, not named.** Wave 0 asked for named individuals: an org owner, a
VPS admin, a key holder. The cohort ruled instead that **everyone is responsible for every part**.
That is the answer, and it closes the open question *"Who admins the VPS and holds the first
project's key"* above — which is left standing rather than deleted, because it is the question this
paragraph answers.

One consequence travels forward rather than being argued here: wave 4 requires a **timed drill**,
and a drill is performed by a person. Collective responsibility settles who *may* act; it does not
settle who *will*. Wave 4's issue names whoever ran it, at the time they run it.

**Backups are parked, and wave 4 narrows accordingly.** No off-VPS backup destination was
provisioned. Wave 4's *"backup/restore verified by digest"* therefore cannot be witnessed as
specified: a dump written to the same machine as the database is not a backup, and this PRD must
not record a green drill against one. What wave 4 **can** still prove is ruling 13's **restore
ordering** — restore runs into the empty database before the app's first boot, the step whose
reversal the install spike found produces `duplicate key` errors. Wave 4 proves the ordering. Until
a destination exists the deployment has no recovery story, and the runbook says so in those words.

### Two facts wave 0 did not book, found since

- **The Linode account belongs to the academy, not the cohort.** The team holds root on the machine
  but not the account, so the instance can be resized, rebuilt or removed without notice. It is a
  single point of failure for the whole deployment and cannot be fixed from inside it. Recorded
  here so it is not rediscovered during wave 4.
- **`README.md` serialises this PRD.** Ruling 12's Trust rewrite, `connect team`, `rhizomorph
  archive` and the wave-5 sweep each require it;
  `packages/server/src/cli/cli-surface-law.test.ts` forces any new top-level subcommand to touch
  it, in both directions; and `.swarm/coupling.txt` allows **one** claimant per wave. Four waves
  therefore queue on one file. The Sequencing section above is written as though those pieces are
  independent, and they are not — wave 2 was regroomed to a single issue on discovering it.

## Amendment — the fold's dedup targets the partition, not the parent (operator, 2026-09-08)

Rulings 4 and 5 could not both hold. The collision was found while planning wave 2 (#355) and
settled by **execution against PostgreSQL 18.4**, not by reading the manual — every verdict below
was run, and the errors are quoted verbatim from the server.

### The contradiction, executed

Ruling 5 declines the unique key and points at ruling 4 for dedup: *"The natural unique key cannot
exist on a ts-partitioned table; dedup is ingest's (ruling 4)."* Ruling 4's mechanism is
`INSERT … ON CONFLICT (project, actor_instance, n) DO NOTHING` — a request for precisely the key
ruling 5 just declined. Both halves are confirmed:

```
ERROR:  unique constraint on partitioned table must include all partitioning columns
DETAIL:  UNIQUE constraint on table "events" lacks column "ts" which is part of the partition key.

ERROR:  there is no unique or exclusion constraint matching the ON CONFLICT specification
```

Ruling 5's observation is correct. Ruling 4's statement, run against the table ruling 5 specifies,
does not execute. It fails loudly rather than silently, which is the good version of this problem,
but wave 3's ingest cannot be written as ruling 4 reads today.

### The ruling — the insert targets the month's partition

**Ruling 4's clause is unchanged.** `ON CONFLICT (project, actor_instance, n) DO NOTHING` stands
exactly as written. What changes is the relation it is aimed at: the fold worker inserts into the
**partition covering the batch's `ts`**, not into the parent. Against a partition, the targeted
inference finds that partition's own unique index and behaves as ruling 4 intends — an exact
replay dedups to one row, EXECUTED.

**Ruling 5's index list gains** a unique index on `(project_id, actor_instance, n)` **on each
partition**, created with the partition. Its sentence is amended to *"the natural unique key cannot
exist on the partitioned table; it exists on each partition"* — the original observation was true
of the parent and was read as true of the design.

**A new invariant, because it is load-bearing and was never stated:** the same
`(project, actor_instance, n)` always carries the same `ts`. It holds by construction today — `ts`
is read from the event line, and `n` addresses that line — but nothing said so, and dedup depends
on it. EXECUTED: the same key inserted with a `ts` one month later lands in the next partition and
produces **two rows**. Per-partition uniqueness cannot see across a partition boundary. A shipper
that ever recomputed `ts` rather than reading it would silently break dedup at every month
boundary, and no error would appear anywhere.

**Naming, reconciled:** ruling 4 writes the column `project`; ruling 5's schema declares
`project_id`. The column is `project_id` everywhere, including in ruling 4's clause.

### Two rejected options, and why each lost

**Fold `ts` into the key** — `UNIQUE (project_id, actor_instance, n, ts)`. The parent accepts it and
an identical replay dedups to one row. Rejected because it does not dedup: EXECUTED, **one
microsecond** of `ts` drift produces two rows. It removes the error while leaving the duplicate,
which is worse than the failure it replaces — and it would have changed the position key that
ruling 3 and wave 1's wire are built on.

**Untargeted `ON CONFLICT DO NOTHING` against the parent**, relying on per-partition indexes. This
works for the intended case, and was the obvious repair. Rejected on a measured failure: an
untargeted `DO NOTHING` skips **any** unique violation. EXECUTED — with a second unique index on
the partition (`event_id`), a row carrying a brand-new `(project_id, actor_instance, n)` and a
colliding `event_id` was **silently dropped**. That is precisely the gap in `n` ruling 3 forbids,
created with no error emitted anywhere. Targeting the partition names the constraint, so the same
collision raises instead:

```
ERROR:  duplicate key value violates unique constraint "ev3_09_eid"
```

This is also why **`event_id` is stored but never uniquely indexed** (ruling 5), a clause whose
cost was previously unstated: with the targeted insert the swallowing case is unreachable, and the
schema law that forbids the index is what keeps it that way.

## Amendment — the wave numbering, as built (operator, 2026-09-09)

The Sequencing section above stays as the plan of record and still reads correctly as the *intent*:
which pieces exist, what each one owes, and what territory is refused. It is no longer the
**numbering**. Three constraints split its waves, each found by running into it rather than by
foresight, and this amendment records the map so the next groomer inherits it instead of
rediscovering it lane by lane.

### What split them

1. **One migration-adding lane per wave.** `packages/team/src/migrations/schema-law.test.ts` pins
   an exact enumeration of every migration file, so any lane adding one edits the same line. Ingest
   needs the per-partition unique index the 2026-09-08 dedup amendment requires; membership needs a
   keys table. They cannot be siblings.
2. **One `README.md` claimant per wave.** `.swarm/coupling.txt` says so, and
   `packages/server/src/cli/cli-surface-law.test.ts` enforces that `cli/index.ts`'s dispatch table
   and README's CLI reference name the same subcommands **in both directions** — so every new
   top-level command needs README. Four pieces of this PRD do: the shipper's Trust rewrite
   (ruling 12), `connect team`, `rhizomorph archive`, and the wave-5 doc sweep.
3. **The original wave 2 was not parallel.** Ingest and membership both needed `packages/team` to
   exist, which made them a stack wearing a bundle's clothes. The package became its own wave.

### The map

| wave | what | state |
|---|---|---|
| 0 | operator acts | recorded in the 2026-09-08 amendment above |
| 1 | the Keystone — the wire contract, the fifth hand's law, record-format Law 2 | **merged** (#257, #258, #259) |
| 2 | `packages/team`: the storage port, ruling 5's schema, the migration runner | **merged** (#355) |
| 3 | the shipper, outbound only (#372) · the ingest journals before it acks (#373) | **merged** (#386) |
| 4 | seal → archive → verify → tombstone → prune · membership is the boundary and a key is a hash | not groomed — archive claims README, membership claims the migration and the wave's single dependency |
| 5+ | the three questions and the read-only role · retention under a named ceiling (rulings 9, 10) · the team server's doctor and `/connect`'s row (ruling 12's second half) · one image from `init.sh` (ruling 13) · #169 · #171 · the doc sweep | not groomed |

Wave 5 and beyond are deliberately left as a set rather than a split. Every split above was forced
by a constraint discovered at grooming time, and inventing one now for work whose fences nobody has
derived would be the same guess this amendment exists to correct.

**Consequence for issue titles.** A `w<N>` in an ungroomed issue's title is provisional — #169,
#171 and #354 all carry numbers assigned before this renumbering. The ordering they encode binds;
the digit does not, until that wave is groomed.

### Ruling 12's roadmap citation has rotted

Ruling 12 closes *"the Langfuse-forwarder gate in `docs/roadmap.md:328-331`"*. Those lines now
carry prd-26 prose about the pi collector; the gate itself is the bullet beginning **"A Langfuse
forwarder"**. The shipper issue cites it by that text. Left here as the correction rather than
edited in place, because the citation is real provenance for where the gate was when ruling 12 was
written — and because a line-number citation into a file that moves is the failure
`.swarm/coupling.txt` already records for `scripts/gate.sh`.

### The renumbering invalidates three wave citations elsewhere (review of #375)

The consequence above is scoped to issue titles. Its sibling is **wave numbers cited in tracked
files**, and nothing reads those: `packages/server/src/doc-citation-law.test.ts` resolves
backticked paths and checks issue numbers against the tracker ceiling, so a renumbering can
invalidate every `prd-51 wave <N>` in the corpus with the whole suite green. Swept by hand
instead — five such citations exist, and three no longer hold:

| where | anchor text | said | as built |
|---|---|---|---|
| `packages/server/src/shipper/hand-law.test.ts` | *"wave 2: the re-serializer this would test does not exist yet"* | wave 2 | **wave 3**, the shipper (#372) — and the re-serializer now exists, merged with the keystone |
| `packages/server/src/shipper/hand-law.test.ts` | *"DEFERRED to prd-51 wave 3: the row"* | wave 3 | **wave 5+**, with the team-server doctor (ruling 12's second half) |
| `docs/adr/0035-the-watcher-is-never-a-container.md` | *"one meaning and one timed drill (prd-51 wave 4)"* | wave 4 | **wave 5+** (#171) |

Anchored on quoted text rather than line numbers, for the reason the section above gives.

The first two are the ones that cost something. `packages/server/src/shipper/hand-law.test.ts` is
in #372's fence and its docblock rests on those digits — *"clause declared deferred, by name and
by wave, is honest instead"*. Under this map a wave-3 lane reads clause 5 deferring to **its own
wave**, while #372's body rules the `/connect` row out of scope. That correction belongs in the
shipper's commit, where the fence already allows it, not here.

The other two citations were checked and still hold:
`docs/adr/0033-the-record-travels-by-protocol.md` puts record-format Law 2 in wave 1, which the
renumbering did not move, and `docs/prds/done/prd-52-the-world-composes.md` gives the doc sweep to
wave 5, which stays the floor of the 5+ set.

## Amendment — two wedges, two rulings: 15 (the hand) and 16 (the fold) (operator, 2026-09-10)

Wave 3 shipped both halves of the wire and the review of #386 found the same defect on each side
of it: **a single line the layer cannot process stops that layer forever, and reports nothing.**
The two are structurally identical and their answers are not, because the hand can record a gap
and the fold cannot. Both were filed as needing a ruling before dispatch (#399, #410) and both are
ruled here, before any code.

Neither is a new discovery of *policy*. Ruling A — declared in wave 3 by
`packages/server/src/shipper/ship.ts`'s module docblock, not in this document, and named there as
one of *"the two policies wave 1 deferred to this issue"* — already refused a permanent wedge in
terms: *"refusing to advance wedges the hand permanently on one pre-#292-era line and denies the
whole ledger from that byte onward"*. What the review found is two paths that reach none of ruling
A's machinery, so the wedge it forbade exists anyway, twice.

### The two wedges

**On the hand.** `shipActor` reads at most `MAX_READ_BYTES` (1,048,576) per actor per tick. A line
longer than that window contains no newline inside it, `splitLines` yields nothing
(`splitLines` in `packages/core/src/wire/split.ts` appends only on a `NEWLINE` byte), and the pass returns
`unchanged(null, null)`. That is `ok: true` with an empty failure list: the next tick reads the
same window and does the same thing forever, the cursor is never written for that actor, and the
ordinary line sitting behind the fat one never leaves either. Ruling A's own case at least tells
the operator something is wrong; this one does not.

**On the fold.** `runOnce` (`packages/team/src/fold/worker.ts`) assembles every row from
every record past the cursor **before** it opens the transaction, and returns on the first
refusal. So one line whose type this build does not declare discards the records *before* it as
well as after — nothing is inserted, the cursor file is never created, and every actor in the
journal stops, not only the skewed one. The ingest cannot catch it and deliberately: ruling 4's
ordering 1 journals and answers 202 before anything parses, so the sender has already been told
the batch is durable and has already advanced under ruling A.

Both reproductions are EXECUTED and recorded on their issues (#399 three identical passes, #410
three identical passes with four good lines landing nowhere); neither is restated here. What
follows is REASONED from the tree read at `ce12c093` — the code citations above, and the DDL
citation under ruling 16 — with the one execution each ruling turns on named where it is owed.

### Ruling 15 — a line the hand cannot read in one window is a skip, like any other line it cannot send

**Ruling A is extended, not amended.** Its clause stands exactly as written; what changes is that
one more condition reaches it. An oversized line is a line this hand cannot send, which is the
category ruling A already answers: the position is consumed, nothing is sent for it, and the skip
is recorded with its `n`, its kind and its reason. `ActorSkip.kind` gains `'oversized'` beside
`'unknown'` and `'malformed'`, and ruling 3's local restatement is unchanged — *no duplicates in
`n`, and every gap in `n` is a skip this machine recorded and can name.*

**That widens a versioned on-disk schema, and the read side is made lenient in the same commit.**
Ruling 16 spends two paragraphs establishing that its store needs no migration; ruling 15's
counterpart store has an enum and this ruling was silent about it until the review of #417 said
so. `actorSkipSchema.kind` is `z.union([z.literal('unknown'), z.literal('malformed')])` inside
`shipperCursorSchema`, whose `version` is `z.literal(CURSOR_VERSION)` — so a cursor carrying
`'oversized'` fails validation on any build that predates this ruling, and that actor resets to
`offset 0, n 0` and loses its recorded skips. EXECUTED in the review, quoted on #417.

So the ruling asks for the property, not the enum: **a cursor written by a newer build stays
readable by an older one.** `kind` tolerates a value it does not recognise rather than
invalidating the entry that carries it. The precise shape is the lane's.

**A `CURSOR_VERSION` bump is rejected, and this is the interesting half.** It is the obvious
answer and it is worse: `version` is `z.literal(CURSOR_VERSION)`, so bumping to 2 makes every
existing v1 cursor unreadable and resets **every** actor at upgrade — a certain cost paid to avoid
a conditional one. Leniency is also only free right now, because nothing is deployed: the shipper
merged in wave 3 and the first real host is wave 5+. That is the same "last commit in which this
is true" argument `0001_events.sql` records for its one legal edit, and it should be spent
deliberately rather than discovered later.

**What the reset would cost if it happened anyway**, since the ruling should not overstate its own
necessity: `0004_events_dedup.sql` puts a unique index on `(project_id, actor_instance, n)` per
partition and the fold's projections are fed only inserted rows, so a re-ship of an append-only
ledger dedups. It is wasteful, not corrupting. What the leniency buys is that the path stops being
routine — hit the oversized-line bug, roll back the release that fixed it, and the cursor written
in between is what resets you.

**The discriminator is `size - before.offset`, not the window's contents.** A window with no
newline has two possible causes and they must not be conflated: the writer has not finished the
line yet, or the line is genuinely longer than the window. When `size - before.offset` is at most
`MAX_READ_BYTES` the whole remainder was read and its tail is simply unterminated — that is a
partial write, and the correct answer is the current one, wait. When `size - before.offset`
**exceeds** `MAX_READ_BYTES` and the full window still holds no newline, the line is already at
least a megabyte with no terminator inside it, and no amount of waiting shortens it. Only the
second case skips. This is the falsifier #399 named, and it resolves: a safe discriminator exists,
so the fallback to (2) or (3) is not reached.

**The skip must advance past the whole line, not past the window.** Consuming 1 MiB of a longer
line would leave the remainder to be read as a fresh line, which would ship a fragment under a
position. The advance is to the next newline in the file, found by reading forward from the
window's end **in bounded chunks** — the forward scan looks for a byte, so it never needs the line
resident, and reading the remainder into memory to find it would reintroduce the exact allocation
this ruling rejects option 3 for two paragraphs down.

**An oversized line with no terminator anywhere names a failure. That arm, and only that arm.**
The clause above originally ended *"if EOF arrives first, the line is still being appended and the
skip does not happen this tick"*, and the review of this amendment showed that sentence recreates
the defect #399 exists to close. A ledger whose last line is oversized and never terminates — the
writer died mid-line, the tail was truncated, the session was abandoned — hits EOF on every
forward scan, on every tick, forever. Under that clause it never skips, and having rejected option
2 the lane was forbidden the other escape, so the pass returns `ok: true` with an empty failure
list: byte-identical to #399's own three-pass reproduction. So: when the remainder exceeds
`MAX_READ_BYTES` and no newline exists anywhere between the cursor and EOF, `shipActor` emits a
named `ShipActorFailure` for that actor.

This is not option 2 revived. Option 2 named a failure for **every** oversized line and never
advanced; this names one only in the arm where there is no line boundary to advance to, because a
terminator that does not exist cannot be waited for and cannot be skipped past. #399's Definition
of done asks that the pass be legible — *"either it advances, or it names a failure"* — and the
two arms together are what supply that: a terminated oversized line advances, an unterminated one
is named. Every other actor in the pass still ships, exactly as ruling B already arranges.

**Rejected: grow the window** (#399's option 3). It preserves every line, and it puts an unbounded
allocation on the operator's own machine keyed to a value nothing upstream bounds —
`packages/core/src/events/beacon.ts` caps its own strings and nothing else caps anything. The
measured centre is 280–415 bytes per event across four machines (Evidence, above); a line three
thousand times that is a defect wherever it came from, and the hand's job is to stay legible in
its presence, not to carry it.

**Rejected: a named failure that stays put** (#399's option 2). Honest, and it does not lose the
line — but it denies every line behind the fat one for as long as no human acts, which for an
append-only ledger may be never. That is the outcome ruling A exists to refuse, made visible
rather than made survivable.

**What this costs, stated plainly:** one ledger line per occurrence never reaches the team server,
and the gap in `n` is nameable in the cursor, in `--status` and in `doctor`. That is the same
price ruling A already charges for a pre-#292-era line.

### Ruling 16 — a line the fold cannot read lands unparsed; the fold is per actor

**An unfoldable line is stored, not refused and not quarantined.** `readEventLineLenient` already
returns the envelope's `type` and `ts` and the line **verbatim** for exactly this case
(`packages/core/src/events/index.ts`, `UnknownEventLine`: *"preserved byte for byte (prd17 ruling
3, item 1: never silently dropped)"*). `toEventRow` throws that away and refuses. It stops doing
so: the row lands with its `type` recorded, its `line` untouched, and its payload whatever the
line carries — `laneOf` and `worktreeOf` already read a payload defensively and return `null`
rather than assuming a shape. What the row must **not** do is reach the projections, which is the
clause below and the one this ruling originally got wrong.

**`unknown` only — `malformed` still refuses, loudly.** This is the falsifier #410 named, and the
lenient reader already answers it: `parseEventLenient` returns `unknown` when the envelope (`id`,
`ts`, `source`, `type`) validates and the union does not — the newer-era case — and `malformed`
when there is no envelope or no usable timestamp at all. Its own words are *"calling that 'a newer
era' would be a lie, and the loud failure is the right answer."* Ruling 16 lands the first and
changes nothing about the second: a corrupt line still stops the fold, because a corrupt line in a
journal the ingest fsynced is a fault in the journal, not skew between two builds. So the
distinction the falsifier demands is not one this ruling has to invent — it is the boundary
`packages/core/src/events/index.ts` is already drawn on, and `UnknownEventReason`'s two arms are
what carry it into the row.

**An unfoldable row never feeds a projection, and this clause is owed to a failed falsifier.**
Ruling 16 first deferred one check to the implementing commit — that no projection counts a row
whose type it does not recognise. The review of this amendment ran it instead of waiting, against
the same `ce12c093` this document reasons from, and **it fails**:

```
spend(unknown-type)  = [{"projectId":"p1","day":"2026-09-10","costUsd":0,"events":1}]
spend(unknown-shape) = [{"projectId":"p1","day":"2026-09-10","costUsd":42.5,"events":1}]
lanes(unknown-shape) = [{"projectId":"p1","lane":"lane-a","state":null,…}]
```

`projectionsFor` increments `spend.events` unconditionally, and `costUsdOf`
(`packages/team/src/fold/projections.ts`) reads `payload.costUsd` with **no `row.type` guard at
all** — so under the ruling as first written, forty-two dollars fifty from a line this build
refused to parse lands in a money projection. `agentStateOf` and `dirtyFiles` do gate on
`row.type`, which protects them from an unknown *type* and not at all from an unknown *shape*.

**The `costUsd: 0` on the `unknown-type` row above is the fixture, not a guard.** Nothing
protected that arm; the probe's unknown-type line simply carried no `costUsd`. Give it one and it
leaks identically, because `costUsdOf` never looks at `row.type` — which is what makes the money
clause below wider than the type/shape split, and why reading the table as evidence that the split
is what matters for `costUsd` would be exactly backwards.

**The sibling this ruling missed.** It split `unknown` from `malformed` — #410's stated falsifier
— and never split `unknown-type` from `unknown-shape` one level down. `unknown-shape` means the
type **is** known and the payload failed the union, so it walks straight through every guard
written against the type. That is the defect shape this repo names in its own runbook: a fix that
correctly handles the case its author considered and misses the structurally identical sibling.

**Two verdicts, and they differ.** `spend_by_project_day.events` counting an unfoldable row is
**correct** — it is an event, it reached storage, and a count of events that silently omitted some
would be the dishonest answer. Every projection that reads a **payload field** — `costUsd`,
`agentStateOf`, `dirtyFiles`, and anything later joining them — must not read one the build
refused to validate. So the falsifier is narrowed to what it should always have said: *no
projection may derive a value from an unvalidated payload*, and it is answered here rather than
deferred.

**Mechanically, the row carries its own verdict, and the derived columns are nulled at source.**
`EventRow` gains an `unfoldable` marker that the Postgres adapter does not persist — it is a
fold-time fact, not a column, so this stays a no-migration ruling and the wave's single
migration-adding lane is still unspent. `projectionsFor` reads it for the values it derives
itself: `costUsdOf`, `agentStateOf`, `dirtyFiles`.

**But two of the four values do not arrive that way, and the first draft of this clause missed
them.** `row.lane` and `row.worktree` are derived **upstream**, in `toEventRow`, by `laneOf` and
`worktreeOf` — neither gated on anything — and reach `projectionsFor` as ordinary columns. A
marker read inside the projection cannot see a derivation that already happened: the projection
reads a column, it does not derive a value. So the remedy as first written closed the money leak
and left `lane_state` receiving a lane **and** a worktree from a payload the build refused to
validate, keyed on that lane, for `unknown-type` and `unknown-shape` alike. EXECUTED in the review
of #417, which applied this clause exactly as written and showed `spend` closing while `lanes`
did not move.

**The answer is upstream, not a second guard.** For an unfoldable line `toEventRow` sets `lane`
and `worktree` to `null` at the point of derivation, and `projectionsFor`'s existing
`if (row.lane !== null)` then skips the branch with nothing added. `collisions` is covered by the
**marker**, not by the type gate — the review of #417 wrote that reason down wrongly and it is the
amendment's own conflation restated: `dirtyFiles`' `row.type` gate protects the unknown-*type* arm
and nothing else, so an `unknown-shape` `worktree.dirty` walks straight through it. EXECUTED: with
the marker check removed from `dirtyFiles` and the type gate left standing, one such line puts
`[{"path":"src/a.ts","lanes":["lane-a"]}]` into `collisions`. It is covered because `dirtyFiles` is
one of the three values `projectionsFor` derives itself, which is the clause above. This is `row.ts`'s own rule applied to the case it was
written for — *"inventing one from `branch` or from the worktree path would put a fact in the
column that no collector asserted"* — and a payload this build could not validate has asserted
nothing this build can read. The cost is that `events.lane` and `events.worktree` are null on that
row; it is recoverable and therefore acceptable, because `line` is preserved verbatim and a later
build that can fold the type re-derives both from it. Ruling 16's preservation promise rests on
`line`, never on a derived column.

This does put `storage/contract.ts`, `fake.ts` and `postgres.ts` back inside #410's boundary; the
fence records it, and a `fold_status` **column** is rejected for the reason the in-memory marker
exists — it would spend the migration and persist a fact about this build's vocabulary as though
it were a fact about the event.

**The envelope's `id` and `source` are widened into core, not re-parsed.** `EventRow` requires
`eventId`, `source` and `payload`, all non-nullable, and `UnknownEventLine` carries none of them —
`eventEnvelopeProbeSchema` validates `id` and `source` and then discards both. So ruling 16 as
first written was not implementable inside #410's fence at all, which the amendment should have
said. It is resolved by adding `id` and `source` to `UnknownEventLine`: additive, in the one place
that already proved them, and it keeps `row.ts`'s own rule intact — *"a second parser is a second
allowlist, and two allowlists is how a dropped field finds its way back."* Re-`JSON.parse`ing the
verbatim line inside `row.ts` was the alternative and is rejected on that sentence.

**There is no gap, so ruling 3's invariant is untouched.** This is the whole reason it beats a
quarantine table: ruling 3 promises no gaps in `n` among what reached storage, and a row that
landed is not a gap. Ruling 5's claim rests on the same fact from the other end — *"a record
rebuilt from server rows closing to the identical `chainDigest` as the local export"* — and a
rebuild that had to union `events` with a quarantine relation to close would be a weaker claim
wearing the same words.

**It costs no migration.** `events.type` is declared `text NOT NULL` in
`packages/team/src/migrations/0001_events.sql` with no CHECK, no enum type and no foreign key —
grep the migrations directory for `CHECK`, `CREATE TYPE` and `REFERENCES` and it returns nothing.
That is load-bearing for this ruling and for the wave: the 2026-09-09 amendment records *one
migration-adding lane per wave* as the constraint that split waves 3 and 4, and this answer does
not spend it.

**The blast radius is bounded regardless: the fold runs per actor.** #410's option 3 is adopted
alongside this, because it is cheap and because it is right whichever answer the line question
got. `runOnce` **will group** the records past the cursor by `(project, actorInstance)` so that
one group's failure stops that group only — it does not today, and the paragraph two screens up
describing its flat loop is the tree as it stands. Every other sentence in this amendment is a
statement about `ce12c093`; this one is a prescription, and it is marked because a document whose
framing is *"REASONED from the tree at `ce12c093`"* cannot afford two present-tense sentences about
one function where only one of them is true. A cursor that is one number per journal cannot express that, so the
cursor grows a per-actor low-water mark and the journal cursor advances to the lowest of them —
the same shape the shipper's own cursor already has, and the reason it is named here rather than
left to the lane.

**Rejected: quarantine the position** (#410's option 1). It preserves progress and names the gap,
which is the form ruling A accepts on the hand's side — but it costs a table, a migration, and the
weakened digest claim above, to record a fact the row itself can carry. The asymmetry is real and
is the reason the two rulings differ: the hand *cannot* store what it cannot re-serialize, because
`reserializeLine` hands back no bytes for a non-`line` verdict and protocol v1 has no arm for a
placeholder. The fold can, because the bytes are already in its hand.

**Rejected: refuse at ingest** (#410's option 4). Parsing before the 202 contradicts ruling 4's
ordering 1 in terms — journal, then ack, nothing parsed on the hot path — and ordering 1 is not a
preference: it is what bought *75 kills, 0 lost, 1,129,197 lines in 15.32 s*. Rejected as the
amendment to ruling 4 it would be, not passed over as an implementation detail.

**The falsifier that remains owed, and it is a mutation.** The clause above is a rule about the
tree as it will be, so the implementing commit owes the mutation that proves it: remove the
`unfoldable` check from `projectionsFor` and the case asserting no unvalidated payload reaches a
projection must go red. If it stays green the check is not being exercised and the ruling is
unenforced, whatever the code says.

### Consequence for the wave-4 fences

`scripts/fence-lint.sh 387 398 399 410` failed on one overlap: #399 and #410 both claimed
`docs/prds/prd-51-the-split.md`, each expecting to write its own ruling. Both rulings are written
here instead, so **both issues drop this file from their fences** and the two lanes are parallel
again.

**#410's boundary then moved twice, in opposite directions, and the second move is the review's.**
Ruling 16 as first written made the migrations directory and the storage port unreachable, so both
conditional entries came off and the fold's own cursor module went on for the per-actor low-water
mark. The review then found the ruling unbuildable inside what was left. So the storage port
returns — `storage/contract.ts`, `fake.ts`, `postgres.ts` and their tests, for the `unfoldable`
marker — and `packages/core/src/events/index.ts` with its lenient tests joins them, for `id` and
`source` on `UnknownEventLine`. The migrations directory stays out, and that is the line that
matters: the wave's single migration-adding lane is still unspent, which is the whole reason
ruling 16 beat a quarantine table.

**And the widening collides with a live lane, which is why #410 is not dispatchable yet.**
`packages/core/src/events/index.ts` is held by #407 (prd-55 wave 5, In progress), which is adding
four lab event types to it. Two additive edits to one file by two lanes landing days apart is a
rebase conflict already scheduled, and this repo has paid for that reading once — #405 and #400
conflicted in a guide while both PR bodies predicted only a count pin. So #410 is blocked by #407
and moves back to Backlog; #387, #398 and #399 are unaffected and stay Ready. Taking the
re-`JSON.parse` route instead would clear the collision, and it is refused: a permanent design
compromise is the wrong price for a temporary scheduling one.

Widening a fence is legitimate and is recorded before the change, which this is. But the shape is
worth naming for whoever grooms wave 5: **the first fence was derived from a ruling nobody had
built against.** Both moves came from reading the types the ruling would have to satisfy, and
both were available at grooming time. Re-lint before dispatch rather than trusting the pass this
document already reports.

## Amendment — the wedge wave took number 4, and wave 5 is groomed (operator, 2026-09-11)

The 2026-09-09 map above put *seal → archive → verify → tombstone → prune* and *membership is the
boundary* at wave 4. The 2026-09-10 *two wedges* amendment then filed #387, #398, #399 and #410 as
**wave 4** and did not renumber the map, so from that day the archive/membership pair had no wave
number at all and the map read as describing work that was already in flight. Wave 4 as built is
the wedge wave: three of its four issues landed in PR #425, merged as `a3c5b305` on 2026-09-11,
and #410 follows in its own PR.

**The pair moves to wave 5 and beyond.** Everything the old map listed as "5+" moves with it, one
place down. That is the whole of the numbering ruling; the rest of this amendment is what grooming
found when it tried to build the new wave 5 out of the pair.

### Wave 5 is not the pair, because #410 is live in `packages/team/src/`

Membership needs a keys port, and a keys port is `storage/contract.ts`, `fake.ts` and
`postgres.ts`. **#410 already holds all three** — the *Consequence for the wave-4 fences* section
above widened it onto them for ruling 16's `unfoldable` marker, and #410 is still open, still
blocked by #407. Grooming membership into a wave that dispatches before #410 lands would bundle
across a live fence, which this document has already refused once in the paragraph that widened it.

So wave 5 was inverted: **it touches no path under `packages/team/src/` at all.** Membership goes
to wave 6, behind #410, where it can have the storage port and the wave's single migration
uncontested.

### The map, superseded

| wave | what | state |
|---|---|---|
| 0 | operator acts | recorded in the 2026-09-08 amendment |
| 1 | the Keystone | **merged** (#257, #258, #259) |
| 2 | `packages/team`: the storage port, ruling 5's schema, the migration runner | **merged** (#355) |
| 3 | the shipper outbound · the ingest journals before it acks | **merged** (#386) |
| 4 | the two wedges and the doctor route | **merged** (#425, `a3c5b305`) — except **#410**, blocked by #407, its own PR |
| 5 | ruling 11's local archive command · ruling 13's image and `init.sh` · the three wave-4 deferrals | **groomed** — #432, #433, #434, #435, #436 |
| 6 | membership is the boundary and a key is a hash (absorbs #169) — needs #410 landed | not groomed |
| 7+ | the three questions and the read-only role · retention under a named ceiling (rulings 9, 10) · the team server's doctor and `/connect`'s row (ruling 12's second half) · #171's timed drill · the doc sweep (absorbs or fences #354) | not groomed |

Waves 6 and 7+ stay a set, for the reason the 2026-09-09 amendment gave and this grooming
confirmed: every split above was forced by a constraint discovered at grooming time, and the
remaining team-package pieces collide on `packages/team/src/api/http.ts` — a 126-line hand-rolled
listener — and on the one-migration-per-wave rule in ways nobody has built against yet.

### What wave 5 is, and what held it apart

Five lanes, `fence-lint.sh 432 433 434 435 436` **PASSED**: 22 paths extracted against 22 declared,
no overlap, and four coupling points owned rather than orphaned (`README.md`, `docs/architecture.md`,
and both doctor tests). Re-linted against the two live lanes and #410 — the only overlap in that
wider run is the already-recorded #407/#410 one.

- **#432** — ruling 11's `rhizomorph archive`. **The wave's single `README.md` claimant**, since
  `cli-surface-law.test.ts` binds the dispatch table and the CLI reference in both directions.
- **#433** — ruling 13's `compose.yml`, `Dockerfile` and `init.sh`, in `packages/team/deploy/`,
  which is new ground outside `src/`. Narrowed by the 2026-09-08 backup parking: it proves the
  **restore ordering** and the runbook says in those words that there is no recovery story.
- **#434, #435, #436** — the three deferrals PR #425's body parked *for this grooming*, because
  filing them needed a milestone that did not exist yet. #434 is the one labelled REASONED rather
  than executed, and its Definition of done makes refuting it an acceptable outcome.

**No lane adds a migration and no lane adds a dependency**, so neither of the two one-per-wave
rules is spent.

### #169 and #171 still carry their prd-48 bodies

Recorded so the next groomer does not dispatch them as they stand. Both were absorbed into this
PRD by the status line above, and neither body was rewritten: #169 fences
`docs/research/2026-08-29-shared-record-s5-pending-invite.md` and #171 fences
`docs/research/2026-08-29-shared-record-s8-vps.md`, **neither of which exists** — they were prd-48
spike outputs that were never written — and both declare blockers (#165 through #170) belonging to
a wave structure this PRD replaced. They are re-groomed into build issues when waves 6 and 7 come
up, not before. #354 is different: its body is current, and it names its own absorption into the
doc sweep as the outcome to prefer.

## Amendment — wave 5 is merged, and wave 6 is groomed into three lanes (operator, 2026-09-14)

Wave 5 landed as PR #454, merged `2784204e`: #432, #433, #434 and #435, four lanes, four commits,
cherry-picked with no conflict. **#436 is not in it.** It left the wave before dispatch and sits in
Backlog behind #427, which held `docs/architecture.md` — the ADR citation it exists to fix is in a
file another lane owned. #427 has since merged, so #436 is now unblocked and is the one piece of
wave 5 still owed.

Wave 6 is the membership-and-keys wave the map below has promised since 2026-09-11, unblocked by
#410 landing in PR #446. Three lanes, and the shape they took is not the shape the map predicted.

### The map, superseded again

| wave | what | state |
|---|---|---|
| 0 | operator acts | recorded in the 2026-09-08 amendment |
| 1 | the Keystone | **merged** (#257, #258, #259) |
| 2 | `packages/team`: the storage port, ruling 5's schema, the migration runner | **merged** (#355) |
| 3 | the shipper outbound · the ingest journals before it acks | **merged** (#386) |
| 4 | the two wedges and the doctor route | **merged** (#425, `a3c5b305`; #410 in #446) |
| 5 | ruling 11's local archive command · ruling 13's image and `init.sh` · two of the three wave-4 deferrals | **merged** (#454, `2784204e`) — except **#436**, unblocked now that #427 has landed |
| 6 | membership is the boundary · a key is a hash · the ADR ruling 8 never got | **groomed and dispatched** — #169, #462, #463 |
| 7+ | the three questions and the read-only role, and the router `api/http.ts` becomes · retention under a named ceiling (rulings 9, 10) · the team server's doctor and `/connect`'s row (ruling 12's second half) · #171's timed drill · the doc sweep (absorbs or fences #354) | not groomed |

### Wave 6 refuses the `api/http.ts` collision rather than paying it

The 2026-09-11 amendment predicted the remaining team-package pieces would collide on
`packages/team/src/api/http.ts` — *"a 126-line hand-rolled listener"* — and on the
one-migration-per-wave rule. Grooming confirmed the first and avoided it. That file is still one
route wearing a conditional (`if (path !== INGEST_PATH)` … 404), and **both** halves of ruling 8
want to add to it: the human plane wants `/auth/github/callback`, the machine plane wants the keys
dependency to reach `handleIngest`.

Only the second of those is free. `IngestDeps` is constructed in `packages/team/src/api/main.ts`
and handed to `createIngestListener`, so a keys port riding on `TeamStorage` reaches the handler
without the listener learning a second route. The first is not free, and **two narrowings follow.
Both are rulings, not omissions:**

- **The membership lane builds the check, not the route.** `packages/team/src/auth/` ships an
  injected-transport module — the installation-token JWT, `GET /orgs/{org}/members/{user}`, 204 is
  a member and everything else is not — wired to no socket. The callback route arrives in wave 7
  alongside the viewer it would exist to serve, when one lane turns that listener into a router
  once. This is the shape the package already has: `handleIngest` is *"pure of transport"* by its
  own comment, and #258 shipped the fifth hand's law before the hand had any code.
- **Ruling 8's "a member mints a key in the viewer" defers to wave 7 with the viewer.** There is no
  viewer in wave 6 to mint from. What ships is the hash at rest, the revoke flag, the once-per-batch
  check, the refusal text, and `packages/team/deploy/init.sh` seeding the first project's key by
  storing only its hash. The clause is not amended — it is unbuilt until the surface it names
  exists.

### What the three lanes are

`scripts/fence-lint.sh 169 462 463` **PASSED**: no overlaps, and the three coupling points the wave
can reach are owned rather than orphaned — `docs/adr/README.md` by #463, `bootstrap.test.ts` and
`api/api.test.ts` by #462. Re-linted against the live lanes (`169 462 463 427 436`), the only
overlap in the wider run is the already-recorded #427/#436 one on `docs/architecture.md`.

- **#169** — ruling 8's human plane, and **its prd-48 body is now rewritten**. The section above
  records that #169 and #171 both still carried bodies fencing research notes that were never
  written; that is now true of **#171 only**. #169 fences `packages/team/src/auth/` and three files
  under `packages/team/src/config/`, and its blockers are gone.
- **#462** — ruling 8's machine plane, whole, and the wave's largest lane at 14 fenced paths. It is
  one issue rather than three because the port, the migration and the ingest refusal are one causal
  chain; splitting it anywhere makes the second half depend on the first, which is a stack wearing a
  bundle's clothes. **It spends the wave's single migration** (`0005_ingest_keys.sql`, carrying its
  own `rz_ingest` grant, since an applied migration cannot be edited retroactively).
- **#463** — the ADR ruling 8 never got. Rulings 2, 3 and 13 each landed one with the blessing;
  ruling 8 is the other constitutional ruling in this document, it has been amended once already,
  and a PRD ruling dies with its PRD. It records the two planes and **two** rejected alternatives
  already argued in the 2026-09-08 amendment: an OAuth App, which acts *as* whoever signed in, and
  repository read, which would have handed the server every private repository a member can reach to
  answer one yes-or-no question.

**No lane adds a dependency** — RS256 signing and SHA-256 are both `node:crypto` — so that
one-per-wave allowance is unspent. The ADR number allowance is spent by #463.

### Grooming found a coupling nobody had registered

`packages/team/deploy/init.sh` mints the ingest key; `packages/server/src/shipper/key-mint-law.test.ts`
reads that script's `ingest_key=` line **from another package** and holds it to `INGEST_KEY_PREFIX`.
The law exists because `init.sh` once shipped a bare `openssl rand -hex 32` that `connect team`
would have refused — but the seam itself is not in `.swarm/coupling.txt`, so a lane changing how the
key is minted reddens a different package with no warning. #462 fences both sides and registers the
entry; the fence-lint WARN could never have found it, because the entry it would have fired on does
not exist yet.

### Three things this wave does not close, stated so they are not assumed

- **#436**, wave 5's straggler, is unblocked and unstarted.
- **#171 still carries its prd-48 body** — it fences
  `docs/research/2026-08-29-shared-record-s8-vps.md`, which does not exist, and declares blockers
  from a wave structure this PRD replaced. It is re-groomed when wave 7 comes up, not before. Its
  **title and board row still read `prd51 w6`**, so a `prd51 w6 in:title` search returns four issues
  where the map above names three, and `scripts/dev/issues.sh list` shows the fourth in Backlog.
  Which wave it belongs to is settled at that regrooming and not here; recorded so the next reader
  meets the disagreement as a known one rather than finding it.
- **`packages/team/src/api/http.ts` is now owed a router**, and wave 7 is where that debt is paid.
  Every piece deferred above lands on it at once: the callback route, the mint surface, the three
  questions' pages and the team server's doctor. That is a single restructuring with four callers,
  and it should be groomed as one issue rather than four lanes discovering each other in it.
- **`http.ts` carries a ruling-12 debt into wave 7, ruled rather than overlooked.** Lines 33–36 of
  that file say key-value verification is *"wave 4's and is loudly unimplemented"*. #462 made that
  false and did **not** fix it: the fix is a four-line comment edit touching no code, ruling 12
  wants it in the same commit, and the fence forbids the file. The operator declined the widening
  on 2026-09-14 — wave 6's shape is refusing this collision, and spending that property on four
  lines of prose buys nothing a rewrite does not hand over for free. The correction lands with the
  router, in the header of the file being replaced, where it cannot be missed. Recorded on #462,
  and named as a widening **considered and declined** on the wave-6 bundle PR.
