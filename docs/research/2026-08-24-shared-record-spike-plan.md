# The shared record — research spike plan

> **Status:** discussion draft, 2026-08-24, companion to [the design brief](2026-08-24-shared-record-design-brief.md). Follows
> the house rule — *research → verify → build*: a claim you only read is a hypothesis; a claim you
> ran is a fact (`~/.claude/skills/research/`). Each spike below is bounded, has a question it
> answers, names what it will **run**, names what would **change the verdict**, and lands as a
> source-graded note at `docs/research/2026-08-<dd>-shared-record-<slug>.md` before anything is
> built. Nothing here is a PRD wave; the PRD (prd-46, or an unparked prd-37 plus the split) is
> written *from* these notes and blessed before an issue exists.

## How to read this

- **Question** — the one thing the spike answers. If it answers two, split it.
- **Hypothesis** — what we expect, stated so it can be wrong.
- **Run** — the actual commands / throwaway code. Throwaways live outside the repo
  (`~/rhizomorph-spikes/<slug>/`), never on a branch that could be mistaken for product code.
- **Verdict changes if** — the falsifier. A spike without one is an opinion with a budget.
- **Output** — the table or number that goes into the note and, later, the PRD's Evidence section.
- **Budget** — wall-clock for one person with an agent; overruns are a finding, not a failure.

Numbers gate design. **S1 runs first and alone**; everything else waits on its table.

---

## S1 — the corpus, measured *(gates everything)*

**Question.** What does one person-day of telemetry actually cost in events, bytes, and
fact-classes, and how well does it compress?

**Hypothesis.** ~300–500 B/event raw; 20–60k events per busy session; ≥ 90 % of lines in five
high-frequency classes; JSONL compresses 8–12× under zstd; the durable 4 % is under 1 MB/day.

**Run.**
1. On three machines (Lachlan WSL, Gabe, Ciaran): a read-only script over
   `~/.local/share/rhizomorph/**/session-*.jsonl` producing per-session: events, bytes, duration,
   lanes, per-`type` census, bytes per type; per-repo totals; transcript-capture sizes separately.
2. `zstd -19` and `gzip -9` on the three largest logs and on one sealed portable record.
3. Events per lane-hour for the busiest hour, to size the ingest batch and the server's write rate
   at 5, 20, 100 concurrent lanes.
4. Count fixture litter (`a-repo-with-spaces-*`, `plain-repo-*`) separately — it is a finding of
   its own (no data-dir override; `scripts/pack-smoke.sh` writes into the real data root).

**Verdict changes if** high-frequency classes are < 70 % of lines (tiered retention buys little);
or compression is < 4× (archiving needs a different format); or a lane-hour exceeds ~5k events
(batching and the queue design change shape).

**Output.** One table per machine + a merged table; the **retention defaults** in the brief §6a
re-derived from it; the ingest write-rate envelope for S2/S4.

**Budget.** Half a day. **Prerequisite for the brief's numbers becoming a ruling.**

---

## S2 — the shipper round trip

**Question.** Can a tail-and-batch shipper move a ledger to a server *losslessly* — same order, no
duplicates, verifiable chain — through disconnects, crashes mid-batch, and a cold backfill?

**Hypothesis.** At-least-once delivery with server-side dedup on `(project, actor_instance,
event_id)` is sufficient; no CRDT, no two-phase anything; a 63k-event backfill completes in under a
minute on a $5 VPS; the server can re-export a record whose `verifyRecord` passes.

**Run.**
1. Throwaway shipper (Node, ~200 lines): tail `session-*.jsonl` from a cursor file, batch N lines
   or T ms, `POST /v1/rhizomorph/ingest` with `{ protocolVersion, project, actorInstance, batch[] }`,
   advance the cursor only on 2xx.
2. Throwaway server: Fastify route → in-process queue → Postgres `events` insert
   `ON CONFLICT DO NOTHING` (the accept-fast → queue → fold seam, even if the queue is an array).
3. Chaos: kill the shipper mid-batch ×20; drop the network for 5 min; replay the same batch twice;
   corrupt the cursor file; start from an empty cursor against a 63k-event log (backfill).
4. After each: `SELECT count(*)`, order check per actor, then **rebuild the portable record from
   the server rows and run `verifyRecord`** (`packages/core/src/record/verify.ts`) — the chain must
   close to the same `chainDigest` as the local export.
5. Measure end-to-end latency from append to server row at idle and under a 5-lane load.

**Verdict changes if** any run produces a duplicate or reorder after dedup; or the chain does not
close (something re-serialised a line — see `record-format.md` "How `line` is produced"); or
backfill of 63k events takes > 5 min; or live latency exceeds ~2 s (the poll interval).

**Output.** A results table (runs × outcomes), the protocol envelope v1, the latency numbers.
Feeds the successor ADR to 0009 with evidence rather than argument.

**Budget.** One day. Runs in parallel with S3 and S5.

---

## S3 — the local store: none, SQLite, or PGlite

**Question.** Does the local instrument need a database at all, and if so which one behaves on
Windows, WSL and macOS without a daemon?

**Hypothesis.** "None" is enough for v1 — prd-44's parse cache plus a JSON cursor file covers the
shipper; if a local query surface is wanted, SQLite is the boring answer; PGlite is worth measuring
for "one dialect everywhere" but its footprint or Windows behaviour will decide it, not taste.

**Run.**
1. One schema (`events` + two projections), three engines: `node:sqlite` (Node 22.5+) [V],
   `better-sqlite3`, PGlite (`@electric-sql/pglite`) [R — unverified here].
2. Load the largest real log; measure: install footprint (MB), cold start (ms), lane-index query
   (the `/api/lane-index` shape), full-session fold input read, file size vs the JSONL.
3. Each on Windows-native, WSL, macOS. Note anything that needs a native build step (prd-25's
   Windows leg cares).
4. Prove the store is **rebuildable** from the ledger: delete it, rebuild, byte-compare a projection.

**Verdict changes if** PGlite's cold start > 1 s or footprint > 30 MB or any platform fails;
or SQLite's lane-index query is not faster than prd-44's cache (then "none" wins outright).

**Output.** A 3×5 table; a recommendation with the numbers that made it.

**Budget.** One day.

---

## S4 — the server's storage shape

**Question.** Does a single `events` table with JSONB payloads and promoted columns, partitioned by
month, answer the three org questions fast enough at 10 M rows — and is partition-drop a workable
retention mechanism?

**Hypothesis.** Yes at 10 M rows with the right indexes; `DROP PARTITION` reclaims space in
milliseconds where `DELETE` would take minutes; TimescaleDB is not needed at cohort scale.

**Run.**
1. Schema: `events(project_id, actor_instance, event_id, ts, type, source, lane, worktree,
   payload jsonb, prev_hash, hash)`, unique `(project_id, actor_instance, event_id)`, monthly
   range partitions on `ts`; projections `lane_state`, `spend_by_lane_hour`, `collisions`.
2. Synthesise 10 M rows from S1's census shape (not random — the same type mix and payload sizes).
3. Time: "where is work happening" (lanes by state per person, last 15 min); "what is it
   costing" (spend by project by day, 30 d); "who is stuck" (lanes waiting > N min); a
   cross-person collision query over `tool.activity.filePath`; and one cold "replay this session"
   read of 60k rows in order.
4. Retention: `DROP PARTITION` on the oldest month vs `DELETE WHERE ts <`; measure and `VACUUM`.
5. Compaction: fold the five high-frequency classes of one month into hourly rollups; verify the
   fold over rollups+facts matches the fold over raw for the spend selectors (the golden-corpus
   discipline, `core/src/eras/era-1`).
6. Ordering: does anything in the projections change if cross-actor order uses `ts` + instance
   tiebreak vs the commit DAG? (Answers whether the DAG anchor is v1 work.)
7. RLS: one policy per project; confirm a key scoped to project A cannot read B.

**Verdict changes if** any org question > 500 ms at 10 M rows after indexing; or compaction changes
a spend number (then rollups are wrong or a selector reads something we thought was
high-frequency); or RLS adds > 20 % to ingest.

**Output.** The schema DDL v0, a timing table, the compaction correctness result, the DAG answer.

**Budget.** One to two days. Depends on S1's shape; independent of S2/S3.

---

## S5 — identity and keys, borrowed not built

**Question.** Can a cohort member sign in with GitHub, be checked against org membership, mint a
project-scoped ingest key, and have a revoked key refused — with no accounts of our own?

**Hypothesis.** GitHub OAuth (web flow for the viewer; device flow for a CLI if ever needed) +
`GET /user/memberships/orgs/{org}` [R] gives membership; keys are random 32-byte secrets stored
hashed; revocation is a row flag checked on every ingest.

**Run.**
1. Register a throwaway GitHub OAuth App on a personal account; a 100-line Fastify viewer that
   completes the web flow and checks membership of `launchpad-26` (or a test org).
2. Mint a key in the viewer; the S2 shipper uses it; revoke; confirm the next batch is refused with
   a legible reason and the shipper's `/connect`-style row flips to BROKEN with the remedy.
3. Front it with Caddy for auto-TLS on a real hostname; confirm the `Host`/`Origin` checks
   parameterise cleanly for that hostname.
4. Record exactly which GitHub scopes were needed — the minimum, named (prd-38 ruling 8's
   discipline).

**Verdict changes if** org-membership needs a scope the cohort's org admin will not grant; or the
OAuth App must hold a client secret in a place prd-38 ruling 4 forbids (then device flow, or a
GitHub App); or revocation latency > one batch.

**Output.** The two credential planes as a sequence diagram with the scopes named; the refusal
message text.

**Budget.** One day. Parallel with S2/S3.

---

## S6 — the veil, proven on the wire

**Question.** Can we *prove* that a facts-only member's words never leave their machine — not by
reading the code, by capturing the bytes?

**Hypothesis.** Yes: the event log is already facts-only by construction (closed schemas; pane text
is a hash; prompts are digests), so the shipper sends nothing word-shaped unless the transcript
sidecar is explicitly included; the only person-shaped field on the wire is git `author.email`.

**Run.**
1. Put `mitmproxy` (or a logging reverse proxy) between the S2 shipper and server; run a real
   session with known marker strings in prompts and agent output.
2. Grep the captured wire bytes for the markers, for `@`-shaped emails, for `/home/` and
   `/Users/` and `C:\Users\` segments, for `hostname`.
3. Then opt in "words" for that person and confirm the transcript sidecar goes — **redacted with
   the existing capture redaction** (`log/transcript-capture.ts:87-105`) — and nothing else changes.
4. Render the facts-only member on the throwaway team view: does anything read as degraded?
   (prd-37 ruling 3: it must read as a choice, not a gap.)

**Verdict changes if** a marker appears on the wire in facts-only mode; or the author email
question cannot be settled by policy (then hashing/pseudonymising at the collector becomes a
requirement, not an option).

**Output.** The wire inventory (every field that crosses, by event type); the author.email
recommendation with evidence.

**Budget.** Half a day, after S2.

---

## S7 — retention and archive mechanics

**Question.** Can "seal, archive, compact, prune" run end-to-end on a real data directory such that
every pruned session is still *verifiable* from its archive and every pruned lane *reads as
pruned*?

**Hypothesis.** Yes with the existing organs: build the portable record (`export-record`),
compress, write to the archive location, `verifyRecord` on read-back, then drop the raw log; the
lane index degrades to "pruned, archived at <path>, digest <…>" rather than "no such lane".

**Run.**
1. Copy a real data dir to a scratch root (the data-dir override is a prerequisite — implement it
   as a throwaway env var first; it becomes the first real issue regardless).
2. Script the four steps over sessions older than N days; time each; measure reclaimed bytes.
3. Break it: kill between seal and prune; corrupt an archive; prune a session another session's
   lane index references (prd-31 ruling 5's cross-session lanes).
4. Confirm the era-1 golden corpus and the hermetic tests are untouched (prd-44 checked this
   on paper; run it).
5. Same on the server with partitions: archive the month's records to object storage, verify,
   drop the partition.

**Verdict changes if** any failure mode leaves a session neither readable nor archived; or the lane
index cannot express "pruned" without a schema change to `laneIndex`; or reclaimed bytes are
< 50 % of what S1 predicted.

**Output.** The archive format decision (it should be the portable record, compressed — confirm),
the failure-mode table, the numbers behind the disk-budget default.

**Budget.** One day, after S1 and S4.

---

## S8 — one-click install, timed on a fresh VPS

**Question.** How long from a fresh $5 VPS to a working team view with one member shipping, and
what did a human have to type?

**Hypothesis.** Under 20 minutes with `docker compose up` + an `init` step; backup and restore work
first time; an upgrade with a schema migration is a `pull` + `up`.

**Run.**
1. Fresh Ubuntu VPS. `compose.yml`: server image (Node/Fastify from the S2/S5 throwaways),
   Postgres, Caddy. `.env` generated by an `init` script that creates the admin, takes the GitHub
   OAuth values, prints the first ingest key.
2. Time every step; record every keystroke.
3. `pg_dump` to object storage; destroy the VPS; restore on a new one; confirm the team view shows
   the same history.
4. Ship a migration (add a column); `docker compose pull && up`; confirm zero manual steps.
5. **S8b, if time:** the same server with embedded Postgres in one image (one process, no compose)
   — measure the same steps and note what became harder to debug.

**Verdict changes if** > 30 min or any step needs a database command typed by hand; or restore
loses data; or the migration needs downtime the cohort would notice.

**Output.** The install script v0, the minute-by-minute log, the backup/restore evidence.

**Budget.** One day, after S2/S4/S5 have produced something to install.

---

## S9 — the projection down *(v2 candidate; run only if the leads want teammates in the local scene)*

**Question.** What is the smallest thing the server can push to a member's local instrument so the
local scene shows teammates as neighbouring colonies and cross-person collisions, without holding
anyone's history?

**Hypothesis.** A per-project projection (people × lanes × state × files-touched-recently × spend
today) is under 50 KB, refreshes every poll interval over one SSE stream, and can live in memory
only — no local storage of teammates' data at all.

**Run.**
1. Compute the projection on the throwaway server from S4's tables; serve it over SSE.
2. Fold it into the local state as an additive slice (the prd-19 pattern: new facts, no new event
   types in the ledger, live/replay/fixtures answer identically).
3. Measure size at 4 and 20 people; staleness when a member is offline (must render "as of N
   minutes ago", prd-37 S1).

**Verdict changes if** > 200 KB or it needs to be persisted locally to be useful (then it is data,
and the veil and retention questions apply to it).

**Output.** The projection schema v0 and the size table.

**Budget.** Half a day.

---

## Sequencing and ownership

```
S1 corpus ──────┬── S2 shipper ──── S6 veil ──┐
                ├── S3 local store            ├── S7 retention ── S8 install ── (S9 projection)
                ├── S4 server schema ─────────┘
                └── S5 identity & keys ───────── S8
```

- **Week 1:** S1 (day 1, one person, all three machines), then S2 + S3 + S5 in parallel (one
  each), S4 starting once S1's census exists.
- **Week 2:** S6, S7, S8; S9 only on a ruling.
- Each note lands on `main` by PR the day it is finished (`docs(research): shared-record — <slug>`),
  in the house grading ([V]/[R]/[I], ran vs read), with the throwaway's path named so a reader can
  rerun it.
- **Then the paper:** the PRD's Evidence section is these tables; its Rulings are the leads'
  answers to the brief's §10; the successor ADR to 0009 and the amendments to 0001/0019 (a hand
  with a clock and a key, bounded) are written **with** the PRD, not after the code — the
  Langfuse-forwarder precedent (`docs/telemetry.md:459-466`).

## What is deliberately not a spike

- The scene, colonies, identity colour — prd-37's surfaces; product, not research.
- Managed hosting / a cloud we run — a business decision the metamorphosis note named and set
  aside.
- Peer-to-peer or local-first replication engines — rejected by name; a spike would be
  re-litigation.
- A load test at 100 people — S4's 10 M rows is the proxy; real scale is rung 3 and a different
  year.
