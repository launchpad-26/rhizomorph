# prd-51 — the split: the ledger ships up, and nothing leaves the team

> **Status:** proposed — drafted 2026-09-03 in session with ciaran-slow, written *from* prd-48's
> twenty research notes (`docs/research/2026-08-2*-shared-record-*.md`,
> `2026-09-02-shared-record-*.md`, all on `main` since #254) and the synthesis at
> `docs/research/2026-08-28-shared-record-architecture.md`. This is **the build PRD prd-48 named
> as its output** ("the split", prd-48 status line). It carries the constitutional paperwork
> prd-48 said must be written *with* it: three ADRs land beside this document as `proposed`
> (rulings 2, 3 and 13), and the README Trust rewrite is a wave-2 deliverable bound to the
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
