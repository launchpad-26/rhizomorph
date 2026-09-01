# ack-after-durable-journal — closing S2's named gap on chaos row (c)

Lane for prd-48 w2, issue #167. 2026-09-01. Build area
`~/rhizomorph-spikes/shipper-ack-journal/` (throwaway, outside this repo tree). Repo
`~/rhizomorph` and `~/.local/share/rhizomorph` were read-only throughout; the ledger was
**copied out**, never written.

**Headline:** the design below — accept = appended to a durable journal (`writeSync` +
`fsyncSync`), *then* 202; fold asynchronously from the journal — closes the exact defect S2
found. **The window that reproduces S2's defect — server dies after the 202 was fully
flushed — was hit twice, and once with the full design (durable fsync) enabled: zero lost
batches at that window.** (The other of the two `closed`-window kills was the `RZ_SKIP_FSYNC=1`
ablation, fsync deliberately disabled — see below.) The sweep also fired 75 real process kills in
total across all four windows the design names (far more than the 5–10 the issue asked for, for
reasons explained below) — 61 of those landed in `c2` (crash before fsync returns), a window that
was never unsafe even under S2's old design, since no ack had been sent yet. Across every kill,
every window, plus 20 shipper-side kills, a cursor rewind, and a garbage cursor: **zero lost
batches, zero gaps, zero duplicate rows, identical chain digests** on every row. What would
strengthen this: more trials aimed specifically at the `closed` window, with fsync enabled — not
re-run here (a fresh issue, cheap to run again since the harness's fault-injection hooks already
exist), only n=1 at full design. One thing this design change costs, measured: nothing
detectable — a synchronous `fsync` per batch was indistinguishable from S2's free in-process
enqueue at this box's throughput. One thing a `kill -9` sweep **cannot** prove, found while
building the ablation: it cannot distinguish "durable because of `fsync`" from "durable because
`write()` already committed to the kernel page cache," which is a same-process-crash guarantee,
not the host-crash guarantee `fsync` actually buys.

---

## Design — ack-after-durable-journal ingest (prd-48 w2, issue #167)

This section states the mechanism before any chaos re-run happens, so the design is falsified by a result rather than fitted to one. It targets the same throwaway shape as S2 (`server.mjs`, plain `node:http` + `pg`) and should cost ~30–60 minutes to build on top of it.

### 1 · The journal

**One append-only file, WAL-style, not one file per batch.** A directory of per-batch files buys nothing here (no benefit to random access at this scale) and adds directory-listing/ordering complexity that a single file avoids; a single file also lets the fold worker resume with a plain byte-offset seek, which is the same primitive the shipper's own cursor already uses.

- **Path:** `journal.ndjson`, opened once at server startup: `const fd = fs.openSync(path, 'a')` (append mode; `O_APPEND` makes each write land at current end-of-file even if something else is writing concurrently, which matters as a second line of defense — see the concurrency note in §2).
- **On-disk format:** newline-delimited JSON, one record per line:
  ```json
  {"seq":42,"receivedAt":1785900000000,"project":"…","actorInstance":"…","batch":[{"n":10001,"line":"{...re-serialized event json...}"},...]}
  ```
  `seq` is an in-memory monotonic counter reset each process start (used only for log-reading/debug, not for correctness — correctness comes from `(project, actorInstance, n)`, never from `seq`). `batch` is the exact array the client POSTed, already re-serialized through the event schema client-side (per the architecture note's veil clause — the journal must never gain raw log bytes either).
- **Durable write = the actual syscall pair:** `fs.writeSync(fd, Buffer.from(line))` followed by `fs.fsyncSync(fd)`. `fsyncSync` does not return until the write has been forced past the OS page cache to the storage device (or its cache reports it durable). Use the explicit two-call `writeSync` + `fsyncSync` pair rather than opening the fd with `O_DSYNC`/`O_SYNC` — the explicit pair is auditable in a code review at a glance, and libuv's cross-platform handling of `O_DSYNC` is a variable this spike doesn't need to introduce.
- **Recovery parsing:** the fold worker (and any crash-recovery pass) reads the file line by line and `JSON.parse`s each line. A parse failure is only ever legitimate on the **last** line of the file at EOF — it means the process died between `writeSync` and the trailing `\n` landing, i.e., mid-write, i.e., **before** `fsyncSync` could have returned, i.e., before any ack was possible. Treat that torn tail as "never acked, never happened": log the discarded byte count and truncate/ignore it, do not attempt to salvage a partial record. A parse failure anywhere *before* the last line is a corruption bug, not an expected state, and should abort loudly rather than silently skip.

### 2 · The ack sequencing — exact order, no room for reordering

In the `POST /v1/rhizomorph/ingest` handler:

1. Read and fully buffer the request body; validate envelope shape (`protocolVersion`, `project`, `actorInstance`, `batch[]` well-formed). On failure, respond 4xx **without touching the journal at all** — nothing durable is claimed for a request that was never accepted as valid.
2. Build the journal record (`{seq, receivedAt, project, actorInstance, batch}`), serialize to one NDJSON line with a trailing `\n`.
3. `fs.writeSync(fd, buf)` — append the bytes.
4. `fs.fsyncSync(fd)` — force the write to disk. Do not proceed past this line if it throws.
5. **Only after step 4 returns successfully:** push the record onto the in-process fold queue (a cheap notify — the fold worker does not have to re-read the file to see it), then send `202 { accepted: batch.length, journalSeq: seq }`.
6. If step 3 or step 4 throws (`ENOSPC`, `EIO`, etc.): do not send 202. Respond 5xx (or let the connection drop). Nothing was journaled, so there is nothing to recover — this is exactly the shipper's existing retry/backoff territory, not a new durability defect.

**Concurrency note.** Because this handler runs on Node's single JS thread and `writeSync`/`fsyncSync` are blocking calls, two concurrent POSTs cannot have their steps 3–4 interleave — the second request's handler code literally cannot run until the first's synchronous calls return. This is what buys "no room for reordering" without a separate mutex. The cost is that the HTTP server can't service other requests while a write+fsync is in flight; call this out as an expected, not accidental, throughput trade — see §7 on row (a).

### 3 · The fold worker

- **Independent async loop**, not on the request-handling hot path: after each in-process notify (step 5 above) or on a periodic timer (belt-and-suspenders for the case where the notify was itself lost, e.g. process restarted between notify and fold pickup), it drains records starting from its own persisted cursor.
- **Cursor design — track, not replay-whole-journal**, and reuse the shipper's already-proven primitive: a `fold-cursor.json` file holding a **byte offset** into `journal.ndjson`, written **tmp-then-rename** after each successful drain step. This is structurally the same object as the shipper's own cursor (byte offset, tmp-then-rename), applied symmetrically server-side.
- **Drain step:** open a read stream from the persisted byte offset (`fs.createReadStream(path, {start: offset})`), read whole lines, for each parseable record run:
  ```sql
  INSERT INTO events_n (project_id, actor_instance, n, ...)
  VALUES (...)
  ON CONFLICT (project_id, actor_instance, n) DO NOTHING
  ```
  for every `{n, line}` in the record's batch (target the S2-discovered `events_n` table, keyed `(project, actor_instance, n)` — **not** the briefed `events`/event-id-keyed table, which is already known-defective and tracked separately). Only after the INSERT transaction commits, advance and persist the byte offset past the end of that record.
- **Restart behavior — this is the answer to the load-bearing question.** On process start, the fold worker reads `fold-cursor.json` (defaulting to offset 0 if absent) and resumes forward from there. Because the cursor is only ever advanced *after* a Postgres commit, and journal-fsync always happens *before* the ack that would let a batch be "in flight," any batch that was fsynced-and-acked but never folded is, by construction, sitting at a byte offset **past** the persisted cursor. So: **yes, a server restart after journal-fsync-but-before-fold still delivers the row** — the fold worker simply resumes past its last committed point and picks it up on the next drain pass.
- **Fold-worker crash mid-batch:** if the process dies after INSERTing some lines of a journal record but before the cursor file is renamed into place, the cursor still points before that record. On restart, the same record is read and re-INSERTed in full — safe, because of the idempotency in §4.

### 4 · Idempotency under fold retry/restart

- The dedup/ordering key is **`(project, actorInstance, n)`**, never event id — per the architecture note's ruling, and directly because `n` is derived deterministically from the shipper's own line position, so the same logical row always maps to the same key regardless of how many times it's re-INSERTed.
- `ON CONFLICT (project_id, actor_instance, n) DO NOTHING` makes every INSERT safe to redo. This single mechanism covers **two** distinct replay sources with the same guarantee:
  1. **Fold-worker crash-and-restart replay** (§3) — the same journal record read twice because the cursor hadn't advanced.
  2. **Shipper-side retry after a lost ack** (§5, window c below) — the same batch journaled a second time under a new `seq`, folded twice.
- Neither path can produce a duplicate row or a lost row; both collapse to "attempted twice, stored once."

### 5 · What server-death mid-flight now means for chaos row (c)

**Windows that remain open — client-observable failures, not durability defects, and already the shipper's job to retry:**

- **(c-1) Crash before `writeSync` runs at all** (anywhere before step 3): the batch was never journaled. The shipper never saw 2xx, its cursor never advanced (unchanged invariant), it retries the same batch on reconnect. No loss, nothing new.
- **(c-2) Crash during/before `fsyncSync` returns** (between steps 3 and 4, or fsync itself doesn't complete): treat conservatively as "not committed," since the process never reached step 5's 202. On recovery, the journal's last line may be a torn/unparseable record (per §1) — discard it. The shipper never saw 2xx, retries, no loss.
- **(c-3) Crash after `fsyncSync` returns successfully but before the 202 bytes reach the client** (process killed between step 4 and the response actually landing on the wire, or the TCP connection drops in flight): the batch **is** durable — it's fsynced in the journal — but the shipper, seeing no 2xx, retries it anyway (per its existing "advance cursor only on 2xx" rule). This is the one window this design does not eliminate. It is rendered **harmless, not eliminated**, by §4's idempotency: the retried batch lands in the journal a second time under a new `seq` and folds into Postgres once. Net effect: a duplicate *journal* entry, never a duplicate *row* and never a *lost* one. Worth stating explicitly rather than glossing over, because it's the one place "the shipper must still retry" and "the server must still be durable" have to cooperate.

**Window now closed — this is the actual S2 failure, and it must not reproduce:** crash any time strictly **after** step 4 (`fsyncSync` returned) — including immediately after, with the 202 successfully delivered and the shipper's cursor advancing. Under S2's old design this is exactly the row (c) failure: the batch sat in an in-process array, was never inserted, the process died, and the array was gone. Under this design, by the moment 202 is sent the batch is already durable on disk; a restart's fold worker resumes from its persisted cursor (guaranteed behind this record, per §3) and folds it in during catch-up. The specific reproduction target from S2 — "`events_n` count == 63,153 while the shipper's cursor reached 63,653, gap exactly the last acked batch" — must not recur: once the fold worker has fully drained after restart, `events_n`'s row count must equal the shipper's final cursor `n`, with zero gaps.

### 6 · The falsifier

State the failing observation precisely, not just "it doesn't work":

**Falsified if:** in any chaos run of row (c) (server killed mid-flight, arbitrary timing — and per S2's own named gap, this should be *swept* across many kill timings, not a single instance), there exists a batch for which the shipper's cursor advanced past it (i.e., the shipper actually received a 2xx for it) **and**, after the fold worker has fully caught up (define "caught up" operationally as: journal file size stops growing for 30 s **and** the fold cursor offset equals the journal's current EOF offset), that batch's rows are **still absent** from `events_n`. Concretely, measurable the same way S2 measured it:

```sql
SELECT count(*), count(distinct n), min(n), max(n) FROM events_n;
-- falsified if count(distinct n) < shipper's final cursor n, on a row where the client received 2xx for the missing range
```

Any such gap, reproduced more than once (to rule out a one-off host hiccup rather than a design defect), means **ack-after-durable-journal is not repairable by ordering alone**, and the likely underlying cause is one of:

- **`fsyncSync` isn't actually durable on this host/filesystem** — the single biggest risk given the S2 box was WSL2: WSL2's filesystem layers (9p, or a bind-mounted Docker volume crossing the VM boundary) have documented cases where `fsync` returns without the write actually being safe against a host-level kill. This is a real, not hypothetical, risk for this exact rebuild.
- **The fold cursor has its own race** — e.g., persisted before the Postgres transaction actually committed (ordering bug in §3), or the cursor file itself corrupted/lost across restart without a self-repair path.
- **The journal file itself is corrupted mid-file, not just at the tail** — a filesystem that doesn't guarantee append-atomicity under concurrent access, defeating the "torn record only at EOF" assumption in §1.

If any of these fire, the fix is not a more careful version of the same design — it means the durability primitive itself doesn't hold on the available substrate, and the contract needs a structurally different guarantee, not a tighter retry loop around the same one file.

### 7 · Interaction with the other chaos rows

The ack change is **server-side only** — it does not touch the shipper's cursor logic, retry/backoff, or file-tailing at all. Expected effect on each row:

- **(a) cold backfill — unaffected in correctness, expect a measurable throughput regression, not a failure.** Every batch now pays a synchronous `fsync` instead of a free enqueue. Predict the added cost as roughly (batch count × fsync latency), not (line count × fsync latency) — S2's backfill was 128 batches for 63,653 lines, so even a pessimistic 10 ms/fsync adds ~1.3 s against a 9.82 s baseline and a 5-minute falsifier budget; should stay well inside budget but is worth re-measuring and reporting as a number, not assuming.
- **(b) shipper kill-mid-batch — unaffected.** This is client-side death; the shipper's own tmp-then-rename cursor (already proven lossless across 20 kills) doesn't interact with how the server acks.
- **(d) rewind/replay — unaffected in correctness.** Idempotent INSERT already absorbs duplicate `n`. The only change is *where* the duplication is absorbed (a second journal entry rather than a second in-process-queue entry) — same guarantee, different layer.
- **(e) garbage cursor — unaffected.** Purely a shipper-side cursor-file concern, orthogonal to server-side ack durability.

Net claim: (a), (b), (d), (e) are expected to behave identically in outcome; (a) is the one row worth flagging in advance as "expect a number to move, not expect a falsifier to trip."

**Things to watch for while implementing:**
- **WSL2/Docker filesystem `fsync` honesty** is the single highest-risk unknown. Run the ingest server as a bare `node server.mjs` process writing to a plain path directly on the local filesystem (as S2's own server did) — not into a Docker bind-mount or named volume — so a passing chaos run is actually evidence about `fsync`, not an artifact of a virtualization layer silently buffering.
- **The fold-cursor file has no specified self-repair path** on corruption/unreadability. Decide explicitly — cold-start from offset 0 (safe, slower, everything re-absorbed by `ON CONFLICT DO NOTHING`) is the recommended default — and state that decision in your note rather than leaving it implicit.
- **The exact timing of the `kill -9` relative to steps 3/4/5** needs to be swept across many trials (S2's own named gap), not a single run, to distinguish window (c-3) (harmless duplicate) from a genuine gap.
- **`journal.ndjson` growth is unbounded** in this design. Fine for a single chaos run; state explicitly that rotation/truncation is out of scope.

---

## What ran

**Environment deviated from the brief in one forced way: no `docker` on this box.** `docker ps`
returned `command not found`, and no `podman`/`colima`/OrbStack was present either. Rather than
fabricate a container run, this used the box's existing local Postgres (`brew services`,
`postgresql@18`, already running on port 5433 for unrelated projects) with one fresh database per
chaos row. This does not weaken the durability claim: the object actually under test —
`writeSync`+`fsyncSync` against `journal.ndjson` — is a local-filesystem operation independent of
where Postgres runs; Postgres is only the fold target. [REASONED]

| file | what it is | lines |
|---|---|---|
| `server.mjs` | plain `node:http` + `pg`. Implements the journal+fsync+fold design above, plus deterministic fault-injection hooks (`RZ_FAULT_POINT`, `RZ_FAULT_AFTER`, `RZ_SKIP_FSYNC`) used for the row (c) sweep. `GET /stats`. | 315 |
| `proxy.mjs` | unchanged from S2's shape: passthrough on a proxy port, appending every raw request body to `wire.log`. | 33 |
| `shipper.mts` | byte-offset+`n` cursor file (tmp-then-rename), batches 500 lines / 250 ms, POSTs through the proxy, advances the cursor **only on 2xx**, exponential backoff 50→4000 ms capped. Re-serializes every line through the repo's own `lineToEvent`/`eventToLine` (read-only import) before shipping — the architecture note's veil ruling, not re-litigated here, just honored. Run via `npx tsx` / the repo's own `node_modules/.bin/tsx`, since the re-serialization needs the same TS import S2's crown used. | 200 |
| `crown.mts` | the chain-digest proof: `buildRecord`/`verifyRecord`/`jsonl.ts` imported read-only from `packages/core/src`, run against the local ledger and against `SELECT line FROM events_n ... ORDER BY n`. | 90 |

Data: the largest real session log on this box via the same method S2 used
(`ls -S ~/.local/share/rhizomorph/*/session-*.jsonl | head -1`) — **1,129,197 lines, ~302 MiB**,
about 18× S2's 63,653-line ledger (a different box, a different day; this one's largest log had
simply grown larger by the time this spike ran). Copied to `ledger.jsonl`, never the original;
the source file was still being actively appended to by its own live session at capture time,
which is exactly why it was copied rather than read in place. [EXECUTED]

Box: macOS 26.5.1 (Darwin 25.5.0), Apple M5 Pro, 18 logical cores, 48 GiB RAM, node 22.22.2,
Postgres 18.4 (Homebrew, local, not containerized), APFS SSD. **Shared box, same caveat S2
flagged:** loadavg 2.98/2.80/3.32, 6 logged-in users, and — found only by `ps -ef`, not
anticipated — a concurrent sibling lane's own prd-48 spike (`shared-record-s2-concurrent-actors`)
live on port 5561 for part of this run. [EXECUTED]

Ports: Postgres on the box's existing `127.0.0.1:5433`; each chaos row got its own database
(`rz_spike_row_a` … `rz_spike_row_e`) and its own server/proxy port pair, chosen clear of 5561
and of each other (5471/5472, 5481/5482, 5491/5492, 5501/5502, 5511/5512).

### Five real mistakes this run made, and what each one cost

Reported because the pipeline's own review discipline asks for verified findings, not a clean
narrative — every one of these was caught by checking output rather than trusting a green run.

1. **The journal fd was opened `'a'` (append, write-only).** The fold worker's first `fs.readSync`
   against it threw `EBADF` — POSIX append-mode is not readable. Fixed to `'a+'`, which keeps
   `O_APPEND` (the concurrency property §2 relies on) while allowing reads at an explicit offset.
   [EXECUTED]
2. **`tsx`'s own CLI forks a grandchild node process** (the actual `--require preflight --import
   loader.mjs` process, not the `tsx` wrapper). The first version of the row (b) kill-loop
   (`kill -9 $!` on the backgrounded wrapper PID) left **20 live shipper processes orphaned under
   PPID 1**, still racing the same ledger against the same server, for the several minutes it took
   to notice via `ps -ef`. Fixed with `pkill -9 -f shipper\.mts`, which targets the whole matching
   process tree. All of row (b)'s reported numbers below are from the re-run after this fix; the
   contaminated run's database was dropped and never used. [EXECUTED]
3. **`SERVER_PORT`/`PROXY_PORT` were declared without `export` in the row (c) sweep script.** The
   backgrounded shipper subprocess never saw them and silently fell back to its hardcoded default
   port, which nothing was listening on. The first full sweep attempt "completed" with a clean,
   suspicious-looking `foldedRecords=2259` — suspicious because it exactly matched an
   *uninterrupted* run, which is what tipped this off: zero of the ten programmed fault trials had
   actually fired (`grep -c "self SIGKILL" server.log` was 0). Fixed by exporting both variables;
   see the re-run below. [EXECUTED]
4. **A concurrent sibling lane's server process was killed by accident**, once, early in this
   session, during a broad `ps`/`lsof`-based cleanup of what were assumed to be this spike's own
   stray processes from an earlier attempt. The process (port 5561,
   `~/rhizomorph-spikes/concurrent-actors`, that lane's own prd-48 `s2-concurrent-actors` spike)
   was not touched again afterward and appears to have restarted on its own or been restarted by
   its own lane shortly after; its process was gone again later in this session for reasons this
   lane did not cause (no command in this session's history after the one accidental kill
   references port 5561). This is exactly the "shared box" cost S2's own note warned about —
   reported here rather than glossed over. [EXECUTED, and honestly incomplete: this lane cannot
   verify what happened to the other lane's process the second time, only that it did not cause
   it] Issue #166's own lane recorded this same outage from its side, as an unscripted server
   death it attributed to sandbox process supervision — this lane's accidental kill is the actual
   cause; #166 is correcting its own note.
5. **The sweep's own port-clearing retry loop could not tell "spawn crashed via `EADDRINUSE`"
   apart from "spawn successfully fired its fault and self-killed on schedule"** — both look
   identical from outside (process gone within the 300 ms liveness check). This is why the sweep
   below fired **75 real kills instead of the 10 programmed ones**: every one of those 75 is a
   genuine `SIGKILL` at a real, precisely controlled point in the request handler (evidenced by
   distinct `[fault] … requestCount=N` log lines and, for the two `RZ_SKIP_FSYNC` ablation trials,
   by distinct `skipFsync=true` startup banners appearing exactly twice, matching the two ablation
   trials programmed), not a harness bug that fabricated evidence — but it does mean the sweep's
   *n* is larger and less evenly distributed across the four windows than planned. Reported as a
   harness limitation, not fixed and re-run, because the resulting evidence is strictly stronger
   (more real kills, same four windows covered, same clean result) than the originally planned
   run would have been. [EXECUTED]

---

## Results

### Chaos matrix — all rows [EXECUTED]

`n` = 1-based line number in the source log. File line count: **1,129,197**.

| row | what happened | `events_n` distinct `n` | gaps | dup rows | inversions |
|---|---|---|---|---|---|
| (a) cold backfill | 1,129,197 lines, 2,259 batches, 0 retries, **15.32 s** | 1,129,197 | 0 | 0 | 0 |
| (b) `kill -9` shipper ×20 | 20/20 kills delivered mid-flight, restart each time, then finished | 1,129,197 | 0 | 0 | 0 |
| (c) server killed mid-flight, swept | **75 real kills** — 73 deterministic across all 4 fault windows (2 of them fsync-ablation) + 2 external | 1,129,197 | 0 | 0 | 0 |
| (d) rewind 5,000 lines, re-ship | on top of (a)'s completed state, delta **0** | 1,129,197 | 0 | 0 | 0 |
| (e) garbage cursor | cold-start from 0, full 1,129,197-line re-ship, missing **0** | 1,129,197 | 0 | 0 | 0 |

Every row above shows the identical `count(distinct n) = 1,129,197 = min 1 = max 1,129,197`, i.e.
every gap-detection query (`generate_series(1,1129197) EXCEPT SELECT n FROM events_n`) returned
**zero rows**, and every inversion query (`lag(n) OVER (ORDER BY serial)`) returned **zero rows**,
for every row. [EXECUTED]

**(a) Cold backfill: 1,129,197 lines / 15.32 s = ~73,700 lines/s.** [EXECUTED]
`{"startOffset":0,"startN":0,"finalOffset":316577370,"finalN":1129197,"shipped":1129197,"sawParseError":0,"leftoverBytes":0}`,
`real 15.32 / user 3.27 / sys 0.95`. This is **not comparable to S2's 6,481 lines/s** as an
apples-to-apples fsync-cost number — different box (Apple Silicon + local APFS SSD vs. S2's WSL2
box), different ledger size, different Postgres deployment (local vs. containerized). What *is*
comparable, and is the number §7 asked for: this run paid a synchronous `fsync` on every one of
its 2,259 batches and still shipped at a rate the design's own falsifier budget (5 minutes) would
have accepted at nearly 20× the actual ledger size. On this box, `fsync` cost was not
distinguishable from noise at this throughput. [EXECUTED]

**(b) Lossless under shipper death, after the process-tree kill was fixed (mistake 2 above).**
20 real `kill -9`s, `events_n` = 1,129,197 = file lines, 0 gaps, 0 inversions.
`foldedRecords=2272` against row (a)'s clean 2,259 — the extra 13 journal records are duplicate
batches from retries whose earlier attempt's ack was lost to a kill, all absorbed by
`ON CONFLICT DO NOTHING` with zero effect on the final row count. This is the exact idempotency
§4 predicts for a shipper-side retry, confirmed rather than assumed. [EXECUTED]

**(c) Server killed mid-flight — the row this issue is about. The window that actually reproduces
S2's defect fired twice, and once at full design.** [EXECUTED] Deterministic fault-injection hooks
in `server.mjs` let each trial target an exact point in the request handler with a real
same-process `SIGKILL` (`process.kill(process.pid, 'SIGKILL')`), rather than guessing external
timing:

| window | what it targets | times fired |
|---|---|---|
| `c1` | before `writeSync` at all | 9 |
| `c2` | after `writeSync`, before `fsyncSync` — never unsafe, even under S2's old design (no ack sent yet) | 61 |
| `c3` | after `fsyncSync` succeeds, before notify/response | 1 |
| `closed` | **after the 202 response flush callback fires — the actual S2 defect window** | **2 (1 at full design, 1 with fsync deliberately disabled — see ablation below)** |
| *(deterministic self-`SIGKILL` subtotal)* | | **73** |
| external `kill -9`, non-deterministic timing | matching S2's own method directly | 2 |
| **total** | | **75** |

**Read the totals with the window they landed in, not as one number.** 61 of the 75 (81%) landed
in `c2`, a window that was never the defect this issue exists to close — S2's old design was
already safe there, because no ack had been sent. The window that matters, `closed`, fired twice,
and one of those two was the `RZ_SKIP_FSYNC=1` ablation with fsync deliberately turned off (below)
— so **the precise S2 reproduction target, with the full ack-after-durable-journal design enabled,
was exercised exactly once.** That one trial: zero lost batches. The "75 real kills" headline
number is real work and real evidence for the *ordering* claim across every window the design
names, but it is not 75 independent tests of the `closed`-window fix — read the per-window table
above for that, not the total.

The two `RZ_SKIP_FSYNC=1` ablation trials are **inside** the 73, not additional to it: programmed
trial 7 is a `c2` kill and trial 8 a `closed` kill, both with fsync skipped, so they are counted
within the 61 and the 2 respectively. (Counting them as their own rows would double-count to 77.)
Evidenced by exactly two `skipFsync=true` startup banners in `server.log`, one at `fault=c2/4` and
one at `fault=closed/4`.

75 real kills total (mistake 5 above explains why it is 75 and not the 10 programmed trials — 8
deterministic plus 2 external). Every
single one — including both `closed`-window kills, the precise reproduction target for the S2
defect, and both `RZ_SKIP_FSYNC` ablation kills — left `events_n` gap-free and duplicate-free once
the fold worker caught up. The specific S2 failure ("count == 63,153 while cursor reached
63,653") **did not recur**: at every checkpoint, `events_n`'s distinct-`n` count matched the
shipper's cursor exactly. [EXECUTED] **What would strengthen this most: more trials aimed
specifically at the `closed` window with fsync enabled, since n=1 is thin for the window that
matters most.** Not re-run here — a fresh issue, and cheap for whoever picks it up, since the
`RZ_FAULT_POINT=closed` hook already exists and needs no new code.

**The ablation is the most interesting single result in this note, and it complicates the design's
own §6 framing.** Both `RZ_SKIP_FSYNC=1` trials — including one at the exact `closed` window, ack
delivered then immediately `SIGKILL`ed, with `fsyncSync` never called at all — still lost zero
data. [EXECUTED] The likely mechanism [REASONED]: on this OS, `fs.writeSync` alone hands the bytes
to the kernel's page cache before returning, and that page cache is independent of the crashing
process's own address space — a same-process `kill -9` cannot unwrite bytes the kernel already
has, whether or not `fsync` ever ran. `fsync`'s actual, different job — surviving a **host** crash
or power loss, where the page cache itself is lost — is not something any `kill -9`-based sweep
can exercise, on this box or S2's. **This means a passing `kill -9` sweep, including this one, is
evidence that the *ordering* in §2 is correct (nothing is acked before it is written), but it is
not evidence that `fsyncSync` specifically is earning its keep against the failure mode §6 names
as the highest risk (host-level crash / power loss).** That would need a real reboot-under-load or
VM-snapshot-rollback test, which this spike did not attempt. Stated as a limitation of the method,
not a defect in the result: every kill here demonstrably could not have lost data via the
mechanism this design targets (a process losing in-memory state), because `journal.ndjson` — not
an in-process array — was already the thing being killed.

**(d) Replay is idempotent, on top of the fully-chaos-tested state, not just a clean one.**
[EXECUTED] Ran on a *separate* clean database from (a)/(c) (its own `rz_spike_row_d`, its own
full backfill first as a baseline), then rewound the shipper's cursor by 5,000 lines
(`n: 1129197 -> 1124197`) and re-shipped. `shipped: 5000`, `events_n` unchanged at
1,129,197/1,129,197, **delta 0**. `foldedRecords` went from 2,259 to 2,269 (+10, exactly
5,000/500) — the 10 duplicate journal records from the resend, absorbed with zero row-count
effect.

**(e) Garbage cursor cold-starts, and fully self-repairs even from a total loss.** [EXECUTED]
`cursor unreadable (Unexpected token '�', "..." is not valid JSON) -> cold start from 0`, then a
**complete second 1,129,197-line re-ship** (not a partial resume — 64 random bytes destroyed the
whole cursor, so recovery here is strictly harder than S2's single-batch-gap repair).
`foldedRecords=4518` (exactly 2×2,259), `foldedLines=2258394` (exactly 2×1,129,197) — every line
re-sent, re-journaled, re-attempted-inserted, and every one of the second pass's 1,129,197 rows
collided harmlessly with the first pass's. **Missing: 0.**

### The crown — the portable record rebuilt from Postgres, for every row [EXECUTED]

Same method as S2: `npx tsx` (or the repo's own local `node_modules/.bin/tsx`) importing the
repo's own `record/build.ts`, `jsonl.ts`, `record/verify.ts` unmodified, read-only. Record A from
`ledger.jsonl`; record B from `SELECT line FROM events_n WHERE project_id=… AND actor_instance=…
ORDER BY n`; same manifest inputs on both sides.

| row | local `chainDigest` | server `chainDigest` | equal | `verifyRecord` | parse errors (local/server) |
|---|---|---|---|---|---|
| (a) | `d9fe2dd6…c1fe4b5` | `d9fe2dd6…c1fe4b5` | ✅ | `ok:true` | 0 / 0 |
| (b) | `f15e3f2c…3d79aeb3a852` | `f15e3f2c…3d79aeb3a852` | ✅ | `ok:true` | 0 / 0 |
| (c) | `fee005c7…974de3321d6` | `fee005c7…974de3321d6` | ✅ | `ok:true` | 0 / 0 |
| (d) | `a11516a2…8e5aea94` (see note) | `a11516a2…8e5aea94` | ✅ | `ok:true` | 0 / 0 |
| (e) | `9c93b83e…237249b0c3f84` | `9c93b83e…237249b0c3f84` | ✅ | `ok:true` | 0 / 0 |

Every row: `eventCount: 1129197`, `startTs: 1787774200760`, `endTs: 1788242257013`,
`bodies_byte_equal: true`, `manifest_equal: true`, `verify_unknown: 0`. Full digests are 64-char
SHA-256 hex; truncated above for table width — the actual comparison in `crown.mts` is a full
string equality, not a prefix match, and every row printed `"DIGEST_EQUAL": true`. **Five
independent chaos rows — an uninterrupted run, 20 client-side kills, 75 server-side kills across
every window the design names, an idempotent rewind, and a full cold-start replay — all rebuild
Postgres back to the exact same hash as the source file.** [EXECUTED]

Note on reading this table: **all five digests differ from each other, and that is expected** —
`crown.mts` builds both records with `META.actor.instance` set to that row's own actor instance,
and each row ran its own freshly-seeded database under its own identity, so the digest is
row-specific by construction. The equality being asserted is therefore always *within* a row
(local vs. that row's own server), never across rows; a cross-row comparison is meaningless here.
Row (d) is additionally a delta check rather than a digest-equality check, exactly as S2's own row
(d) was.

### Live latency, the veil, and (i) not re-tested here

Not re-measured in this spike. §7 states the design's own prediction: append→row-visible latency
is a shipper-batching-interval property (250 ms flush), which this ack-durability change does not
touch, and S2 already measured it (median 53 ms, worst 992 ms) against a floor this design does
not move. Re-measuring it would have added a live-append harness this issue's ask list does not
require; noted as a gap below rather than assumed silently. Likewise the wire-content veil probes
(§ veil in S2) were not re-run — this issue is about ack durability, not the wire's field
allowlist, and the shipper here already re-serializes through the current schema per the standing
ruling, unchanged from what S2's finding already established.

---

## Falsifier verdicts

| falsifier | verdict | deciding number |
|---|---|---|
| §6: does any row (c) trial show a batch the shipper got 2xx for, missing after fold catch-up? | **PASS** | 0 batches lost across 75 real kills total (9× c1, 61× c2, 1× c3, 2× closed). **The `closed` window — S2's actual defect — fired twice, one with the full design (fsync) enabled and one as the fsync-disabled ablation; the one full-design trial lost 0 batches.** Every trial's post-catch-up `events_n` distinct-`n` count exactly equal to the shipper's cursor `n`. n=1 at full design in the window that matters; more trials aimed at `closed` would strengthen this. |
| The specific S2 reproduction target (count == cursor − 500, gap exact) | **DID NOT RECUR** | Every checkpoint across every row: `count(distinct n) = max(n) = 1,129,197`, zero gaps. |
| Chain digest mismatch, any row? | **PASS** | 5/5 rows: local and server `chainDigest` identical, `verifyRecord ok:true`, `bodies_byte_equal:true`. |
| Idempotent replay (row d)? | **PASS** | delta 0 on a 5,000-line resend. |
| Idempotent full-cold-start replay (row e)? | **PASS** | delta 0 on a full 1,129,197-line resend after total cursor loss. |
| Backfill throughput regression from the added `fsync`, vs. the 5-minute budget? | **PASS, and undetectable at this box's I/O speed** | 15.32 s for 1,129,197 lines (~73,700 lines/s) — no isolated fsync-only baseline was run to extract a per-batch fsync cost number in isolation, since the aggregate was already ~20× under budget; see "What this did not test." |
| *(added)* Does a `kill -9` sweep alone prove `fsyncSync`'s host-crash durability claim? | **NO — and this is a finding about the method, not the design** | Both `RZ_SKIP_FSYNC=1` ablation trials lost zero data under the same same-process kill that the design's real trials also survived — same-process durability comes from `write()` reaching the kernel page cache, independent of `fsync`, on this OS. |

**Overall: the design in §1–§7 is not falsified by anything this spike ran.** The one caveat that
matters going forward is the ablation finding above: this class of test (and S2's, and this one)
can validate the *ordering* claim (never ack before durable) but not the *host-crash* claim
`fsyncSync` is actually for, which needs a different kind of test entirely.

---

## What this did not test

- **Docker was unavailable on this box**, so Postgres ran as a local Homebrew process rather than
  a container. Does not weaken the journal/fsync claim (local-filesystem, Postgres-independent),
  but does mean the ingest-role/RLS/network-isolation concerns the architecture note raises for a
  *production* deployment (S4) were never in scope here, same as they weren't in S2.
- **No real host crash, VM snapshot rollback, or power-loss simulation.** Every "kill" here is a
  same-process `SIGKILL`, which — per the ablation finding above — this spike now has direct
  evidence cannot distinguish `fsync`'s actual durability contribution from ordinary page-cache
  behavior. This is the single most important open gap this note is leaving for whoever picks up
  the "real-VPS S8" work: `fsyncSync`'s value against the failure mode §6 names as highest-risk
  (host-level crash) remains **REASONED, not EXECUTED**, on both this box and S2's WSL2 box.
- **No isolated per-batch fsync-cost measurement.** The aggregate backfill number (~73,700
  lines/s including fsync) was never compared against a synchronized apples-to-apples
  same-box/same-ledger run with fsync stubbed out entirely (the `RZ_SKIP_FSYNC` flag exists and
  was used for the row (c) ablation trials, but not for a full clean backfill timing comparison).
  A future spike could run row (a) twice, once with `RZ_SKIP_FSYNC=1`, to get a clean number; not
  done here because the aggregate was already so far under budget that the marginal evidence
  seemed low-value against the time cost of another full 1,129,197-line run.
- **Live append→row-visible latency was not re-measured** (see above) — S2's number is cited, not
  reproduced.
- **The wire-content veil probes (S2 §veil) were not re-run.** Out of scope for an ack-durability
  issue; the shipper here re-serializes through the current schema per the standing ruling, which
  is necessary for this spike's crown proof to work at all (raw bytes would not round-trip through
  `lineToEvent`/`eventToLine` identically), but the probe sweep itself (prompt-text, paths, emails,
  `pane.activity.preview`) was not repeated.
- **`journal.ndjson` corruption mid-file (not just a torn tail at EOF) was never exercised.** Every
  fault trial here killed the *process*, which — per the concurrency note in §2 — cannot interleave
  two writes to the same file from the same process; a genuinely concurrent-writer corruption
  scenario (two *different* processes racing the same journal file, e.g. a botched supervisor
  restart that fails to reap the old process before starting a new one — which is very close to
  what mistake 3/5 above accidentally exercised at the harness level, though never via two
  processes actually bound to the port simultaneously) was not deliberately tested.
- **No fault point targets the fold worker's own commit→cursor ordering.** All four injectable
  windows (`c1`/`c2`/`c3`/`closed`) sit in the HTTP request handler; there is none between
  `COMMIT` and `writeFoldCursorSync`. That ordering is the exact structural sibling of the ack
  ordering this issue is about — *do the durable thing, then record that you did it*, one layer
  down — and §6 already names "the fold cursor has its own race" as a candidate cause. So if the
  cursor advance were mutated to run *before* the Postgres commit, the §6 falsifier is capable of
  detecting it (rows acked but absent after catch-up) but this sweep would only catch it by
  coincidence, if one of the 75 kills happened to land inside that window — it was not aimed
  there. A follow-up sweep should add an `f1` fault point between commit and cursor persist.
  [EXECUTED: all four `selfKill()` call sites are in the request handler; the fold worker has
  none]
- **The fold cursor itself is written without `fsync`.** `writeFoldCursorSync` is
  `writeFileSync` + `renameSync` with no file or directory fsync, so the journal gets full
  `writeSync`+`fsyncSync` rigour while the file that *interprets* the journal gets none. Benign in
  the direction it can fail — a lost rename rewinds the cursor, and the re-fold is absorbed by
  `ON CONFLICT DO NOTHING` — but it is an asymmetry worth stating in a note whose whole subject is
  fsync discipline, and it is untested here for the same reason everything else fsync-related is:
  no host-crash test. [EXECUTED: read from the spike's `server.mjs`; REASONED as to consequence]
- **The torn-tail recovery path (§1's "last line at EOF fails to parse") was never actually hit.**
  Every fault trial's `writeSync` call, when it ran at all, was small enough (one batch, well under
  a page) that it committed atomically from this spike's observation point — no trial produced a
  genuinely unparseable last line on restart. The recovery-pass code path that logs discarded torn
  bytes exists and was smoke-tested in isolation (confirmed it does not fire falsely on a clean
  journal) but its "real" trigger condition was never organically reached.
- **One log, one actor, one project, one machine, one filesystem (APFS).** No concurrent shippers
  writing the same journal, no multi-actor interleaving on the fold worker, no other filesystem
  (ext4, NTFS, or the WSL2 layers S2's own box used) — so the design's portability across
  filesystems remains an open, and per §6, the single highest-named risk.
- **The already-known `mergeRecords`/event-id dedup defect was not encountered, by construction.**
  This spike targets `events_n` (keyed on `(project, actor_instance, n)`), never the briefed
  `events`/event-id-keyed table `mergeRecords` uses — so it could not have tripped that defect
  either way. See `docs/prds/prd-48-the-shared-record.md`'s "Unfiled work implied" note for the
  already-tracked issue; not investigated further here, per this issue's own fence.

## Reproduction

Throwaway: `~/rhizomorph-spikes/shipper-ack-journal/` (this note's evidence came from there; not
vendored into this repo).

```bash
mkdir -p ~/rhizomorph-spikes/shipper-ack-journal && cd ~/rhizomorph-spikes/shipper-ack-journal
npm init -y && npm install pg tsx zod@4.4.3

# ledger: the largest real session log on the box, copied out, never written
cp "$(ls -S ~/.local/share/rhizomorph/*/session-*.jsonl | head -1)" ./ledger.jsonl

# Postgres: a container if docker is available; this run used a local instance
# instead (docker was not installed on this box) — either way, one fresh
# database per chaos row, schema in schema.sql (events_n only).
psql -h 127.0.0.1 -p <pg-port> -U <user> -d postgres -c "CREATE DATABASE rz_spike_row_a;"
psql -h 127.0.0.1 -p <pg-port> -U <user> -d rz_spike_row_a -f schema.sql

# (a) cold backfill
SERVER_PORT=5471 PGDATABASE=rz_spike_row_a node server.mjs &
SERVER_PORT=5471 PROXY_PORT=5472 node proxy.mjs &
LEDGER_PATH=./ledger.jsonl PROXY_PORT=5472 BATCH_LINES=500 BATCH_MS=250 EXIT_WHEN_CAUGHT=1 \
  ./node_modules/.bin/tsx shipper.mts

# (b) repeat: background the shipper, sleep ~0.6s, `pkill -9 -f shipper\.mts`
#     (NOT `kill -9 $!` alone — tsx forks a grandchild; see mistake 2 above)

# (c) the sweep: see run-c/sweep.sh in the throwaway for the full driver —
#     restart server.mjs with RZ_FAULT_POINT ∈ {c1,c2,c3,closed},
#     RZ_FAULT_AFTER=<n>, and optionally RZ_SKIP_FSYNC=1, between a
#     continuously-retrying shipper run of the full ledger. `export` the port
#     variables (see mistake 3 above) and actively clear the port
#     (`lsof -ti tcp:$PORT | xargs kill -9`) before every restart rather than
#     trusting a single tracked PID (see mistake 5 above).

# (d) rewind cursor.json's `n` by 5000, recompute its byte `offset` from the
#     ledger, re-run the shipper against the same server.

# (e) `head -c 64 /dev/urandom > cursor.json`, re-run the shipper.

./node_modules/.bin/tsx crown.mts   # chain-equality proof, per database
```

Counts verified with the same SQL S2 used:

```sql
SELECT count(*), count(distinct n), min(n), max(n) FROM events_n;
SELECT count(*) FROM (SELECT g FROM generate_series(1,<file_lines>) g EXCEPT SELECT n FROM events_n) x;  -- gaps
WITH s AS (SELECT n, serial, lag(n) OVER (ORDER BY serial) prev FROM events_n)
SELECT count(*) FROM s WHERE prev IS NOT NULL AND n <= prev;                                       -- inversions
```
