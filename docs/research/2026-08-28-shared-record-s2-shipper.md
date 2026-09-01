# s2-shipper — tail-and-batch shipper → Postgres ingest, through chaos, and what crosses the wire

Lane `s2-shipper`, rhizomorph prd-48 (PR #141). 2026-08-28. Build area
`~/rhizomorph-spikes/shipper/` (throwaway). Repo `~/rhizomorph` and
`~/.local/share/rhizomorph` were read-only throughout; the ledger was **copied out**.

Box: WSL2 Ubuntu, i9-13900H, 31 GiB, node 22.23.2, docker 29.7.1, postgres:16-alpine.
**Shared box — every absolute time below carries its loadavg.** `nproc` reports 6
in this cgroup, not 20.

**Headline:** the shipper moves a real 63,653-line ledger losslessly and the
portable record rebuilt from Postgres rows is *byte-identical* to one built from
the file (same `chainDigest`, `verifyRecord ok:true`). Two things do **not** hold:
the ingest schema as briefed silently discards **74.5%** of the ledger, and the
accept-fast 202 is a **lie about durability** — it cost exactly one batch (500
lines) when the server died.

---

## What ran

Three throwaways, ~230 lines total:

| file | what it is |
|---|---|
| `server.mjs` | plain `node:http` + `pg`. `POST /v1/rhizomorph/ingest`, static `x-rz-ingest-key`, envelope-shape validation only (accept-fast) → in-process queue → drain loop `INSERT … ON CONFLICT DO NOTHING`, parsing `id/ts/type/lane` per line. `GET /stats`. |
| `proxy.mjs` | 18-line passthrough on 5452 → 5451, appending every raw request body to `wire.log`. The veil's capture point. |
| `shipper.mjs` | byte-offset cursor file, batches 500 lines / 250 ms, POSTs through the proxy, advances the cursor **only on 2xx**, exponential backoff 50→4000 ms capped. |

Data: `session-1785739192605.jsonl`, the largest real session log (63,653 lines,
26 MB), copied to `ledger.jsonl`. Never the original.

Ports: pg on `127.0.0.1:5433` (`rz-spike-shipper-pg`), server 5451, proxy 5452.
**5434 and 5436 were already held by another lane** — my first boot died
`EADDRINUSE` and the shipper retried the dead server for 6 min before I noticed.
That is a real cost of the shared box, and the shipper behaved correctly.

### The schema defect, found before the first row was written

The brief specifies `PRIMARY KEY (project, actor_instance, event_id)`. In the
real ledger the event id is **not unique** — the `evt-NNNNNN` counter restarts
per collector cycle: [EXECUTED]

```
$ jq -r .id session-1785739192605.jsonl | sort -u | wc -l
16218                      # against 63653 lines
$ jq -rc '[.id,.ts,.type]' … | sort -u | wc -l
63653                      # (id, ts, type) IS unique
$ jq -r .id … | sort | uniq -c | sort -rn | head -2
     15 evt-000001
     14 evt-000019
```

So I built **both** tables from the same drain loop and the same batch:
`events` exactly as briefed, and `events_n` keyed `(project, actor_instance, n)`
— `n` being deterministic from file position, therefore lossless *and* idempotent
under replay. All chaos counts below report both. This is the one place I
departed from the brief, and the departure is the finding.

---

## Results

### Chaos matrix — all rows [EXECUTED]

`n` = 1-based line number in the source log. `events_n` is the lossless table;
`events` is the briefed schema.

| row | what happened | `events_n` | `events` (briefed PK) | dup `n` | order inversions |
|---|---|---|---|---|---|
| (a) cold backfill | 63,653 lines, 128 batches, 0 retries, **9.82 s** | 63,653 | **16,218** | 0 | 0 |
| (b) `kill -9` ×20 | 20/20 kills delivered mid-flight, restart each time | **63,653** | 16,218 | 0 | **0** |
| (c) server down 30 s | 13 backoff retries, stalled at n=10500, resumed | **63,153** ⚠ | 16,218 | 0 | 0 |
| (d) rewind 5k, re-ship | 5,000 lines re-shipped, 10 batches | 63,153 (**Δ0**) | Δ0 | **0** | 0 |
| (e) garbage cursor | 64 random bytes → detected → cold start from 0 | **63,653** | 16,418 | 0 | **1** (explained) |

File line count: **63,653**. Backfill throughput **6,481 lines/s** at
loadavg 3.24 → 4.02.

**(a) The briefed schema loses 47,435 of 63,653 lines — 74.5%.** [EXECUTED]
`{"accepted":63653,"inserted":16218,"insertedN":63653,"batches":128}`.
`ON CONFLICT DO NOTHING` on a non-unique id is not dedup, it is silent deletion,
and the server reports success while doing it.

**(b) Lossless under shipper death.** 20 `kill -9`s, `events_n` = 63,653 =
file lines, `distinct_n` = 63,653, `n` ∈ [1, 63653], zero inversions. The cursor
was parseable after **every** kill — write-to-`.tmp`-then-`rename` makes a torn
cursor unreachable. My loop asserted this after each kill and never fired.
(Honest note: the kills alone finished the file, so the follow-up catch-up run
had nothing to do and was killed by my own `timeout` — the counts are the claim,
not that run.)

**(c) The accept-fast 202 is not durable — 500 lines lost.** ⚠ The cursor reached
63,653 but the table held 63,153. The gap is exact and diagnosable: [EXECUTED]

```
missing_count=500
gap_min=10001 gap_max=10500 contiguous=true
```

Exactly one batch of 500, ending precisely at the cursor position when I killed
the server (`{"offset":4111384,"n":10500}`). The mechanism: the server returns
202 when the batch enters the **in-process queue**, before the INSERT. The
shipper honoured its contract perfectly — advance only on 2xx — and still lost
data, because the 2xx was a claim the server had not earned. **A durable
shipper cannot be built against a non-durable ack, no matter how careful the
cursor is.** Retry/backoff itself worked: 50→100→200→…→4000 ms, capped, 13
attempts, stalled at n=10500 for the full outage, resumed unaided.

**(d) Replay is idempotent.** Rewound 5,000 lines, re-shipped 5,000 (`accepted`
53,153→58,153), rows `63153 → 63153`, **delta 0**, `dup_n=0`, inversions 0.

**(e) Garbage cursor cold-starts, and self-repairs.** [EXECUTED]
`cursor unreadable (Unexpected token 'h' …) -> cold start from 0`, then
63,653 lines re-shipped, of which **500 were new** — the (c) gap, repaired.
`missing=0`.

#### The one order inversion is arrival order, not corruption

Row (e) produced `inversions=1`, located exactly at [EXECUTED]
`inversion at n=10001 after prev=63653` — the repair boundary. The ingestion
serial records *when a row arrived*, so a gap backfilled later necessarily sorts
after rows with higher `n`. **"`n` strictly increasing by serial" is the wrong
invariant for any system that supports replay or repair**; it held for every
single-pass ship (rows a–d) and was violated by a legitimate fix. The invariant
that survived all five rows is *no gaps and no duplicates in `n`*.

### The crown — the portable record rebuilt from Postgres [EXECUTED]

`npx tsx` importing the repo's own `record/build.ts`, `jsonl.ts`, `record/verify.ts`
unmodified. Record A from `ledger.jsonl`; record B from
`SELECT line FROM events_n WHERE … ORDER BY n`; same manifest inputs.

```json
{ "file_lines": 63653, "server_rows": 63653,
  "local_events": 63653,  "local_parse_errors": 0,
  "server_events": 63653, "server_parse_errors": 0,
  "local_chainDigest":  "37ca19ab6f2162a2bdc3d0f9039fff3a2328dc703d070d6bc224a168316f223d",
  "server_chainDigest": "37ca19ab6f2162a2bdc3d0f9039fff3a2328dc703d070d6bc224a168316f223d",
  "DIGEST_EQUAL": true, "bodies_byte_equal": true, "manifest_equal": true,
  "verify_server_ok": true, "verify_unknown": 0,
  "eventCount": 63653, "startTs": 1785739192632, "endTs": 1785895662366 }
```

Identical chain digest, byte-equal bodies, equal manifests, `verifyRecord` →
`ok:true`, zero unknown lines, zero parse errors on either side. 5.19 s at
loadavg 2.53. **A ledger that went through the wire, five kinds of chaos, a
duplicate replay and a gap repair reconstructs to the same hash as the file.**

### Live latency — append → row-visible [EXECUTED]

200 synthetic `agent.status` lines appended to the tailed file at ~5/s while
everything ran; each measured by polling `WHERE n=?` until visible.

| median | p90 | p99 | worst | best |
|---|---|---|---|---|
| **53 ms** | 103.8 ms | 868.1 ms | **991.7 ms** | 21.9 ms |

All 200 landed (`synthetic_landed=200`). Loadavg 1.99–2.46. The p99 tail is the
250 ms batch timer beating against the 200 ms append interval plus the drain
loop's 20 ms idle sleep — not queueing pressure.

---

## THE VEIL (S6) — what actually crossed the wire

`wire.log` = 123 MB, 536 raw request bodies, **63,772 unique event lines** after
dedup (63,653 ledger + 200 synthetic, and replays collapsed). Every check below
walks every string value of every parsed event — 2,351,102 string values.

| # | probe | expected | **found** |
|---|---|---|---|
| (i) | prompt-like text (>120 chars, ≥8 spaces, NL-shaped) | ABSENT | **8 fields, all `commit.landed.payload.message`** — no LLM prompt/completion text |
| (ii) | email addresses | PRESENT | **668 × `[the operator's git author email, redacted]`**, one field: `commit.landed.payload.author.email` |
| (iii) | `/home/` and `C:\` paths | PRESENT | **10 event types**, 12 distinct fields — inventory below |
| (iv) | pane text | ABSENT (hashes only) | **PRESENT — `pane.activity.payload.preview`, 30,627 events.** ⚠ |

**(i) No prompt text crosses — but the detector's only hits are human prose.**
Zero prompts or completions. The 32 raw hits (8 distinct) are all git commit
messages, e.g. `"fix(conduct): lane env resolves the MAIN checkout's built CLI —
every lane since the trace beta launched uninstrumented (worktrees have no
dist)"`. Full commit subject **and body** cross verbatim. That is human-authored
natural language on the wire; it is not model I/O, and the veil ruling should say
which of the two it actually cares about.

**(ii)** Exactly one email field, and it is the git author identity — the
expected leak, precisely bounded.

**(iii) Filesystem paths, by event type:**

| event type | fields carrying a real path |
|---|---|
| `session.started` | `payload.repoPath` |
| `worktree.discovered` / `.removed` | `payload.path` |
| `worktree.dirty` | `payload.path`, `payload.files[].path` |
| `branch.updated` | `payload.worktreePath` |
| `commit.landed` | `payload.worktreePath`, `payload.files[].path` |
| `llm.usage` | `payload.worktreePath` |
| `tool.activity` | `payload.filePath`, `payload.worktreePath` |
| `pane.discovered` | `payload.currentPath`, `payload.worktreePath` |
| `agent.status`, `agent.activeTime`, `llm.cost`, `trace.span` | `payload.worktreePath` (null in this session) |
| `pane.activity` | **`payload.preview`** ⚠ |

**(iv) The finding that matters: the record's allowlist protects the record, not
the wire.**

`AGENTS.md` names `pane.activity.preview` as a field *removed* from the payload
(#292), and `build.ts` documents that re-serialization makes the event schema an
allowlist so a dropped field "cannot ride an old log line into a new record."
That holds — and it is exactly why the wire is unprotected. [EXECUTED], 50 lines
sampled:

```json
{ "sampled_lines": 50, "wire_lines_with_preview": 50,
  "record_lines_with_preview": 0, "record_strips_preview": true,
  "record_line_sample": "{\"id\":\"evt-000007\",…,\"payload\":{\"paneId\":\"%0\",\"contentHash\":\"4b08c4b0…\",\"previousHash\":null,\"lines\":25}}" }
```

50/50 wire lines carry `preview`; **0/50 record lines do.** The shipper ships
**raw log bytes**, so it bypasses the allowlist entirely. And the preview is real
terminal content, including a real hostname and OS username — the thing
`AGENTS.md` forbids committing: [EXECUTED]

```
"preview":"[user]@[host]:~/worktrees-challenge$
"preview":"⏵⏵ bypass permissions on           ·
"preview":"rhizomorph running at http://127.0.0.1:4321
```

**Ruling this evidence supports: the shipper must ship re-serialized event lines,
not raw log lines.** Doing so costs nothing measured here — the crown proves
re-serialized lines reproduce the same `chainDigest` — and it moves the veil from
"whatever the oldest line on disk happens to contain" to "whatever the current
schema allows." As built, any field ever removed from the schema still crosses
the wire for as long as old logs exist.

---

## Falsifier verdicts

| falsifier | verdict | deciding number |
|---|---|---|
| Any duplicate or reorder after dedup? | **PASS** (dup) / **QUALIFIED** (order) | `dup_n=0` across all five rows; `distinct_n = count(*) = 63,853` final. Inversions 0 for rows a–d; **1** after the (e) repair, at `n=10001 after prev=63653` — arrival order by design, not reordered data. |
| Chain digest mismatch? | **PASS** | `37ca19ab…223d` on both sides, `bodies_byte_equal: true`, `verifyRecord ok:true`. |
| Backfill > 5 min? | **PASS** | **9.82 s** for 63,653 lines (6,481 lines/s) — 30× under budget. |
| Live latency > 2 s? | **PASS** | median **53 ms**, worst **991.7 ms** — worst case 2.0× under. |
| Any prompt-like text on the wire? | **PASS** | 0 prompts / completions in 2,351,102 string values. The 8 NL hits are git commit messages. |
| *(added)* Is the ingest lossless through chaos? | **FAIL** | Two independent losses: briefed PK drops **47,435/63,653 (74.5%)**; accept-fast 202 dropped **500** lines on server death. |
| *(added)* Does the wire respect the record's field allowlist? | **FAIL** | `pane.activity.preview` on **30,627** wire events, **0** record lines. |

---

## What this did not test

- **Single machine, loopback only.** No real network: no partitions, packet loss,
  reordering, MTU, TLS, or proxy buffering. Latency and throughput here are a
  floor, not a forecast.
- **Shared box.** Another lane held 5434/5436 and loadavg ran 2–7 throughout.
  Timings are honest but noisy; I did not attempt an isolated run.
- **One log, one actor, one project.** No concurrent shippers, no multi-actor
  interleaving, no contention on the same `(project, actor_instance)` key — so
  cross-actor ordering is untested, and the accept-fast loss window was measured
  at one queue depth only.
- **Server durability was never fixed, only measured.** I did not implement
  ack-after-INSERT (or a WAL) and re-run row (c), so the claim "the loss
  disappears if the 202 follows the insert" is [REASONED], not executed.
- **Never tested log rotation or truncation.** The shipper has a shrink-detect
  branch that rewinds to 0; it was never exercised, and rewinding to 0 on
  rotation is probably the wrong behaviour.
- **`kill -9` only.** No SIGTERM/graceful-drain path, no disk-full, no
  `fsync` failure, no Postgres restart mid-drain, no OOM.
- **The 500-line loss was not swept.** I found one instance at one timing; I did
  not characterise the loss distribution over many server kills.
- **`(id, ts, type)` uniqueness is a property of *this* log**, 63,653 lines.
  It is not proven to hold globally, and a same-millisecond duplicate of the same
  type would break it.
- **Veil probes are heuristics.** (i) is a length/space/letter-pattern regex —
  it would miss short prompt fragments or a base64-encoded prompt entirely.
  Absence of a hit is not proof of absence.

## Reproduction

Throwaway: `~/rhizomorph-spikes/shipper/` (this note's evidence came from there).

```bash
docker run -d --name rz-spike-shipper-pg -p 127.0.0.1:5433:5432 \
  -e POSTGRES_PASSWORD=spike postgres:16-alpine
mkdir -p ~/rhizomorph-spikes/shipper && cd ~/rhizomorph-spikes/shipper
npm init -y && npm install pg tsx
cp "$(ls -S ~/.local/share/rhizomorph/*/session-*.jsonl | head -1)" ./ledger.jsonl

node server.mjs &            # 5451
node proxy.mjs  &            # 5452, appends to wire.log
rm -f cursor.json && EXIT_WHEN_CAUGHT=1 node shipper.mjs        # row (a)

# (b) for i in $(seq 1 20); do node shipper.mjs & sleep 0.45; kill -9 $!; wait; done
# (c) kill -9 the server mid-ship, sleep 30, restart it
# (d) rewind cursor.json by 5000 lines, re-run the shipper
# (e) head -c 64 /dev/urandom > cursor.json, re-run the shipper

./node_modules/.bin/tsx crown.mts      # chain-equality proof
./node_modules/.bin/tsx latency.mjs    # 200 appends at 5/s
./node_modules/.bin/tsx strip.mts      # preview: on the wire, not in the record

docker rm -f rz-spike-shipper-pg
```

Counts verified with:

```sql
SELECT count(*), count(distinct n), min(n), max(n) FROM events_n;
SELECT count(*) FROM (SELECT g FROM generate_series(1,63653) g EXCEPT SELECT n FROM events_n) x;  -- gaps
WITH s AS (SELECT n, serial, lag(n) OVER (ORDER BY serial) prev FROM events_n)
SELECT count(*) FROM s WHERE prev IS NOT NULL AND n <= prev;                                       -- inversions
```
