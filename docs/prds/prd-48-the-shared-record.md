# prd-48 — the shared record: the unknowns are measured before the noticeboard is built

> **Status:** proposed — drafted 2026-08-28 by KelliherL from the leads' design conversation of
> 2026-08-24 and the two research notes that land with this PRD's PR
> (`docs/research/2026-08-24-shared-record-design-brief.md`,
> `docs/research/2026-08-24-shared-record-spike-plan.md`), plus the restored
> `docs/metamorphosis/system-design.md` (2026-08-13; survived the repo deletion only on a local
> branch — prd-37 cites it three times as owning transport, tenancy and keys, and until this PR
> it did not exist on the trunk). **This is a research PRD**: its waves produce committed,
> source-graded notes and verified facts, never production code. The build PRD ("the split") is
> written *from* these notes, and the constitutional paperwork — a successor ADR to 0009's
> "no protocol, no shared database", amendments to 0001/0019 for a hand that has a clock and
> holds a key, the Trust-section rewrite — is written **with** that build PRD, the
> Langfuse-forwarder precedent (`docs/telemetry.md`, "gated on a re-ruling of the Trust
> section"). Consumes prd-37 (parked) as the product half; nothing here unparks it.

## Problem

Every rhizomorph is an island, and the interesting questions are all between islands (prd-37's
problem, verbatim, still true). The leads want a team server on a VPS — each member's telemetry
shipped up, the team view live, storage managed, one-step install, Postgres the leaning — and the
repo has designed this twice (the metamorphosis, prd-37) without ever running a single byte of it.
Between the direction and a buildable PRD sit unknowns nobody has measured: what a person-day of
telemetry actually costs in bytes and classes, whether a shipper survives crash/offline/backfill
losslessly, which local store (if any) earns its place, whether one Postgres schema answers the
org's three questions at ten million rows, whether GitHub-org identity and revocable ingest keys
work with the scopes the cohort can grant, and whether the veil can be *proven* on the wire rather
than argued. Building on any of these unmeasured is the house's named anti-pattern; so is
re-litigating what the metamorphosis already rejected (P2P by name; a replicated database on
every machine, argued against in the brief's §3).

## Evidence

- **The direction exists and was nearly lost.** `docs/metamorphosis/system-design.md` (restored
  by this PR): observatory = log-shipper → one team server; SQLite-first behind a storage
  interface with Postgres the documented growth step; two credential planes; accept-fast → queue
  → fold; one self-migrating container; P2P rejected by name. prd-37 defers transport to it.
- **The measured baseline is in the brief.** 216 MB / 98 slug dirs on one box; largest session
  63,653 events / 26 MB / ~410 B/event; ~93 % of lines in five high-frequency classes, durable
  facts ≈ 4 % (`docs/research/2026-08-24-shared-record-design-brief.md` §2, one machine only —
  which is exactly why S1 exists).
- **The organs are pre-built and idle.** `mergeRecords` (dedup `(actor.instance, event.id)`,
  per-actor append order) has zero production callers; `signature` is reserved `null`
  (ADR-0009); `/connect`'s VERIFIED/BROKEN/UNPROVEN discipline is the sync-status shape.
- **Retention is no longer open — and it constrains the server.** prd-44 #38 landed the house
  answer: *"there is no default age, and that is the ruling"* — the operator names the age at the
  moment of asking, deletion is an explicit act with a dry-run ticket, a pruned lane reads as
  pruned (`log/retention.ts`). A team server's org-level policy must be designed against that
  shape, not against a default the local instrument just refused to have.
- **The privacy asymmetry is live.** OTel `user.email` is stripped by construction; git
  `author.email` rides every `commit.landed` into every export (brief §5) — a shipper sends it on
  day one unless ruled a fact.

## Success

1. Every wave lands as a source-graded note on the trunk (`docs/research/`, [V]/[R]/[I], ran vs
   read) the day it finishes. **Not met while** any spike's outcome lives in a transcript, a
   chat, or a claim without its falsifier's verdict.
2. The shipper round trip is proven lossless. **Not met while** any chaos run (kill mid-batch,
   offline, replay, cold backfill of a 63k-event log) produces a duplicate, a reorder, or a
   server-side re-export whose `verifyRecord` chain does not close to the local export's digest.
3. The storage question is answered with numbers, not taste. **Not met while** "Postgres vs
   SQLite-first vs none (local)" is decided without S1's corpus table and S4's 10M-row timings
   for the org's three questions (where is work · what does it cost · who is stuck).
4. The veil is proven on the wire. **Not met while** "facts always, words never by default" rests
   on reading the code rather than grepping captured wire bytes for planted markers, and while
   the `author.email` question (fact or word?) is undecided.
5. Identity is borrowed end to end in a throwaway. **Not met while** GitHub-org sign-in,
   project-scoped key mint, and revocation-refusal-within-one-batch have not each been witnessed,
   with the minimum scopes named.
6. The build PRD can be written from the notes alone. **Not met while** any §10 question in the
   design brief lacks either a leads' ruling or a spike verdict that answers it.

## Non-goals

- **No production code, no schema in the repo, no network change to the instrument.** Throwaways
  live outside the tree (`~/rhizomorph-spikes/`), named in each note so a reader can rerun them.
- **Not prd-37's surfaces** (colonies, identity colour, org roll-up) — product, parked, its own
  blessing.
- **Not the mesh** (Tailscale/Cloudflare single-machine viewing) — a separate, smaller thread the
  metamorphosis keeps deliberately distinct.
- **Not a retention default.** The house ruled: no default age, ever (prd-44 #38). Org policy is
  a *ceiling the admin names*, never an age nobody chose.

**Rejected alternatives.** *Peer-to-peer sync* — rejected by name in the metamorphosis; not
re-opened. *A replicated database on every machine* — storage O(team) on every disk, retention
becomes N-way, the veil unenforceable after the fact; the "master updates the locals" ask is
served by a bounded projection (S9, gated on a leads' ruling). *Building the split first and
measuring later* — the exact order the four neighbour-regrets in the research note warn against.

## What already exists (do not rebuild)

`mergeRecords` + the portable record format (the wire's dedup and ordering rules, pre-ruled);
ADR-0018 (body-shape routing — the ingest-route precedent); `/connect` + doctor (the sync-status
surface shape); `log/retention.ts` (the policy grammar an org ceiling must compose with);
`scripts/dev/` + `research/spikes/renderer/` (the rig pattern each spike copies).

## Rulings

## Ruling 1 — research precedes the build, and the notes are the deliverable

No split/observatory code is written in this PRD or before its waves close. A spike that overruns
its budget files its partial note and its overrun as findings; silence is not a result.

## Ruling 2 — the spikes inherit the constitution they will later amend

Every throwaway honours the live laws while testing their successors: nothing leaves a real data
directory (S1 reads; S2/S6 ship *copies* or fixtures), no real credential enters a repo or a
note, and the golden-era corpus is untouchable. The point of the spikes is to earn the ADR
amendments with evidence, not to pre-violate them in a sandbox nobody ruled on.

## Ruling 3 — the brief's open questions are the leads', and wave 0 books them

The design brief's §10 (A-vs-B shape, engine, local store, author.email, org precedence, hosting,
the migration seam, numbering of the build PRD) are operator rulings. Booked, not skipped, not
dispatchable.

## Sequencing (waves, each gated as ever)

Territory: `docs/research/` and out-of-tree throwaways only. No wave touches `packages/`,
`scripts/`, or any live fence (prd-41/42/43/46 all have open lanes; this PRD cannot collide with
them by construction).

**Wave 0 — operator acts, booked not skipped. Not dispatchable.** The leads answer the brief's
§10 (or explicitly defer a question to a spike's verdict, recorded on this PRD); the cohort's own
VPS/host and who admins it; whether prd-37 is unparked alongside or waits.

**Wave 1 — the Keystone.** `prd48 w1: the corpus is measured on three machines` (S1 — events/day,
bytes, class census, compression, events per lane-hour; the numbers every later wave and every
retention ceiling derives from). Zero-claimant, read-only, half a day.

**Wave 2 — parallel, fenced apart (separate throwaway dirs, separate notes):**
`prd48 w2: a shipper round trip survives chaos losslessly` (S2) ·
`prd48 w2: the local store earns its place or "none" wins` (S3: none vs SQLite vs PGlite, three
platforms) · `prd48 w2: identity is borrowed and keys revoke` (S5, throwaway GitHub OAuth app +
Caddy TLS).

**Wave 3 — parallel, each consuming wave 1 or 2:**
`prd48 w3: one events table answers the org's three questions at 10M rows` (S4, from S1's shape;
partition-drop retention timed; RLS per project) ·
`prd48 w3: the veil is proven on the wire` (S6, mitmproxy over S2's shipper; the author.email
verdict with evidence).

**Wave 4 — the integration pass:** `prd48 w4: a fresh VPS reaches a working team view, timed`
(S8: compose + init + backup/restore drill + a migration; every keystroke recorded) ·
`prd48 w4: seal-archive-compact-prune runs end to end against a copied data dir` (S7, composing
`log/retention.ts`'s grammar with an archive step; requires the data-dir override, which is
wave 4's one in-repo ask and is filed as its own tiny issue, not smuggled).

**Unfiled work implied, described not numbered:** S9 (the projection down to the local scene) —
gated on a wave-0 ruling that any member needs teammates in their local picture at all; the
Cloudflare-flavoured hosted build the metamorphosis names as a later spike; the build PRD and its
ADRs, which are this programme's *output*, not its tail.

## Open questions

- Every question in the brief's §10 — wave 0's, listed there with the options argued. Open, not
  ruled.
- **Does the cohort's six-week window want wave 4 at all**, or does the programme pause after
  wave 3 with the build PRD written for whoever comes next? A scope call, the leads'. Open, not
  ruled.

## Amendment — the preliminary spikes ran ahead (2026-08-28, landed with this branch)

Seven of the eight spikes were executed the same day this PRD was drafted, on one box, by a
read-only lane fleet; the notes land beside this document
(`docs/research/2026-08-28-shared-record-s*.md`) and the synthesis —
**the proposed system architecture** — at
`docs/research/2026-08-28-shared-record-architecture.md`. The team may accept it, re-cut it, or
refute any line with a better number. Success criteria, assessed against it:

1. **Met for what ran** — every executed spike is a committed, graded note with falsifier
   verdicts. 2. **QUALIFIED** — losslessness held through shipper death, replay and repair with
   an identical chain digest end-to-end, but the accept-fast 202 lost one batch on server death:
   the build requirement is ack-after-durable-journal, and its chaos re-run is a named remaining
   wave. 3. **Met** — by measurement: Postgres server-side with mandatory rollup projections;
   no local database (the shipped parse cache beats every engine tested). 4. **Executed, one
   ruling open** — zero prompt text on the wire; re-serialize-before-shipping is the veil's
   load-bearing clause; whether git author.email is a fact or a word remains the leads'.
   5. **Partial** — membership check and key design proven live; the OAuth app stays the named
   operator act. 6. **Nearer** — the brief's §10 is narrowed: engine and local-store questions
   are answered; author.email, org-precedence detail, hosting, and the S9 projection remain.

**The waves are re-cut to what remains.** Wave 1 → the corpus on the two remaining machines.
Wave 2 → the executed spikes' named gaps: concurrent multi-actor shippers, the ack-after-journal
re-run of chaos row (c), Windows-native local-store behaviour, the pending-invite membership
state. Wave 3 → discharged in preliminary form; its residue (the author.email ruling, the rollup
projection) transfers to the build PRD. Wave 4 → unchanged: the real VPS, and the archive
tombstone that makes pruned-reads-as-pruned unconditional (S7's discovered caveat).

**Unfiled work implied grew two defects, to be filed on blessing:** the shipped `mergeRecords`
dedup key `(actor.instance, event.id)` drops real events because ids repeat across session
resumes (executed, S2); and `docs/record-format.md`'s id-uniqueness sentence describes a
property the real ledger does not have.
