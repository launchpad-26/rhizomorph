# The observatory, proposed — a system architecture from seven executed spikes

> **Status:** research synthesis, 2026-08-28 — the "proposed full system architecture" prd-48's
> programme exists to produce, written the same day seven of its eight spikes ran
> (`2026-08-28-shared-record-s*.md`, all in this directory; S9 is gated on a leads' ruling and
> did not run). Everything below is **proposal, not ruling** — the team may accept it, re-cut
> it, or refute any line of it with a better number; each claim names the spike that earned it.
> One box (WSL2, i9-13900H, 20 cores), one day: the honest scope of "preliminary." The design
> brief (`2026-08-24-shared-record-design-brief.md`) argued this shape; the spikes now let it be
> drawn with numbers on every edge.

## The shape

```
 each member's machine                                the team's VPS ($5 rung)
┌──────────────────────────────┐                  ┌──────────────────────────────────┐
│ rhizomorph (unchanged)       │                  │ caddy (TLS)                      │
│  · loopback only, as today   │                  │   └─ ingest API  /v1/…/ingest    │
│  · ledger: session-*.jsonl   │                  │        auth: rzk_ key (hashed)   │
│  · NO local database (S3)    │                  │        ack AFTER journal fsync   │
│                              │   HTTPS, batched │   └─ journal (append-only)       │
│ the shipper (new, 5th hand)  │ ───────────────► │   └─ fold worker                 │
│  · outbound only, no ports   │   re-serialized  │        ├─ events (partitioned)   │
│  · tail ledger from cursor   │   event lines    │        └─ projections (rollups)  │
│  · re-serialize thru schema  │                  │   └─ viewer  (GitHub OIDC,       │
│  · advance cursor on ack     │                  │        org-membership = access)  │
└──────────────────────────────┘                  │   └─ retention: DROP PARTITION   │
        ▲ facts only; words never ship in v1      └──────────────────────────────────┘
        │ (transcripts are a separate class, S1)        ▲ read-only viewers; actions stay home
```

One container image + Postgres + Caddy; `init.sh` to healthz-green measured at **14.2 s** (S8).
The local instrument is untouched: still loopback, still no inbound port anywhere on a member's
machine — the shipper is an outbound HTTPS client and nothing else.

## 1 · The wire protocol, v1 (S2 — every clause below was executed against chaos)

```
POST /v1/rhizomorph/ingest        header: x-rz-ingest-key: rzk_…
{ protocolVersion: 1, project, actorInstance,
  batch: [ { n, line } … ] }      n = 1-based position in the source ledger
```

- **Lines are re-serialized through the current event schema before shipping — never raw log
  bytes.** This is the veil's load-bearing clause, discovered not designed: shipping raw bytes
  put 30,627 old-era `pane.activity.preview` fields — real terminal content including a hostname
  and OS username — on the wire, because the record's schema-allowlist protects the *record*,
  not the wire. Re-serialization strips every field the current schema no longer declares, and
  costs nothing: a record rebuilt from server rows after five kinds of chaos closes to the
  **identical `chainDigest`** as one built from the file (`verifyRecord ok:true`, bodies
  byte-equal), because `buildRecord` re-serializes both sides anyway.
- **Dedup and ordering key on `(project, actorInstance, n)` — never on the event id.** Executed
  finding: event ids are **not unique even within one session log** (`evt-000001` appears 15
  times in the real ledger; the id counter restarts on session resume). The briefed
  `(project, actor, event_id)` key silently discarded **74.5 %** of a real ledger. This also
  convicts the shipped `mergeRecords` dedup key `(actor.instance, event.id)` — a defect in
  shipped-but-uncalled code, to be filed on blessing.
- **The ack means durable, or it means nothing.** Accept-fast-into-a-process-array lost exactly
  one 500-line batch when the server died after 202. The metamorphosis proto-law's "accept fast"
  survives with one word tightened: *accept = appended to a durable journal (fsync), then 202;
  fold asynchronously from the journal.* The house already owns this shape — it is prd-40
  ruling 1 ("the append is awaited before the event is anyone's"), server-side.
- **The lossless invariant is *no gaps, no duplicates in `n`*** — not monotone arrival order,
  which a legitimate gap-repair rightly violates. Cursor: byte offset + `n`, written
  tmp-then-rename (survived 20 × `kill -9`; a garbage cursor cold-starts and self-repairs).
- Measured envelope: 63,653-line backfill in **9.82 s** (6,481 lines/s); live append→row-visible
  median **53 ms**, worst 992 ms; batch 500 / 250 ms comfortably above the measured busiest
  lane-hour (4,183 events, S1).

## 2 · Identity: two planes, never fused (S5)

- **Humans:** GitHub OIDC; the team boundary is org membership — proven live with 204/404
  semantics against `launchpad-26`; minimum scope `read:org` [docs-settled]; **device flow** for
  anything shipped to members (no client secret in a binary); the web flow's secret lives only
  in the team server's own environment.
- **Machines:** `rzk_` ingest keys — 32 random bytes, stored only as SHA-256, shown once at
  mint, revocation a row flag checked **per batch** (bounds revocation lag to one batch), refusal
  text in the prd-19 exact-remedy voice.
- Named operator acts that no spike can substitute: OAuth App registration; org third-party-
  access approval if enabled (unchecked — needs an org owner); App installation if the GitHub-App
  route is chosen instead.

## 3 · Server storage (S4 — 10 M rows, executed)

One partitioned table plus **projections that are required, not optional**:

```sql
CREATE TABLE events (
  project_id text, actor_instance text, n bigint,
  event_id text, ts bigint, type text, source text, lane text, worktree text,
  payload jsonb, line text
) PARTITION BY RANGE (ts);            -- monthly partitions
-- natural-key UNIQUE is impossible here: Postgres requires the partition key (ts)
-- in any unique constraint. Dedup therefore lives at ingest (the journal keys on
-- (project, actor_instance, n)) — which S2 independently concluded. Range-on-ts
-- is kept because it IS the retention story and the pruning story.
```

- Four of the five org questions answer in **0.19–452 ms** at 10 M rows on ordinary btrees
  (BRIN on ts; `(project,lane)`, `(type,ts)`, `(lane,ts)`).
- The fifth — cost by project by day — **fails at ~1,007 ms** (heap I/O: 1.67 GB read for 90
  rows; a covering index does not fix it) and a **materialised daily rollup answers in 0.13 ms**
  (7,700×). The fold worker maintains rollups (`spend_by_project_day`, `lane_state`,
  `collisions`) beside the events table; the events table stays the rebuildable truth.
- **Retention = `DROP PARTITION`: 3.53 s** returning all bytes immediately, vs 17.6 s and two
  lock windows for the DELETE+VACUUM path. Org policy is a **ceiling an admin names** — composed
  with the house ruling that there is no default age, ever (prd-44 #38).
- **RLS** on the read side costs ≤ noise on INSERT — but **RLS forbids `COPY FROM`** (a 3×
  ingest-path difference), so the ingest writer is its own role bypassing RLS on writes while
  every viewer role sits behind per-project policies (cross-project read refused, executed).

## 4 · Local storage: none (S3 — measured, the question is closed for v1)

The warmed parse-cache path prd-44 already ships does the lane-index in **3.9–5.9 ms** — 3–4×
faster than SQLite's query, 15–25× faster than PGlite; PGlite's store ran **4× the source log's
size** (102 MB for 26 MB). The ledger stays the only local truth; the shipper's cursor is a JSON
file; SQLite is the documented fallback *if* a local query surface is ever demanded; PGlite is
rejected locally. (Windows-native behaviour untested — the one open edge.)

## 5 · Words, facts, and what actually crosses (S2 §veil, S1)

- v1 ships **facts only**; the executed wire inventory (2,351,102 string values walked) found
  zero LLM prompt/completion text. What *does* cross, by design, and the veil ruling must name
  it: worktree/repo **paths** (10 event types, 12 fields), the **git author email** (one field,
  `commit.landed.payload.author.email` — the fact-or-word ruling is still the leads'), and
  **commit messages** — human-authored prose, verbatim.
- **Transcripts never ship in v1.** They are a separate storage class entirely — one lane found
  a single 17.25 MB transcript beside a 15.6 MB event log (S1) — and prd-37 ruling 3's
  per-person opt-in with collector-side redaction governs any future words plane.
- Telemetry scale for the budget: **93.2 % of lines / 92.9 % of bytes** in five high-frequency
  classes; gzip ≈ 10×; the durable 7 % is what anyone asks about a month later.

## 6 · The archive lifecycle (S7 — crash-drilled)

Seal (portable record; 1.2–1.65× the log — the chain's price) → gzip (archive lands at
**14–23 % of the raw log**) → **verify** (`verifyRecord ok:true`) → prune via the shipped
`log/retention.ts` plan/apply grammar. The invariant *a deleted log implies a verified archive*
held through 15 kill-9 checks; reclaimed bytes matched prediction byte-for-byte. One discovered
caveat becomes a proposal: a pruned session with no transcript sidecar **vanishes** from the lane
index (the module's own named `silent` case) — the archive step should drop a tombstone sidecar
so *pruned reads as pruned* becomes unconditional.

## 7 · Install and operations (S8 — drilled locally)

`init.sh` (generates secrets, prints the ingest key once) → `docker compose up` → healthz in
**14.2 s**; backup = `pg_dump`; full-destroy → **restore into the empty database before the
app's migration-on-boot runs** (the one ordering rule the drill discovered) → data intact, zero
hand-typed SQL; a live migration applied in 12.7 s. The real-VPS remainder is a named operator
list: DNS + real TLS (Caddy auto), the OAuth callback URL, ingress firewall, off-box backup
destination, unattended upgrades.

## What the spikes overturned (read this before re-arguing the brief)

| assumed | found | spike |
|---|---|---|
| event ids unique per session (`mergeRecords`' key) | **false** — counter restarts on resume; 74.5 % silently dropped under the assumed key | S2 |
| accept-fast → queue → fold is safe as stated | the 202 must follow a durable journal write, or one batch dies with the process | S2 |
| the schema allowlist protects what leaves the machine | it protects the *record*; the wire needs re-serialization — free, digest-proven | S2 |
| a DB-level natural unique key | impossible on a ts-partitioned table; dedup moves to ingest | S4 |
| one table answers the org's questions | four of five; cost-by-day **needs** a rollup projection (7,700×) | S4 |
| RLS is a checkbox | RLS forbids `COPY`; the ingest role must bypass it on writes | S4 |
| "one dialect everywhere" (PGlite locally) | 4× store size, 15–25× slower queries than the shipped parse cache | S3 |
| pruned always reads as pruned | conditional on a transcript sidecar; tombstone proposed | S7 |

## What remains before a build PRD

The leads' rulings the brief already lists (§10 — now narrower: the engine and local-store
questions are answered by measurement; author.email, org-precedence detail, hosting, and the S9
projection remain), the two remaining corpus machines (S1), multi-actor concurrent shippers and
an ack-after-journal re-run of chaos row (c) (S2's named gaps), Windows-native S3, the real-VPS
S8, and the OAuth app operator act (S5). Two defects found in shipped code or paper are filed as
issues on blessing: the `mergeRecords` dedup key, and the record-format doc's id-uniqueness
sentence.
