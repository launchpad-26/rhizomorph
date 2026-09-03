# the fold worker's commit→cursor ordering — a tested case, not an assumed one

Lane for prd-48 w4, issue #205. 2026-09-03. Build area
`~/rhizomorph-spikes/fold-worker-ordering/` (throwaway, outside this repo tree). This extends
#167's sweep (`docs/research/2026-08-29-shared-record-s2-ack-after-journal.md`) to the layer it
did not reach; **it does not re-litigate #167's verdict**, which stands.

**Headline:** #167's four fault windows all sit in the HTTP request handler. Its own "what this
did not test" names the omission — *"no fault point targets the fold worker's own commit→cursor
ordering"* — and observes that its falsifier could only have caught a reversal by coincidence.
This run adds the fifth window, `f1`, between the Postgres `COMMIT` and the fold cursor's persist,
and fires it **30 times against the correct ordering: 0 lost batches, 0 gaps, 0 inversions**
(the fourth of #167's queries, `duplicate n`, is structurally unable to return anything but 0 —
see §4.1). The same 30-trial schedule run against a deliberately reversed ordering —
cursor persisted *before* the commit, one env flag, everything else identical — **loses 15,000
lines in exactly 30 contiguous 500-line runs, one per kill**, every one of them a batch the
shipper holds a 202 for. So the window is real, the fault point can fail for the reason it
claims, and the shipped ordering is what stops it. Separately, #167's `closed` window — the one
that reproduces S2's original defect, and which it fired **once** at full design — was re-swept
**30 times with fsync enabled: 0 lost batches**, of which at least 27 provably delivered their ack
before dying. And the fold cursor's missing `fsync` is ruled **correctly cheap**, on evidence: all
five post-crash cursor states a non-durable write can leave behind were written by hand and
recovered from, every one to zero gaps.

---

## 1 · What #167 left, and the shape of the bug it left untested

The design #167 built has two orderings in it, not one, and they are the same rule applied one
layer apart — *do the durable thing, then record that you did it*:

| | the durable thing | the record of it | fault-tested by #167 |
|---|---|---|---|
| request handler | `writeSync` + `fsyncSync` the journal | send the `202` | yes — `c1`, `c2`, `c3`, `closed` |
| fold worker | Postgres `COMMIT` | persist the fold cursor's byte offset | **no** |

Reverse the second one and a crash between the pair leaves the fold worker resuming *past* a
batch that never landed. The shipper already advanced its own cursor on the `202`, so it never
re-sends, and the row is gone — S2's defect arriving by a different route, and invisible to
everything except a gap check.

The implementation is correct today; #167's §3 states commit-then-advance and the code follows it.
The claim this note makes is not that the code changed. It is that **the case is now tested**,
which it was not.

## 2 · The new fault point

`f1` is a fifth value for the existing `RZ_FAULT_POINT`, not a second mechanism. Two decisions
worth stating, because both could have gone otherwise:

**`RZ_FAULT_AFTER` is counted in whatever unit the armed window lives in.** For `c1`/`c2`/`c3`/
`closed` that stays what #167 made it — POST requests this process instance handled. For `f1` it
is **drain steps this instance carried to the between-point**. A drain step is one `COMMIT` of one
journal delta, so with a paced shipper it is one journal record. Reusing the same variable with a
window-appropriate unit keeps one grammar; adding `RZ_FAULT_AFTER_DRAINS` would have been a second
one. Both counters stay per-process, as #167's did, because every trial restarts the server fresh.

**The mutation is a flag on the ordering, not a second fault point.** `RZ_CURSOR_BEFORE_COMMIT=1`
makes the fold worker persist the cursor before the transaction commits. `f1` stays in the same
textual place — *between the pair* — so one environment variable flips which side of the kill is
durable:

```
correct   BEGIN → INSERT → COMMIT → [f1 kills here] → persist cursor
mutated   BEGIN → INSERT → persist cursor → [f1 kills here] → COMMIT
```

That is what makes the A/B exact: same driver, same trial schedule, same trial count, same
database schema, same ledger, one variable. If the gap check does not disagree between them, the
sweep is measuring nothing — which is the whole reason the mutation is mandatory rather than nice
to have.

## 3 · What ran

Box: macOS 26.5.1 (Darwin 25.5.0), Apple M5 Pro, 18 logical cores, 48 GiB RAM, node v22.22.2,
Postgres 18.4 (Homebrew, local, not containerized), APFS SSD. **Shared box, and materially more
loaded than #167's:** loadavg **55.93 / 30.77 / 23.00** with 7 logged-in users at capture — two
sibling prd-48 lanes were live in their own worktrees for the whole of this run. Every number
below is a correctness count, not a throughput claim, for exactly that reason. [EXECUTED]

Postgres was read for the two settings the ruling in §6 rests on: `fsync=on`,
`synchronous_commit=on`. [EXECUTED]

Data: **the same `ledger.jsonl` #167 used**, reached by symlink rather than re-copied from the
live source — 316,577,370 bytes, **1,129,197 lines**, byte-identical to the `finalOffset` #167's
row (a) reported. Re-copying would have picked up a larger, different log and made every count
here incomparable with the note this one extends. [EXECUTED]

| file | what it is | lines |
|---|---|---|
| `server.mjs` | #167's server, plus the `f1` window, the `RZ_CURSOR_BEFORE_COMMIT` ordering flag, `drainSteps` in `/stats` and in the fault log line. 62 changed lines against #167's copy. | 365 |
| `shipper.mts` | #167's shipper. Two changes: the read-only `jsonl.js` import goes through a `repo` symlink (#167's copy hard-coded a worktree path that no longer exists), and `SHIP_DELAY_MS` paces it. 14 changed lines. | 212 |
| `sweep.sh` | one parameterised driver for all three sweeps — window, trial count, database, port and the ordering flag are arguments. Replaces #167's hardcoded `TRIALS` array. | 182 |
| `run-all.sh` | runs the three sweeps sequentially. One box, one Postgres; concurrent runs would have contended for both. | 18 |
| `check.sh` | the falsifier as SQL: rows / distinct `n` / gaps below the shipper's own final cursor / duplicate `n` / inversions. | 19 |
| `cursor-states.sh`, `cursor-states-2.sh` | the §6 ruling's probes — the post-crash cursor states, written by hand. | 100 + 53 |
| `journal-dups.mjs` | counts journal records that are re-sends of an already-journaled batch, keyed on the batch's own `(first n, last n)`. | 19 |
| `schema.sql` | unchanged from #167 — `events_n` only. | 13 |

**`SHIP_DELAY_MS` is a pacing knob and nothing else**, and it exists because of an arithmetic
problem #167 did not have. Its sweep was 10 trials against a shipper that empties this ledger in
~15 s. Thirty trials take ~3 minutes, so an unpaced shipper finishes first and the later trials
fire against a server nothing is POSTing to — which does not produce a *failed* trial, it produces
a *silent* one that still gets counted. Pacing to 60 ms between successful flushes puts the
shipper's floor (2,259 batches ≈ 135 s) past the schedule. It touches nothing about batching,
cursor advance, retry, backoff or ordering.

**No proxy.** #167 ran its passthrough proxy to capture the wire; the veil is not in scope here and
that proxy wrote a 4.4 GB `wire.log` for a question this issue does not ask. The shipper posts
straight at the server. [EXECUTED]

Ports 5701 / 5703 / 5705 / 5707 — one per run, chosen clear of everything else listening on the
box, and each run got its own fresh database (`rz_fold_f1`, `rz_fold_mut`, `rz_fold_closed`,
`rz_fold_cursor`) prefixed distinctly from #167's `rz_spike_row_*`.

## 4 · Results — read every count with its window

**In all three sweeps the shipper finished the ledger**: `finalN: 1129197`, `shipped: 1129197`,
`sawParseError: 0`, `leftoverBytes: 0`. That is what makes a missing row a *lost acked batch*
rather than an unfinished ship, and it is why the gap query below is asked against the shipper's
own final cursor `n` rather than against the file's line count. [EXECUTED]

### 4.1 · `f1`, correct ordering — 30 trials

| | |
|---|---|
| targeted `f1` kills that fired | **30** |
| trials programmed | 30 |
| `RZ_SKIP_FSYNC` | never set; all 61 server instances banner `skipFsync=false` |
| `RZ_CURSOR_BEFORE_COMMIT` | never set; all 61 instances banner `cursorBeforeCommit=false` |
| batches acked by the shipper | 2,259 |
| distinct batches in the journal | 2,259 — every batch journaled at least once |
| duplicate journal records | 2 (`n` 13001–13500, 58001–58500) — acks lost in flight, re-sent, absorbed |

```
  rows   | distinct_n | min |   max
---------+------------+-----+---------
 1129197 |    1129197 |   1 | 1129197
gaps below the shipper's cursor: 0
duplicate n:                     0
inversions (n vs insert order):  0
```

Every one of the 30 kills landed after a `COMMIT` had returned and before the cursor recording it
was renamed into place. On restart the cursor still pointed *before* the committed range, the
range was re-folded in full, and `ON CONFLICT (project_id, actor_instance, n) DO NOTHING` absorbed
every row of it. **The evidence for the re-fold is the resumed offsets, not the duplicate count** —
after each of the 30 faults the next instance's `foldOffset(resumed)` banner is *behind* the range
the killed instance had just committed, so that range was read and inserted a second time. In 28
of the 30 it lands exactly on the boundary one journal record back; the other 2 land further back
still, which is a multi-record drain step and is dealt with in §9. [EXECUTED — `server.log`'s
banner sequence against the journal's own record boundaries]

**`duplicate n: 0` in the block above is not evidence of anything and is reported only because it
is one of #167's four queries.** `schema.sql` declares `PRIMARY KEY (project_id, actor_instance,
n)` and every run uses a single project and a single actor instance, so `n` is unique by
construction: a deliberate second insert of the same `n` is rejected by the primary key outright,
and under `ON CONFLICT DO NOTHING` it is silently absorbed. The query therefore returns 0 whatever
the fold worker does. The check that can actually fail is the gap count, and §4.2 is the proof that
it does. [EXECUTED — schema re-created in a scratch database and a duplicate insert attempted
against it; rejected by `events_n_pkey`, and the duplicate-`n` query still returned 0]

### 4.2 · `f1`, ordering deliberately reversed — 30 trials, and it fails

Same driver, same 30-trial schedule, same ledger, same schema, `RZ_CURSOR_BEFORE_COMMIT=1` on
every server instance in the run (61 of 61 banner `cursorBeforeCommit=true`), so the reversed
ordering is the *implementation under test* and not just one trial's fault. [EXECUTED]

```
== rz_fold_mut (shipper final cursor n = 1129197) ==
  rows   | distinct_n | min |   max
---------+------------+-----+---------
 1114197 |    1114197 | 501 | 1129197

gaps below the shipper's cursor: 15000
duplicate n:                     0
inversions (n vs insert order):  0
first 5 missing n (empty = none):
1
2
3
4
5
```

The shape of the loss is the finding, not just its size:

```
 gap_runs | min_len | max_len | total_missing
----------+---------+---------+---------------
       30 |     500 |     500 |         15000

 from_n |  to_n  | len
--------+--------+-----
      1 |    500 | 500
  14001 |  14500 | 500
  29001 |  29500 | 500
  44001 |  44500 | 500
  59001 |  59500 | 500
  ...
```

**Thirty contiguous runs of exactly 500 missing lines — one whole batch per targeted kill, 30 kills,
30 gaps, no partial ones and no extras.** Each is a batch the shipper POSTed, received a `202`
for, advanced its own cursor past, and never re-sent; the fold worker persisted a cursor past the
record and then died before the transaction carrying it committed. 500 is `BATCH_LINES`, so the
unit of loss is exactly the unit of ack. [EXECUTED]

This is the answer to *"what mutation would this test survive?"*: **none of the ones that matter.**
The gap check is not decoration — reversing the two statements it exists to protect turns it red,
30 times out of 30, with a signature that identifies which kill caused which gap.

Worth stating plainly, because it is the thing the falsifier in §7 turns on: the mutated run's
journal is *intact*. All 2,259 distinct batches are in it, durably fsynced, exactly as
ack-after-durable-journal promises. The bytes were never lost. **The fold worker lost them by
recording that it had read further than it had.** Journal durability did not save the row,
because journal durability is not the property that was violated.

### 4.3 · `closed` at full design — 30 trials, its own number

#167 fired `closed` twice, one of which was the `RZ_SKIP_FSYNC=1` ablation, so the full design was
exercised there exactly once and its note flagged that as the thinnest part of its evidence. This
is that number re-taken, and it is reported here on its own rather than folded into any total.

| | |
|---|---|
| targeted `closed` kills that fired, **fsync enabled** | **30** |
| instances with `skipFsync=true` | 0 of 61 |
| batches acked | 2,259 |
| distinct batches in the journal | 2,259 |
| duplicate journal records | 3 (`n` 30501–31000, 279501–280000, 324501–325000) |

```
  rows   | distinct_n | min |   max
---------+------------+-----+---------
 1129197 |    1129197 |   1 | 1129197
gaps below the shipper's cursor: 0
duplicate n:                     0
inversions (n vs insert order):  0
```

**At least 27 of the 30 were true reproductions of S2's window, and that is a bound rather than an
assumption.** A `closed` kill only reproduces S2's defect if the `202` actually reached the
shipper; if it did not, the shipper re-sends and the trial degenerates into the design's own
harmless (c-3) case. A lost ack is *observable* — it is exactly what produces a second journal
record for the same batch — and this run produced **3** such records across all 60 kills in it
(30 targeted `closed`, 30 untargeted, §4.4). So at most 3 of the 30 `closed` trials could have
had their ack lost, and **≥27 delivered the ack and then died**, which is S2's failure condition
precisely. Every one of them lost nothing. [EXECUTED]

That takes the window that matters from **n=1** to **n≥27** at full design.

### 4.4 · The counts that are not trials, and why they are stated anyway

Each run's log reports three numbers, and reporting only the first would be #167's 75-versus-10
problem in a new coat:

| number | run 1 | run 2 | run 3 | what it is |
|---|---|---|---|---|
| targeted `[fault]` kills | 30 | 30 | 30 | the trials. One per faulting instance, each armed at a named window. |
| bind banners | 61 | 61 | 61 | **not** trials. 30 faulting instances + 31 plain restarts (one at run start, one after each trial). Every instance prints one banner from inside its `listen` callback. |
| untargeted port-clear `kill -9`s | 31 | 30 | 30 | **not** trials either. `start_server` force-clears whatever holds the port before every spawn, so the plain restart server is `kill -9`ed at an arbitrary moment before each faulting spawn. |

The untargeted kills are real chaos and land wherever they land, including inside the fold pair —
they are extra evidence for the design and **zero evidence for any particular window**, so they
are named here and counted nowhere else. Run 1's extra one (31, against 30) is a leftover
smoke-test server still listening on the reused port 5701 when the run started; runs 2 and 3 used
fresh ports and got exactly the 30 the schedule predicts. [EXECUTED for the counts; REASONED for
the attribution of run 1's extra one, from the fact that only the run on a reused port has it]

Also stated because it is the counterpart of the 75: **`TRIAL WARNING` count is 0 in all three
runs, `EADDRINUSE` retry count is 0 in all three, `[fold] drain error` count is 0, and torn-tail
recoveries 0.** No trial silently failed to fire, and no trial fired twice — see mistake 1 in §8
for why that needed fixing before any of these numbers meant anything. [EXECUTED]

## 5 · Where the boundary of this method is

Three of the four `f1` kill outcomes are decided by Postgres, not by the harness, and it is worth
being explicit that this is the reason commit-then-advance works rather than a lucky property of
the test:

- A same-process `SIGKILL` of the *server* drops its connection. Postgres aborts any transaction
  on that connection that has not committed. There is no in-doubt state to recover.
- A `COMMIT` that has returned is durable independently of the server process, because
  `synchronous_commit=on` means Postgres flushed its own WAL before answering. [EXECUTED — read
  from the running instance]
- So the fold cursor can only ever be **behind or equal to** the committed truth, never ahead.
  Everything in §6 follows from that one asymmetry, and the mutation in §4.2 is precisely the
  edit that destroys it.

## 6 · Ruling — the fold cursor's missing `fsync` is correctly cheap

The journal's write is `writeSync` + `fsyncSync`. The fold cursor's is `writeFileSync` +
`renameSync` with no file fsync and no directory fsync. **Verdict: correctly cheap, not a
durability gap** — but the reason is narrower than "the cursor is recoverable", and the honest
limits are worth more than the verdict.

**The argument, and why it is an argument about a set of states rather than about `fsync`.**
#167's own ablation established that on this OS a same-process `kill -9` cannot unwrite bytes
`write()` has already handed to the kernel page cache — both its `RZ_SKIP_FSYNC=1` trials lost
zero data. That finding cuts both ways, and the second way is the one that matters here: **no
kill-based trial on this box can ever *produce* a lost cursor write**, so a sweep claiming to test
the cursor's fsync would be testing nothing at all. Any note that ran one and reported a pass
would be reporting the absence of a mechanism, not the presence of a guarantee.

So the question was re-put as one that can actually be answered: *is every cursor state a
non-durable write could leave behind a safe one?* That set is small and closed, so each member was
written by hand and recovered from. Ledger 1,129,197 lines, journal 406,833,703 bytes, no faults
in the backfill:

| post-crash cursor state | how it arises | recovery | distinct `n` | gaps |
|---|---|---|---|---|
| offset 0 | maximal rewind | re-folds all 2,259 records, **7,410 ms** | 1,129,197 | **0** |
| partial rewind to offset 360,095,470 | the rename never landed; the file still holds its previous value, which is always a real record boundary | re-folds the 259 records past it, **1,225 ms** | 1,129,197 | **0** |
| zero length | the rename landed, the tmp file's data blocks did not | `JSON.parse` throws → cold start from 0, **5,277 ms** | 1,129,197 | **0** |
| 64 bytes of garbage (`16a9ad71325048a1…`) | same, with stale or partial bytes rather than nothing | cold start from 0, **5,180 ms** | 1,129,197 | **0** |
| absent | the file is gone entirely | cold start from 0, **5,307 ms** | 1,129,197 | **0** |

[EXECUTED — all five, each followed by a real restart and the full gap query]

**Every reachable state is behind-or-equal, and behind is safe**, because §5's asymmetry holds and
`ON CONFLICT DO NOTHING` absorbs the re-fold. A non-boundary offset — a cursor pointing into the
middle of a record — is *not* in the set: the write is a whole-file rewrite of a tiny JSON object
followed by a rename, so a torn write yields empty or garbage, never a different valid number.
[REASONED, and the reason it is only reasoned is stated below.]

**What this ruling costs, and it is not nothing.** The saving is one `fsync` per drain step. The
price is that cursor loss is more likely, and the recovery path it lands in is **unbounded in the
journal's size**: `drainOnce` reads everything from the cursor to EOF into a single
`Buffer.alloc`, and folds it in one transaction. The offset-0 probe therefore allocated a
406,833,703-byte buffer and inserted 1,129,197 rows in one statement batch and one transaction —
it survived here, at this journal size, on a box with 48 GiB. That is a real operational hazard of
the pair *cheap cursor + cold-start-from-0*, it grows with a journal `#167` already flagged as
unbounded, and it is a property of the recovery path rather than of the missing `fsync` — but the
missing `fsync` is what makes that path more reachable. Naming it is the honest form of "correctly
cheap". [EXECUTED — the buffer size and the row count are from the probe's own `/stats`]

**What this box cannot settle, and what would.** The ruling rests on the claim that the reachable
set is closed — that no crash produces a cursor *ahead* of the truth. On this box that cannot be
falsified by any test available, because the only crash it can stage is a same-process kill, which
loses neither page-cache bytes nor a returned Postgres commit. Two things would settle it and
neither is a `kill -9`:

1. **A host crash or power loss.** It would have to show a rename landing while the file's data
   blocks did not *and* a returned `COMMIT` failing to survive — the second of which
   `synchronous_commit=on` is supposed to make impossible, so the test is really of Postgres's own
   durability on this filesystem, which is the same open question #167 left. This is the same gap,
   not a new one.
2. **A filesystem-level crash-consistency simulator** (`dm-log-writes` and friends), which can
   reorder and truncate at the block layer and would answer the APFS ordering question directly.
   Not available on this box.

**The sibling case, which is where the real risk is.** Commit-then-advance is safe *because a
returned `COMMIT` is durable*. That is a property of `synchronous_commit=on`, which this box has
and which a throughput-minded deployment may well turn off. With `synchronous_commit=off` a
`COMMIT` returns before its WAL is flushed, so a host crash could lose the commit while the cursor
that recorded it survives — **the mutated ordering's exact failure mode, arriving without the
mutation.** That is untested here for the same reason as everything else in this section, and it
is the one line the build PRD should carry beside the ordering itself. [REASONED]

## 7 · Falsifier verdicts

The falsifier, stated before the sweeps ran: *if a crash between the fold worker's commit and its
cursor persist can strand an acked batch, then ack-after-durable-journal is not sufficient on its
own, and the build PRD needs the fold worker's ordering in its contract too — not only the ingest
handler's.*

| falsifier | verdict | deciding number |
|---|---|---|
| Can a crash at `f1`, with the shipped commit-then-advance ordering, strand a batch the shipper holds a `202` for? | **NO — not falsified** | 30 targeted `f1` kills, 0 gaps below a shipper cursor that reached `n`=1,129,197, and 0 inversions. (`duplicate n` is excluded here: the primary key makes it 0 regardless — §4.1.) |
| Can the `f1` check fail at all — i.e. is it capable of catching the reversal it exists to catch? | **YES, and it does** | The same 30-trial schedule with `RZ_CURSOR_BEFORE_COMMIT=1`: **15,000 lines lost in exactly 30 runs of 500**, one per kill. The fault point is not decoration. |
| `closed` at full design, re-swept (#167's n=1) | **PASS at n=30** | 30 kills after the response flush callback, fsync enabled on all 61 instances, 0 gaps. ≥27 provably delivered their ack first, bounded by the run's 3 duplicate journal records. |
| Is the fold cursor's missing `fsync` a durability gap? | **NO — correctly cheap** | All five reachable post-crash cursor states recover to 0 gaps. Cost is recovery time (up to 7,410 ms here) and an unbounded single-buffer re-read, not correctness. |
| Does anything here weaken #167's verdict? | **NO** | Its `closed` result is reproduced 30× rather than 1×, and its ablation finding is the thing that made §6's method necessary. |

**Verdict on the issue's own question: the falsifier did not fire, and the PRD line should change
anyway.** No crash at `f1` stranded anything, so ack-after-durable-journal is not *broken*. But the
mutated run is the proof that it is **not sufficient on its own as a written contract**: the
journal in that run was fully durable and fully fsynced, every one of its 2,259 batches present,
and 15,000 rows were lost regardless — because the sufficiency lives in a second ordering that the
phrase "ack-after-durable-journal" does not mention. prd-48's success criterion 2 currently reads
*"the build requirement is ack-after-durable-journal"*. That phrase names the handler and is silent
about the fold worker, and a build that implemented exactly what it says could still produce
§4.2's output. **The build PRD should carry both orderings**: ack only after the journal write is
durable, *and* advance the fold cursor only after the transaction commits. The second is now the
one with a mutation test behind it.

## 8 · Mistakes this run made

1. **The spawn detector could not tell a crashed spawn from a fast fault, and inflated the trial
   count before anyone was watching.** #167's `start_server` decides a spawn succeeded by checking
   the pid is alive 300 ms later — which is exactly the ambiguity its own mistake 5 records, and
   the reason it fired 75 kills for 10 programmed trials. Inherited unchanged, it did the same
   here: the first mutated smoke run fired **15 kills for 3 programmed trials**, because a server
   that binds, drains a backlog, fires `f1` and self-kills inside 300 ms looks identical from
   outside to one that died to `EADDRINUSE`. That is survivable when the claim is "nothing was lost
   across all of them" and **fatal when the claim is a per-window count**, which is what this issue
   exists to produce. Fixed by deciding on evidence instead of liveness: the server prints one
   `server on <port>` banner from inside its `listen` callback and an `EADDRINUSE` crash prints
   none, so the driver waits for the banner count to rise. After the fix: 30 targeted kills for 30
   programmed trials, in all three runs, with 0 retry lines. The smoke run's polluted database was
   dropped and none of its numbers appear here. [EXECUTED]
2. **A trial schedule longer than the shipper is a silent trial, not a failed one.** With #167's
   unpaced shipper the last trials of a 30-trial run fire against a server nothing is POSTing to;
   the window never opens, and without a guard the run still reports 30 programmed trials. Two
   fixes, both kept: `SHIP_DELAY_MS` paces the shipper past the schedule, and the loop stops
   scheduling if the shipper has already exited rather than banking 30-second timeouts. The
   4-trial smoke run caught this by reporting 3 — the one that did not fire is the one the guard
   is for. [EXECUTED]
3. **A leftover smoke-test server was still listening on port 5701 when run 1 started.** It was
   force-cleared by the driver's own port clear before run 1's first server bound, which is why
   run 1 reports 31 untargeted kills against runs 2 and 3's 30. It wrote to its own (since
   dropped) database and its own journal path, so it could not have touched run 1's data — but the
   count it perturbed is a count this note reports, so it is stated rather than rounded away.
   Reusing a port a smoke run had used was the actual error. [EXECUTED for the count; REASONED for
   the identification]
4. **The first cursor-state pass logged the garbage probe and the delete probe identically.** Both
   printed `<absent>` for the cursor's state, because the echo pipeline could not render 64 random
   bytes — so the log did not distinguish the state under test from a different one, and a passing
   probe proved nothing about the state it was named for. Re-run as probe 3b with a byte count and
   a hexdump of the actual file (`64` bytes, `16a9ad71325048a1…`) as the evidence. The first pass's
   probe 1 had the sibling weakness: it set offset 0, which is the maximal rewind and identical in
   effect to a cold start, so it never exercised a *partial* one — probe 5 adds the real
   "the rename never landed" case at a derived record boundary. Both re-runs are in the table in
   §6; the weak originals are not. [EXECUTED]
5. **This lane's session was interrupted between the sweeps finishing and this note being written,
   leaving four server processes and a shipper alive.** They were killed before any count in this
   note was read. Checked rather than assumed: no file in any run directory has an mtime after its
   own run's `=== DONE ===` timestamp, so nothing stray wrote to a journal, a cursor or a log whose
   numbers are reported here. [EXECUTED]

## 9 · What this did not test

- **No host crash, power loss, or VM snapshot rollback.** Every kill here is a same-process
  `SIGKILL`, and per #167's ablation that class of test cannot distinguish `fsync`'s durability
  contribution from ordinary page-cache behaviour. §6 says what would settle the questions this
  leaves; none of them is a `kill -9`.
- **`synchronous_commit=off` was not exercised**, and §6 names it as the sibling risk. On this box
  it could not have been tested anyway — a same-process kill of the *server* cannot lose a
  Postgres commit whether or not its WAL is flushed, because Postgres is a different process.
- **A kill landing *inside* a multi-record drain step is untested — but the multi-record drain step
  itself was not avoided.** Pacing makes a drain step one journal record in most trials, which is
  what makes `RZ_FAULT_AFTER` precise, and it was assumed here that this made every faulted drain
  step a single record. The logs say otherwise: in `run-f1-control`, 28 of the 30 faulting
  instances had advanced the cursor by exactly one record per completed drain step, but **2 had
  advanced it by 9 and 27 records across 2 and 3 completed steps** — a backlog accumulated across
  the restart and was drained several records at a time, under a live shipper, in an instance that
  was then killed. Both recovered to 0 gaps. What genuinely remains untested is narrower than
  "multi-record drains": the *killed* step's own size is not recoverable from these logs, because
  the whole point of the window is that its cursor never persisted. So a kill demonstrably
  mid-*backlog* is covered; a kill demonstrably mid-*record-batch* is not, and it should behave
  identically (the pair is the same pair) — but that is still an argument, not a trial.
  [EXECUTED for the 28 / 2 split, derived from each faulting instance's `drainSteps` against the
  next instance's `foldOffset(resumed)` and the journal's record boundaries; REASONED for the
  remaining claim]
- **`c1`, `c2` and `c3` were not re-swept.** #167 covered them (9 / 61 / 1) and this issue is
  explicitly not a re-litigation. The `closed` re-sweep is here only because #167's own note named
  it as its thinnest evidence.
- **No crown / chain-digest proof.** #167 ran `crown.mts` for all five of its rows and got
  identical digests; this issue's definition of done asks for gap counts, and the gap query is the
  falsifier. A digest match would have added no discrimination the 30-run gap signature in §4.2
  does not already have.
- **No throughput number is claimed.** The box's loadavg was 55.93 with two sibling lanes live; the
  clean backfill took 16.03 s against #167's 15.32 s on the same ledger, which is a fact about the
  afternoon and not about the design.
- **No concurrent shipper, no multi-actor fold, one filesystem (APFS), one project, one actor.**
  Unchanged from #167's own list.
- **The already-known `mergeRecords` / event-id dedup defect was not encountered**, by
  construction: this targets `events_n`, keyed `(project, actor_instance, n)`, never the event-id
  keyed table. Tracked separately.

## 10 · Reproduction

Throwaway: `~/rhizomorph-spikes/fold-worker-ordering/` (this note's evidence came from there; not
vendored into this repo, and nothing under `~/rhizomorph-spikes/` is committed).

```bash
mkdir -p ~/rhizomorph-spikes/fold-worker-ordering && cd ~/rhizomorph-spikes/fold-worker-ordering
# start from #167's throwaway rather than rebuilding — that is what makes this cheap
cp ~/rhizomorph-spikes/shipper-ack-journal/{server.mjs,shipper.mts,schema.sql,package.json} .
ln -sfn ~/rhizomorph-spikes/shipper-ack-journal/node_modules  node_modules
ln -sfn ~/rhizomorph-spikes/shipper-ack-journal/ledger.jsonl  ledger.jsonl   # the SAME ledger, or the counts stop being comparable
ln -sfn <a checkout of this repository>                       repo           # shipper.mts imports jsonl.js read-only through this

# server.mjs gains: the f1 window between COMMIT and writeFoldCursorSync, a
# drainSteps counter for RZ_FAULT_AFTER to count in, and RZ_CURSOR_BEFORE_COMMIT.
# shipper.mts gains: SHIP_DELAY_MS, and the import through ./repo.

psql -h 127.0.0.1 -p <pg-port> -d postgres -c "CREATE DATABASE rz_fold_f1;"      # and rz_fold_mut, rz_fold_closed, rz_fold_cursor
psql -h 127.0.0.1 -p <pg-port> -d rz_fold_f1 -f schema.sql

# the three sweeps, sequentially (run-all.sh does exactly this)
SHIP_DELAY_MS=60 RUN=f1-control WINDOW=f1     TRIALS=30 DB=rz_fold_f1     PORT=5701          ./sweep.sh
SHIP_DELAY_MS=60 RUN=f1-mutated WINDOW=f1     TRIALS=30 DB=rz_fold_mut    PORT=5703 MUTATE=1 ./sweep.sh
SHIP_DELAY_MS=60 RUN=closed     WINDOW=closed TRIALS=30 DB=rz_fold_closed PORT=5705          ./sweep.sh

./check.sh rz_fold_f1     run-f1-control
./check.sh rz_fold_mut    run-f1-mutated      # THIS ONE MUST FAIL — 15000 gaps, 30 runs of 500
./check.sh rz_fold_closed run-closed

./cursor-states.sh && ./cursor-states-2.sh    # the §6 ruling's five probes
node journal-dups.mjs run-closed/journal.ndjson
```

Three things #167 learned the hard way and this run still needs, plus one it did not:

- **`export` the port variables** — an unexported `SERVER_PORT` sends the backgrounded shipper to
  its hardcoded default and every trial "passes" against a server nothing POSTed to.
- **Clear the port with `lsof -ti tcp:$PORT | xargs kill -9` before every spawn**, never trust a
  tracked pid.
- **Reap the shipper with `pkill -9 -f shipper\.mts`**, never `kill -9 $!` — `tsx` forks a
  grandchild.
- **New: do not decide a spawn succeeded by checking it is still alive.** Wait for its bind banner.
  See mistake 1 — this is the difference between 30 trials and 15-for-3.

The counts, verified with the same SQL #167 used plus the one this issue turns on:

```sql
SELECT count(*), count(distinct n), min(n), max(n) FROM events_n;
-- gaps, asked against the SHIPPER'S OWN final cursor n, which is what makes a
-- missing row a lost *acked* batch rather than an unfinished ship:
SELECT count(*) FROM (SELECT g FROM generate_series(1,<shipper final n>) g EXCEPT SELECT n FROM events_n) x;
SELECT count(*) FROM (SELECT n FROM events_n GROUP BY n HAVING count(*) > 1) x;          -- duplicate rows,
-- which the PRIMARY KEY makes 0 unconditionally; kept only to match #167's query set. See §4.1.
WITH s AS (SELECT n, serial, lag(n) OVER (ORDER BY serial) prev FROM events_n)
SELECT count(*) FROM s WHERE prev IS NOT NULL AND n <= prev;                             -- inversions
-- the mutation's signature: one contiguous run of BATCH_LINES per targeted kill
WITH missing AS (SELECT g FROM generate_series(1,<shipper final n>) g EXCEPT SELECT n FROM events_n),
     grp AS (SELECT g, g - row_number() OVER (ORDER BY g) AS k FROM missing)
SELECT count(*) AS gap_runs, min(len), max(len), sum(len) FROM (SELECT count(*) len FROM grp GROUP BY k) x;
```

Drop `rz_fold_f1`, `rz_fold_mut`, `rz_fold_closed` and `rz_fold_cursor` when done.
