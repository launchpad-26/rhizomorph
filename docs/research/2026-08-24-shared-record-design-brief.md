# The shared record — a design brief for the leads

> **Status:** discussion draft, 2026-08-24, written for the product design meet. Not a PRD and
> not a ruling. Every claim about *this repo* is cited to `origin/main` at `4140f6be` (paths
> relative to `packages/server/src` unless stated); every claim about *outside technology* is
> graded the way `docs/research/` grades them — **[V]** verified against docs or a run, **[R]**
> reported, **[I]** inferred — and anything ungraded below is a hypothesis the spike plan exists
> to test. Companion: [the spike plan](2026-08-24-shared-record-spike-plan.md).

## Amendment — prd-44 shipped, and the retention question is ruled (added 2026-08-28, landing this note)

Between drafting (2026-08-24) and landing, prd-44 shipped in full. Three facts below are
therefore historical, and one section must now be read differently:

- **Retention is ruled, and the ruling's shape binds §6.** prd-44 wave 0 → #38
  (`packages/server/src/log/retention.ts`): *there is no default age, and that is the ruling* —
  the operator names the age at the moment of asking, deletion is an explicit act ticketed by a
  dry-run plan, the live session is never a candidate, and a pruned lane reads as pruned. §6's
  "proposed defaults" table must be read as **org-level ceilings an admin names**, composed with
  that grammar — never as a default age reintroduced by the server after the local instrument
  refused to have one.
- **The parse-cache bound became ADR-0028** (128 MB raw bytes, LRU, single-flighted), and the
  server's event buffer now has a stated ceiling (prd-44 ruling 4) — §2's "retention: none" row
  and the unbounded-buffer row are pre-landing facts, kept for the record.
- §2's volume measurements predate these landings and stand as the drafting-day baseline.

## 0. The ask, restated

Each person's rhizomorph keeps its own telemetry locally; a team server on a VPS aggregates
everyone's; the team view is live; the data is parsable by agents; the whole thing is secure,
manages its own storage, and installs in one step. Data-handling — what is kept, for how long,
what is archived, what auto-deletes — is configurable per person *and* per organisation, from
settings and from the concierge. Postgres is the leaning.

One framing to hold while reading: **there is a ledger and there is a noticeboard.** The ledger
is each person's own append-only, hash-chained event log — evidence, never edited, already built.
The noticeboard is what the team looks at together. The whole design question is *what gets
copied from the ledgers onto the noticeboard, who may read it, and how long it stays pinned.* The
ledger is not the noticeboard, and it should not become one.

## 1. What the repo has already decided (do not re-derive)

This has been designed twice before. Both documents predate the repo's deletion; the
metamorphosis design lands on the trunk alongside this note.

- **`docs/metamorphosis/system-design.md`** (2026-08-13; lost with the repo deletion, restored
  to the trunk by the PR that lands this note — recovered from pre-deletion commit `7541e3d4`).
  Direction, not law.
  It names two products and rejects a third: **the mesh** (a named guest views one machine, nothing
  centralises), **the observatory** (collectors on every member's machine ship the event log to
  *one server the team runs*; the server owns storage; any member sees every fleet), and
  **peer-to-peer sync, rejected by name**. Its stack row: same Fastify server grown a tenancy
  layer · collector becomes a log-shipper (the W&B pattern: local append-only log + batched sync +
  resume marker) · humans by GitHub OIDC + org membership · machines by project-scoped ingest keys
  minted in the viewer · **storage SQLite-first behind a storage interface, Postgres the
  documented growth step** · accept-fast → queue → fold from day one · one self-migrating
  container. Four proto-laws: never fold on the ingest hot path; storage behind an interface;
  server owns storage, clients hold a key and nothing else; the ingest protocol is versioned.
- **`docs/prds/parked/prd-37-the-shared-world.md`** (on `main`, parked pending renewed
  blessing). The product half: "nothing leaves the machine" becomes **"nothing leaves the
  team"** (`:74-76`); identity = git identity + a one-time local declaration (ruling 2); **the
  veil — facts always, words only on explicit per-person opt-in, default off, redaction at the
  collector before send** (ruling 3, `:120-136`); the org roll-up answers three questions —
  where is work happening, what is it costing, who is stuck — and never reads a conversation
  (ruling 5); no leaderboard of teammates (`:76-79`). Its settings groups `you`, `sharing`,
  `telemetry`, `repo` are already declared-and-unavailable in code with those reasons
  (`packages/web/src/settings/registry.ts:227-241`).
- **`docs/research/2026-08-13-from-localhost-to-true-software.md`** (on `main`): the five
  neighbours (Langfuse, LangSmith, W&B, Phoenix, MLflow) converge on one end-shape — instrumented
  client → **authenticated ingest with a project-scoped machine key** → server owns storage →
  browser viewer with **separate human auth**; "two credential planes, never one" [V]. The four
  regrets: auth-off-by-default on an exposed server (MLflow's CVSS-10s), hand-rolled auth added
  late, synchronous ingest on the hot path (Langfuse's 50 s responses), clients touching storage
  directly.

**What the meet is actually deciding, then, is narrower than it looks:** whether to confirm that
direction, and three things it left open — the local store, the database engine, and the
retention/settings model. Section 3 onward is about those.

## 2. What exists today, measured

| fact | value | evidence |
|---|---|---|
| The record of truth | one append-only JSONL log per session, `~/.local/share/rhizomorph/<repo-slug>/session-<ts>.jsonl`, `0600`, fsync on close, resume repairs a torn tail | `log/paths.ts:9-32`, `recorder/session-log-writer.ts:82-159` |
| Integrity | portable record = manifest + SHA-256 hash chain over the lines; `signature` reserved `null`; verification names the first broken link | `docs/record-format.md`, `core/src/record/build.ts:14-27`, `verify.ts:74-146` |
| Multi-actor merge | `mergeRecords` — dedup on `(actor.instance, event.id)`, per-actor append order, cross-actor by `ts` — **already written, zero production callers** | `core/src/record/merge.ts:150`, `record-format.md:243-266` |
| Event schema | 28 types, closed zod payloads, no open maps allowed by law; envelope `{id, ts, source, type, payload}`; ids unique per session only | `core/src/events/index.ts:23-100`, `no-open-payload-law.test.ts` |
| Identity on events | none for a person or machine; `instance` = the boot; git `author.email` rides `commit.landed`; OTel `user.email` is stripped by construction | `events/git.ts:60`, `collectors/otel/parse-traces.ts:87`, `record/schema.ts:25-29` |
| Words vs facts | the event log is facts-only (pane text is a hash, prompts are digests); the **transcript capture sidecar is words**, redacted not omitted | `events/tmux.ts:24-29`, `log/transcript-capture.ts:7-105` |
| Volume on this machine | 216 MB, 98 slug dirs (≈80 are `pack-smoke.sh` litter — the data dir has **no env override**, `paths.ts:10`); this repo's own dir 111 MB; largest session 63,653 events / 26 MB / ~410 B per event | measured 2026-08-24, WSL |
| Event census (largest log) | `pane.activity` 48 % · `llm.usage` 19 % · `trace.span` 14 % · `tool.activity` 8 % · `agent.activeTime` 4 % · `llm.cost` 3 % · everything durable (`commit.landed`, `agent.status`, `worktree.*`, `branch.*`, `session.*`, `judge.*`) **≈ 4 %** | measured 2026-08-24; matches `core/src/reduce.bench.test.ts:39-42` |
| Cost of reading a log | parse 55k lines ≈ 340 ms; fold 742 ms; per-event write 61 µs (prd-44 w2 fixes) | `reduce.bench.test.ts:172-178`, `docs/prds/prd-44:35-38` |
| Retention | **none.** Log unbounded within a session; nothing prunes the directory; no delete route, no delete control; `MAX_EVENTS = 75 000` in the browser only | `docs/operational-targets.md:10-23`, `web/src/recordings/RecordingsPage.tsx:64`, `streamState.ts:60` |
| Settings | 18 prefs in browser `localStorage`, scopes `machine`/`repo`/`session`, no server file, no per-person scope; five non-negotiables enforced by a text law | `web/src/settings/registry.ts:49-59,652-655`, `non-negotiables.ts:66-97` |
| Network | binds `127.0.0.1` hard-coded, no `--host`; a global `Host`-is-loopback hook on every request; CSP `connect-src 'self'`; no outbound socket anywhere in the tree | `cli/run.ts:183`, `server/mutation-guard.ts:191-195`, `server/static.ts:44-55` |
| Constitution | ADR-0009 rejected "a federation protocol … or a shared database both instances read" **by name**; `record-format.md` law 2: "nothing auto-transmits … no background sync"; ADR-0019 clause 3: "the hand has no clock" | `docs/adr/0009:21-38`, `record-format.md:302-305`, `adr/0019:83-85` |
| The migration seam | `upcast()` was **deleted** (`67c6beec`, #247) — there is no versioning seam between parse and reduce today; docs still say it exists | `docs/adr/README.md:200` (stale) |

Two things in that table are load-bearing for everything below. **The local ledger is already the
best-designed part of the system** — append-only, fsync'd, chained, verifiable, mergeable. And
**93 % of the bytes are high-frequency operational telemetry** that loses most of its value within
hours, while the 4 % that is durable fact is what anyone asks about a week later.

## 3. The decision everything hangs on: what moves, and in which direction

Three shapes. The user's phrasing ("a master database that updates the local databases") is shape
B; the repo's prior direction is shape A.

### A — ship the ledger up; read the noticeboard from the server *(recommended)*

Each instrument keeps its JSONL ledger exactly as now. A **shipper** — a new, explicitly-enabled
hand — tails the ledger and POSTs batches to the team server with a resume cursor. The server
accepts fast, queues, folds into Postgres, and **serves the team view itself**. A member opens
`https://obs.<team>` to see everyone; their local instrument keeps showing their own fleet, offline
or not. Optionally (v2, spike S9) the server pushes a small **team projection** back down — who is
on which lane, cross-person collisions, spend by person — so the local scene can show teammates as
neighbouring colonies without holding their history.

- Storage is O(team) on the server, O(self) on each machine.
- The veil is enforceable: redaction runs at the collector before send; a word that never left
  cannot leak (prd-37 ruling 3).
- Offline is structural: the ledger is local; the shipper resumes from its cursor.
- Retention is one policy in one place (the server), plus each person's own local policy.
- The local instrument **opens no inbound port** — it becomes an outbound HTTPS client only. ADR-0008's
  loopback bind, `Host` hook and CSP stay intact on the local side; only the constitution's
  "nothing leaves" sentence changes, to prd-37's "nothing leaves the team".
- Everything is already half-built: the ledger, the chain, `mergeRecords`, `/connect`'s
  VERIFIED/BROKEN/UNPROVEN discipline for the sync-status row, the OTLP receiver as the pattern
  for a versioned ingest route (ADR-0018), the reducer as the server's fold.

### B — a replicated database on every machine

Each person runs a local database that is a replica of the team's; the VPS is the hub; changes
flow both ways (Postgres logical replication, or a local-first sync engine — ElectricSQL,
PowerSync, cr-sqlite, Zero [R, none verified]). Every member holds everyone's data.

- Storage is O(team) on **every** machine, and retention becomes an N-way problem — a deletion on
  the server has to reach every replica, and a replica that was offline resurrects it.
- The veil cannot be enforced after the fact: once words are replicated they are on N disks.
- Sync engines solve **write conflicts**; this data has none — each ledger has exactly one writer
  and is append-only. The hard part of those tools buys nothing here.
- It puts a second source of truth beside the ledger and invites the lie ADR-0005 exists to
  prevent (a store agents can edit).
- Its one real advantage — a team view while offline — is marginal for a *live* instrument, and
  S9's projection gets most of it at a thousandth of the size.

### C — peer-to-peer

Rejected by name in the metamorphosis design and prd-37 (`:87`). Named here so nobody re-proposes
it by accident; the reasoning (viewing is human-to-machine and every studied system that shipped it
used borrowed identity, not device pairing) stands.

**Recommendation: A**, with the "master updates the locals" clause satisfied by a *projection*,
not replication. The question to put to the room is not "Postgres or not" — it is "does any
member need a teammate's *history* on their own disk?" If the answer is no (it was no in every
neighbour studied), B is off the table and the rest of this brief follows.

## 4. Where the databases sit, and which ones

### 4a. Locally: the ledger stays; a database may *index* it, never replace it

Keep the JSONL ledger as the record of truth. It is what makes a session portable, verifiable and
mergeable, and its laws (append-only, outside the watched repo, fsync, never enriched) are the
trust story. A local database earns its place only as a **derived, rebuildable index** — the lane
index, the recordings library, the shipper's outbox and cursor — i.e. the things prd-44 is about
to cache in memory anyway. Three candidates for that index, to be decided by spike S3:

| option | for | against |
|---|---|---|
| **SQLite** (`node:sqlite` or `better-sqlite3`) | boring, one file, zero daemon, Windows-native, the Phoenix precedent | a second SQL dialect beside the server's Postgres |
| **PGlite** (Postgres compiled to WASM, in-process) [R] | one dialect and one migration set locally *and* on the server — attractive for a team with limited database depth | WASM footprint, maturity, Windows behaviour and startup cost unmeasured |
| **no database** — keep JSONL + prd-44's parse cache + a small JSON cursor file | nothing new to learn or ship; prd-44 already fixes the measured pain | no query surface locally for agents; the recordings library stays a directory walk |

The honest default is the third until a spike shows the first or second is needed; a local
database is not what makes multiplayer work.

### 4b. On the server: Postgres, directly

The metamorphosis note **ruled SQLite-first**, Postgres as the documented growth step at rung 2
(20–100 people), on the Phoenix precedent (`7541e3d4:92,110-118`). Going to Postgres on day one
is therefore a deviation from a recorded direction and should be argued, not assumed. The argument
for it: the team has said Postgres, the target is a VPS from day one rather than a member's
laptop, and the cohort would rather learn one engine than two. It is defensible **if the one
discipline that made SQLite-first safe is kept — storage behind an interface, no SQL in route
handlers** — so the choice stays a re-deployment, not a rewrite, in either direction. What Postgres buys that matters here: many concurrent writers and
readers; JSONB with indexes for closed-schema payloads; **time partitioning, so retention is
`DROP PARTITION` rather than a million-row `DELETE`** [V, standard Postgres]; row-level security
for org → project tenancy; logical replication and `pg_dump` for backups; a mature managed tier
if hosting ever moves. What it costs: the one-container simplicity Langfuse names as v3's price.
Mitigation is the install story in §8.

### 4c. The schema shape, in one paragraph

An **`events` table that is the ledger, not a model of it**: one row per line — `project_id`,
`actor_instance`, `event_id`, `ts`, `type`, `source`, `lane`, `worktree`, `payload jsonb`,
`prev_hash`, `hash` — unique on `(project_id, actor_instance, event_id)` (the `mergeRecords`
dedup key, already ruled), partitioned by month on `ts`. The chain columns let the server
**re-verify any actor's stream** and re-export a portable record byte-for-byte, so the noticeboard
never becomes evidence the ledger did not produce (ADR-0005's "never edited in place" survives the
round trip). Cross-actor order on the noticeboard is `mergeRecords`' rule for now (per-actor
append order, cross-actor by `ts`, instance as tiebreak); the ruled anchor for the forest is the
**commit DAG** via `commit.landed.parents` (`docs/architecture.md:1956-1958`), which no code reads
yet — spike S4 should say whether the DAG anchor is needed in v1 or only when clocks visibly
disagree. Beside it, **projections** the fold maintains in a worker — `lane_state`,
`spend_by_lane_hour`, `collisions`, `attention` — rebuildable from `events`, which is what "agent
-parsable" should mean: a read-only SQL role over stable views that answer prd-37 ruling 5's
three questions without ever joining to words. Words (transcripts, opt-in) go in a separate table
or object store with its own, shorter retention and its own access rule.

## 5. Security posture

- **Two credential planes, never fused.** Humans: GitHub OIDC + "must be a member of
  `github.com/<org>`" — no invite lists, leaving the org revokes access. Machines: project-scoped
  ingest keys minted in the viewer by an admin, revocable, held by the shipper and nothing else.
  No hand-rolled accounts, ever (the Prometheus lesson) [V].
- **Ingest is authenticated always.** There is no "auth off for local" on the server — that is
  the MLflow/Ollama regret [V]. The local instrument's own OTLP inbox stays loopback and
  instance-checked as today (`api/otel.ts:241`).
- **TLS at the door, not in the app.** Caddy (auto-TLS) or a Tailscale/Cloudflare front, so the
  Node server never holds a certificate [R]. Host/Origin checks are parameterised for the team
  hostname, never removed.
- **The local machine opens nothing.** Outbound only. This is the single biggest security
  property of shape A and the reason ADR-0008 survives mostly intact.
- **The veil is a collector-side law, testable on the wire** (spike S6): facts always; words only
  on per-person opt-in, default off; redaction before send. The one decision the veil needs from
  the leads: **is git `author.email` a fact or a word?** It is already visible to every teammate
  in `git log`, so within a project it is arguably a fact; the org roll-up must still never rank
  people on it (prd-37 ruling 5).
- **At rest:** disk-level encryption on the VPS volume and encrypted backups; app-level encryption
  is not worth rolling. Secrets in env/secret files, never in the database.
- **Where the ingest key lives on a member's machine** — prd-38 ruling 4 already wrote the list of
  places a credential may never be: "never the server process['s logs], never the SPA, never a
  plain-JSON prefs file, never argv, never a child's env, never the hash-chained record, never a
  log line" (`docs/prds/parked/prd-38:108-115`). The shipper holds it in a `0600` file under the
  data root (or Electron `safeStorage` when the shell is present), and `doctor` reports its
  presence, never its value.
- **Tenancy:** organisation → project (a watched repo) → keys. Access follows membership, never
  repo-knowledge; a stranger with the URL has nothing. Postgres RLS as belt-and-braces over the
  app's own check (spike S4).
- **Constitutional paperwork this needs, by name:** a successor ADR to **0009** ("no protocol"
  → a versioned ingest protocol, with the reasons that changed since 2026-08-06); an amendment to
  **0001/0019** naming the shipper as a hand that *does* have a clock and *does* hold a secret,
  and why that is bounded (outbound only, one key, project-scoped, revocable); an amendment to
  **0008/0027** only if the local page ever talks to the team origin directly (it need not — the
  team view is the server's page). The Trust section of the README is rewritten to say exactly
  what leaves and when — the Langfuse-forwarder precedent (`docs/telemetry.md:459-466`).

## 6. Storage management, retention and archiving — proposed defaults

prd-44 wave 0 already books "how long recordings are kept, and by what act they go" as an
**operator act, not dispatchable to an agent** (`prd-44:244-247`), and rejects auto-deletion as
a default the PRD picks (`:110`); prd-16 deferred deletion outright — "a destructive action
deserves its own ruling" (`prd-16:135-136`) — and that ruling still does not exist. So the numbers below are *proposals for the leads to rule*,
and the mechanism is designed so that the default on a fresh install is the conservative one.

### 6a. Tier by fact-class, not by age alone

The census says one policy for all events is wrong: 93 % of lines are minute-to-minute telemetry;
4 % are the facts anyone wants a month later.

| tier | what | proposed default (local) | proposed default (server) |
|---|---|---|---|
| **live** | the open session | unbounded within a session (law today); in-memory buffer bounded by prd-44 ruling 4 | queue + fold, never bounded by age |
| **full fidelity** | every event of closed sessions, raw | keep 90 days | keep 30 days |
| **compacted** | high-frequency classes (`pane.activity`, `llm.usage`, `trace.span`, `tool.activity`, `agent.activeTime`) folded into per-lane per-hour rollups; durable facts kept raw | after 90 days, keep rollups + facts indefinitely | after 30 days, keep rollups + facts 1 year |
| **archived** | the sealed portable record, compressed (JSONL should compress ~8–12× [I — spike S1 measures]) | opt-in: archive dir under the data root, or none | to object storage (S3/R2/local volume) before any partition drop |
| **words** | transcript captures / opted-in conversation text | keep 30 days, then delete | keep 7 days, then delete; never archived off the machine that produced them unless the person opts in |
| **deleted** | | never automatically, **unless the person turns it on**; a disk budget warns first | by the org's ceiling; `DROP PARTITION` after the archive write is verified |

Two invariants regardless of numbers: **seal before prune** — a record's manifest and chain
digest are written (and archived if archiving is on) before its lines go, so "this existed and
this is its digest" outlives the bytes; and **a pruned lane reads as pruned, never as
never-existed** — prd-44 ruling 1's amendment, the same shape ADR-0011 abolished for the silent
skip.

### 6b. The options the settings must offer

- Retention for raw events: `never delete` · `30 d` · `90 d` · `1 y` · custom.
- Retention for words: `never keep` · `7 d` · `30 d` · custom — separately, always shorter or
  equal.
- Compaction: on/off, and the age it starts.
- Archive: off · to a local folder · to the team server (facts only unless words are shared).
- A disk budget per repo (local) and a storage quota per project (server), with a warning voice
  before enforcement — the honest-gap law means the warning cannot be hidden (`non-negotiables.ts`).
- A data-dir override (`RHIZOMORPH_DATA_DIR` / XDG) — missing today and the cause of 80 litter
  directories on one machine; this is a prerequisite, not an option.
- One irreversible act with one confirmation: **delete now** — a POST route in the
  `gated-mutation` class and a sixth entry in the web's mutating-calls law, argued in its own
  diff.

### 6c. What "archiving" means here

Not a second format. The portable record (`docs/record-format.md`) *is* the archive format —
verifiable by a stranger with `sha256sum`. Archiving is: build the record, compress it, write it
to the archive location, verify it reads back, then and only then compact or drop the source.
Restoring is `rhizomorph replay <record>` (already shipped).

## 7. Settings: person and organisation

prd-35 gives three scopes (`machine`, `repo`, `session`) in the browser and a law that any
control weakening the instrument's honesty fails the build. Multiplayer adds two layers above,
both server-held:

```
organisation policy   (admin, in the team viewer; stored in Postgres)
  └─ project policy   (per watched repo; admin or project owner)
       └─ person      (local settings; never leaves the machine)
            └─ repo / machine / session  (prd-35, as today)
```

**Precedence goes the safe way, and it is asymmetric on purpose:**

- The organisation sets a **ceiling** on what the server keeps (e.g. "words never longer than
  7 days", "raw events never longer than 90 days", "project quota 5 GB") and may set a **floor**
  for audit ("facts kept at least 1 year"). The person cannot exceed the ceiling on the server.
- The person's **veil is theirs**. An organisation may forbid words leaving (more private); it
  may never force them (less private). Default off stays off until the person turns it on.
- Local retention is the person's alone; the organisation has no reach into a member's disk.
- Every effective value shows **who set it and where** — prd-35's override-visibility principle
  extended one layer; a value inherited from the org says so in words on the settings page.
- Org policy reaches the local instrument with the team projection (a signed policy document is a
  later refinement); local prefs never travel.

Where the controls live is already ruled: **a control that changes something lives in settings and
appears exactly once; `/connect` renders no control; first-run drives settings and reimplements
nothing** (prd-35 ruling 1, prd-34 ruling 7). So `Data handling` is a settings group (beside the
existing, currently-disabled `sharing` group in `web/src/settings/registry.ts:227-241`) — *what
stays here · what leaves · how long each is kept · your disk budget* — and the concierge wizard
(`web/src/connect/wizard.tsx`) gains one step that *drives* it at connect time, with the org's
ceilings displayed as facts beside the person's choices. Every option must clear the
non-negotiables law: a retention control may shorten what is kept, but it may never hide the
voice that says something was pruned.

## 8. One-click install on a VPS

The instrument runs on the host it observes and must never be containerised
(`docs/research/2026-08-07-docker-and-distribution.md`, proposed ruling A). **The team server has
no host to observe, and is the one thing that should be a container.**

- **Shape:** one image (the same Node/Fastify server, grown the tenancy layer and the fold
  worker) + Postgres + Caddy, as a `docker compose` file with a generated `.env`; migrations run on
  boot (self-migrating, the W&B pattern [V]). An `init` step creates the admin, registers the
  GitHub OAuth app values, and prints the first project's ingest key.
- **One-binary alternative to spike (S8b):** the server image with an embedded Postgres, so a
  $5 VPS runs one process — reduces the moving parts the cohort has to understand; costs
  operational familiarity when something goes wrong.
- **Backups:** nightly `pg_dump` to object storage, restore drilled in the spike, never trusted
  untested.
- **A `doctor` for the server**, same discipline as the local one: one line per check, each with
  its exact remedy; and the local `/connect` page gains one row — `team server` — VERIFIED only
  when a batch was acknowledged, never when preconditions merely passed (prd-19 ruling 3).
- **Where it runs:** a member's spare box, the team's own infra, or a VPS — all three by design;
  a managed cloud we run is a separate product decision (metamorphosis, "who hosts").

## 9. What this brief is not deciding

- The product surface of the team view (colonies, identity colour, the org roll-up) — prd-37's,
  which the meet should consider **unparking** since this data layer exists to serve it.
- The renderer, the scene, the local UI — untouched.
- Whether to also build the *mesh* (view one machine remotely via Tailscale/Cloudflare
  identity) — a separate, smaller PRD; nothing here forecloses it.
- Any hosted/managed offering.

## 10. Questions only the leads can answer (Open, not ruled)

1. Does any member need a teammate's **history** on their own disk? (Decides A vs B outright.)
2. Retention numbers — the proposed defaults in §6a are proposals; prd-44 wave 0 owes this ruling
   anyway and this is the same decision.
3. Local index: none / SQLite / PGlite — after spike S3, or ruled now on taste.
4. Postgres directly, or SQLite-first as the metamorphosis note said — with the storage interface
   either way.
5. Is git `author.email` a fact or a word?
6. Org precedence: ceiling-and-floor as in §7, or something simpler?
7. Hosting posture for the cohort's own team server during the project — whose VPS, who is admin,
   who holds the ingest keys.
8. Does the **migration seam** come back? `upcast()` was deleted because no era-2 arrived; two
   machines on different builds is the era-2 that will.
9. Numbering: this becomes **prd-46** (next free on the trunk) — or two PRDs, the split (data
   layer, this brief) and the shared world (prd-37, unparked).
10. prd-37's own open questions that this layer must answer for it: how the org level is
    configured (one server per team, or a server that federates others — `prd-37:277-278`), and
    whether **spend roll-ups need per-person consent** separate from the words veil (`:283-285`).
11. The container ADR the 2026-08-07 note asked for was never written; the team server needs the
    matching ruling ("the watcher is never containerised; the server always is") recorded once.
