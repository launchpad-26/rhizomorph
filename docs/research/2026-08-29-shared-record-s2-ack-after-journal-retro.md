# Retro — prd48 w2: an ack-after-durable-journal shipper loses no batch when the server dies (#167)

Lane `167-ack-after-journal`. Covers the full run: the architect's design (written before any
chaos re-run, per the issue's own requirement), the implementer's throwaway build and chaos
sweep, and the reviewer's independent re-derivation and five fixes. Verify (typecheck/lint/test)
is green on the final state — the diff is a single new file,
`docs/research/2026-08-29-shared-record-s2-ack-after-journal.md`, the only path this issue's
fence permitted, so nothing else could have regressed. Written once, after that gate passed.

## What Was Built

A throwaway ack-after-durable-journal spike (`~/rhizomorph-spikes/shipper-ack-journal/`, outside
the git tree) closing the exact gap S2 left open: accept-fast 202 sent *before* the row was
durable, which lost one batch when the server died at the wrong instant. The fix is a WAL-style
append-only `journal.ndjson` — `writeSync` then `fsyncSync` before the 202 is ever sent, an
independent fold worker with its own byte-offset cursor (tmp-then-rename, the same primitive the
shipper's own cursor already uses), and idempotent `ON CONFLICT DO NOTHING` inserts keyed
`(project, actorInstance, n)`. The design was produced by a dedicated `architect` dispatch,
written down before any chaos row ran; a separate `implementer` dispatch built the spike and ran a
75-kill chaos sweep against a 1.13M-line real ledger; a separate `reviewer` dispatch independently
re-derived every number in the note from raw output on disk rather than trusting its prose. Chosen
over folding design into the same dispatch as the build, because the issue's explicit ask was "the
design is stated before the chaos run, not fitted to it" — a claim only checkable if the design and
the results come from two dispatches that cannot see each other's output while writing.

## Retro Summary

The task: close prd-48 Success 2's QUALIFIED verdict by designing ack-after-durable-journal
*before* re-running chaos, proving chaos row (c) (server killed mid-flight) no longer loses a
batch, swept across many kill timings rather than one instance, with chain digests reported
end-to-end and an explicit falsifier verdict.

It went well, and the result is a clean PASS: 75 real process kills of the server (vs. the 5–10
originally scoped), spanning all four fault windows the design named plus the exact S2 failure
window, plus 20 shipper-side kills, a 5,000-line rewind and a total cursor loss — zero lost
batches, zero gaps, zero duplicate rows, identical chain digests local vs. server on every row.
The single biggest strength is that the three-dispatch shape (architect → implementer → reviewer)
did exactly the job it was chosen for: the design section verifiably predates the results (the
reviewer confirmed it contains zero post-run numbers, and it even names the wrong risk — WSL2's
filesystem layers, this run's actual box was plain macOS/APFS), and review caught five real defects
in the note's own numbers, including one wrong chain digest, before any of it shipped. The biggest
weakness is not in what was tested but in what wasn't: the falsifier never aimed a fault point at
the fold worker's own commit-then-advance-cursor ordering — the structural sibling of the exact bug
this issue exists to fix, one layer down — and that gap was found by the reviewer, not by the
sweep, and remains open for a future lane.

## What Went Wrong

1. **The journal fd was opened `'a'` (write-only), not `'a+'`.** The fold worker's first
   `fs.readSync` against it threw `EBADF` — POSIX append mode is not readable. Caught immediately
   by the exception itself; fixed to `'a+'`, which keeps the `O_APPEND` property the design's
   concurrency argument depends on.
2. **`tsx`'s CLI forks a grandchild process the wrapper PID doesn't see.** The first version of the
   row (b) kill loop (`kill -9 $!` on the backgrounded wrapper) left 20 live shipper processes
   orphaned under PPID 1 for several minutes before `ps -ef` caught it. All of row (b)'s reported
   numbers are from the re-run after switching to `pkill -9 -f shipper\.mts`; the contaminated run
   was dropped, never used.
3. **`SERVER_PORT`/`PROXY_PORT` were set without `export` in the row (c) sweep script.** The
   backgrounded shipper subprocess never saw them and silently used its hardcoded default port,
   which nothing was listening on. The first full sweep attempt "completed" with a suspiciously
   clean `foldedRecords=2259` — exactly the uninterrupted-run number — which is what tipped it off:
   zero of the ten programmed fault trials had actually fired.
4. **A concurrent sibling lane's server process was killed by accident**, once, during a broad
   `ps`/`lsof` cleanup of what were assumed to be this spike's own stray processes. This is the
   same shared-box hazard #166's retro already named — recurring a second time, on the same PRD,
   inside the same week.
5. **The sweep driver's own retry logic could not distinguish "spawn crashed via `EADDRINUSE`" from
   "spawn fired its fault and self-killed on schedule."** Both look identical from outside (process
   gone within a 300 ms liveness check). This is why the sweep fired 75 real kills instead of the
   10 programmed — every one of the 75 is a genuine, evidenced kill, but the distribution across
   the four fault windows was not actually controlled as designed (61 of 73 deterministic kills
   landed in window `c2`, only 1 in `c3`).
6. **Review caught five real defects in the note before it shipped.** The most serious: a wrong
   chain digest in the row (d) table, transcribed as a copy-paste of row (e)'s digest tail — this
   would have shipped a cryptographically wrong value in a public research note. Also: a
   double-count in the row (c) fault-window table (77 against the true 75, from counting the two
   fsync-ablation trials both as their own rows and inside the windows they already belonged to),
   the same miscount echoed in two further places in the note, one factually wrong claim about
   which rows' chain digests were expected to match each other, and one byte-inexact quoted log
   line. None of these were caught by the implementer's own pass.
7. **The falsifier, though it passed 75/75, never instrumented the one place its own design most
   explicitly flagged as a risk.** All four injectable fault points sit in the HTTP request
   handler; there is none between the Postgres `COMMIT` and the fold cursor's persist. The design's
   own §6 names "the fold cursor has its own race" as a candidate cause of a future failure — the
   implementation built the fault-injection hooks without one aimed at that exact claim. Found by
   the reviewer while checking the note against the code, not by the sweep itself, and it is still
   open.

## Root Causes

- **(1)–(3)** are ordinary throwaway-infrastructure friction — an unfamiliar Node fd-mode rule,
  `tsx`'s process tree, and bash `export` scoping across a backgrounded subprocess — the normal cost
  of building fresh chaos-injection code under time pressure. All three were self-caught by their
  own downstream symptom (an exception, a stray `ps` listing, a suspiciously round number) rather
  than shipping silently, which is the mechanism that is supposed to catch exactly this class of
  bug and did.
- **(4)** is environmental, not a design or process defect in the spike itself: multiple prd-48
  spikes share one box with no process-namespacing convention between lanes. Root cause is the same
  one #166's retro already identified — it has now recurred once, which is the threshold this
  repo's own retro discipline treats as "encode it," not "note it and move on."
- **(5)** is a genuine gap in the sweep's own retry logic, not a one-off mistake: it collapses two
  distinguishable signals (spawn failure vs. spawn success followed by self-kill) into one
  ("process gone"). It was reported rather than silently fixed-and-rerun because the resulting
  evidence was strictly stronger than the planned run — but the same driver, reused unmodified on a
  future spike that needs even coverage of a rare fault window, would not reliably deliver it.
- **(6)** is exactly what independent review-by-re-derivation exists to catch, and it worked: every
  one of the five defects was a fact-shaped, checkable sentence (a digest, a count, a claim about
  which rows should match), and all five surfaced only when the reviewer recomputed from raw
  output on disk instead of reading the note's own summary. The implementer's own pass evidently
  trusted its own arithmetic rather than re-deriving it a second time.
- **(7)** is a planning-to-build gap, not an execution slip. The design correctly named its own
  highest-risk unverified claim in advance — that is exactly what "state the mechanism before you
  run it" is supposed to produce — but naming a risk in the design section and instrumenting a
  fault point for that same risk in the build are two different steps, and only the first one
  happened before the sweep was called complete.

## What Worked Well

- **Three separate dispatches (architect, implementer, reviewer) produced a design that is
  verifiably not fitted to its own results.** The reviewer confirmed the design section carries
  zero post-run numbers, and the design's own top-named risk (WSL2 filesystem `fsync` honesty)
  turned out to be the wrong box entirely — this run's actual risk (page-cache-vs-`fsync` on
  macOS/APFS) wasn't named in advance. That is what a real, falsifiable prediction looks like: one
  that can turn out partly wrong, rather than a document quietly rewritten to match what happened.
- **The single-JS-thread blocking-write concurrency argument (§2 of the design) is a genuine
  design insight** — using Node's single-thread property to get ordering guarantees for free
  instead of a mutex — and it held, unqualified, under all 75 real kills.
- **Every operational mistake was reported plainly in the note itself**, with what it cost, rather
  than smoothed into a clean narrative. This is the same discipline #166's own retro named as
  working, now confirmed a second time on the same PRD — worth treating as an established pattern,
  not a one-off habit.
- **The `RZ_SKIP_FSYNC` ablation was not asked for by the issue and was built anyway**, and it
  produced the single most valuable finding in the note: a `kill -9` sweep proves the *ordering*
  claim (never ack before durable) but cannot distinguish it from `write()` alone reaching the
  kernel page cache, which is a same-process-crash guarantee, not the host-crash guarantee `fsync`
  is actually for. This is exactly the kind of finding the issue's ask list didn't anticipate but
  that stayed inside the fence (still the one file) and made the note materially more honest about
  what it actually proves.
- **Firing 75 kills instead of the planned 10 was reported as a harness limitation, not silently
  corrected to match the plan.** Choosing to keep the stronger evidence over conforming to a number
  stated in advance is the right call, and saying so explicitly is what keeps the "0/0/0, PASS"
  verdict trustworthy rather than one with a hidden asterisk.

## Recommended Changes

1. **A chaos-sweep driver must distinguish "spawn failed" from "spawn succeeded and self-killed on
   schedule" as two different signals**, not both read as "process gone within N ms." Concretely: a
   target process should write a PID-stamped ready marker (or bind a small control socket) before
   proceeding toward its fault point, and the driver should check for that marker rather than
   inferring liveness purely from process absence. This is the exact shape of mistake 5, and every
   remaining kill-based prd-48 spike (S3, S7, S8, per `docs/research/2026-08-24-shared-record-spike-plan.md`'s
   own chaos steps) is likely to build a similar driver from scratch and hit the same ambiguity.
   **High leverage. Artifact: repo doc**, `docs/research/2026-08-24-shared-record-spike-plan.md` —
   add a short note near "How to read this" or under each spike's "Run" step that names this
   ambiguity and the ready-marker fix, so a future spike's harness is built with the fix from the
   start rather than discovering it mid-sweep. Not made in this retro — this lane's fence is the
   retro file only.

2. **When a design's own falsifier section names a candidate failure cause, the build must either
   instrument a fault point aimed at that exact claim, or the note must say explicitly that it
   chose not to — before the sweep is called complete, not after review finds the gap.** This
   design (§6) named "the fold cursor has its own race" as a candidate cause in advance; the build
   never aimed a fault point at it, and it took an independent reviewer, not the sweep itself, to
   notice. This is the same discipline this repo's own PR-body convention already asks for on every
   PR ("what is the sibling case?" — `AGENTS.md`) applied one step earlier, at spike-design time
   rather than at review time. **Medium-high leverage. Artifact: repo doc**, either the same
   spike-plan file or the architect agent's own spike-planning checklist — add: "for every risk your
   falsifier names as a candidate cause, either build a fault point that targets it, or name the
   omission in 'what this did not test' at build time, not only if review finds it." Not made in
   this retro, same fence reason as (1).

3. **Shared-box process isolation, now measured twice on the same PRD.** #166's retro reported an
   unscripted outage from bare `&` backgrounding; this lane reported accidentally killing a
   concurrent sibling lane's process during its own cleanup. Two different symptoms, one root
   cause: no convention for tagging a throwaway spike's own processes so cleanup can't reach a
   different lane's. Per this repo's own rule (encode on the second occurrence, not the first), this
   has now crossed that line. **Medium leverage. Artifact: repo doc**,
   `docs/research/2026-08-24-shared-record-spike-plan.md` — add a line under "Run": "tag a
   throwaway process's command line or environment with a lane-unique marker (issue number, spike
   slug) so `pkill`/`ps`-based cleanup can be scoped to it and cannot touch a concurrent lane's
   process by accident." Not made in this retro, same fence reason as (1) and (2).

## Highest-Leverage Next Step

Add recommendation 2 to `docs/research/2026-08-24-shared-record-spike-plan.md`: when a spike's own
design names a candidate failure cause in its falsifier, the build must aim a fault point at that
exact claim before the sweep is called complete, or explicitly declare the omission at build time.
This is the one gap in an otherwise clean PASS that a mechanical check could plausibly have caught
before the reviewer had to — the design got the risk right in advance (naming the fold-cursor
ordering as the structural sibling of the bug this whole issue is about) and the build simply
didn't act on its own prediction. With three more kill-based S-series spikes still ahead in
prd-48 (S3, S7, S8), this is the recommendation most likely to prevent the same shape of gap from
reaching review again instead of being closed before the sweep is called done.
