# Retro — prd48 w2: two shippers writing at once lose and reorder nothing (#166)

Lane `166-concurrent-shippers`. Covers the full run: architect's plan, the
implementer's build and six runs, the reviewer's independent re-derivation, and
this session's follow-up fixes to the four items review flagged but could not
itself verify or fix. Verify (typecheck/lint/test) is green on the final state
— the diff is a single new file,
`docs/research/2026-08-29-shared-record-s2-concurrent-actors.md`, so nothing
else could have regressed. Written once, after that gate passed.

## What Was Built

A throwaway N=8 concurrent-shipper harness (`~/rhizomorph-spikes/concurrent-actors/`,
outside the git tree) extending S2's single-shipper design — one HTTP server,
one in-process JS-array queue, one drain loop issuing `INSERT ... ON CONFLICT DO
NOTHING` — to eight producer OS processes shipping into it at once. Three
correctness checks per actor per run (raw SQL dup/inversion/gap on `events_n`,
a `mergeRecords`-based per-actor order check where the data made it safe, and
`verifyRecord` chain-digest closure against the unmodified `record/` module),
run across six variants (a cold concurrent backfill, a 10-minute sustained
live-tail, and four further chaos rows: staggered start, one throttled actor,
kill-mid-flight, mixed backfill+live-tail). The one deliverable is the research
note itself; the harness was reused from S2 rather than redesigned, which is
why the diff this issue produced is documentation, not code.

## Retro Summary

The task: settle, for prd-48's build PRD, whether N concurrent shippers writing
into one server lose or reorder anything. The answer is PASS — zero
duplicates, zero reorders, zero gaps across 902,640 rows and 48 actor-checks,
under five deliberately adversarial interleavings plus one unscripted one.

It went well. The plan was precise enough that a real, unanticipated finding
(id collisions blocking the primary per-actor order check on most of the real
data) degraded gracefully into the plan's own pre-authorized fallback instead
of stalling the spike or getting smoothed over. The one implementation bug the
harness hit was caught by the harness's own correctness check before any chaos
row ran. The one real weakness — two numbers in the note that turned out to be
unverifiable after the fact — was caught by review, not shipped silently, and
was fixed by explicit caveat rather than either invented precision or deletion.

## What Went Wrong

1. **A real bug in the spike's own shipper**, not the design under test: cursor
   arithmetic mixed UTF-16 `string.length` (from `chunk.toString('utf8')`) with
   the byte offset `fs.readSync` actually needs, so a file containing any
   multi-byte UTF-8 character silently desynced the cursor from real line
   boundaries. First smoke run shipped 25,005 rows for a 25,000-line file. Cost
   a full smoke-test cycle before any of the six real runs could start.

2. **The plan's primary per-actor order check (`mergeRecords`-based) was
   blocked on 6 of 8 real actors and every real-ledger cross-actor pairing.**
   The plan anticipated S2's already-known finding (an actor's own event ids
   can repeat within its own log). It did not anticipate the new form this
   spike surfaced: ids collide heavily *across* actors too — 68–100% pairwise
   overlap across all 28 pairs checked, even between two actors that are each
   internally unique. `mergeRecords` itself is not the defect (its dedup key is
   `actor.instance + event.id`, correctly namespaced); the defect is that
   nothing in `interleave()`'s output (`RhizomorphEvent[]`, no per-event actor
   tag) lets an external verifier reconstruct attribution from a merged stream
   by id alone. This is a real, load-bearing scope finding for prd-48, not a
   spike-harness problem.

3. **An unscripted ~2–3 minute server outage mid-run** — the server process
   died with no trace in its own log, consistent with a bare `node server.mjs
   &` inside one shell invocation being reaped when that shell invocation
   exited. Not a defect in the server or shipper code, but it directly explains
   two things that would otherwise have looked anomalous: `sustained-b`'s
   eight shippers all exiting with `code: null` instead of a clean exit, and
   `mixed-j`'s wall time running long against its expected baseline.

4. **Two numbers in the note were observed only live, never persisted, and
   were unverifiable by review time.** `queueDepth`/`queueDepthPeak` were read
   from the `/stats` endpoint during the `kill-i` run and the continuous
   loadavg range was read from ambient shell state — neither was polled on an
   interval and written to a results file the way every other number in the
   note was (SQL query, `results/*.crown.log`, `results/*.verify.json`).
   Review could not re-derive either from disk. Both were downgraded to an
   explicit "observed live, not persisted, not re-derivable from disk" caveat
   rather than left reading as EXECUTED-grade, and the loadavg range in the
   header was narrowed to only the two triples actually recorded rather than
   implying a continuous trace.

5. **Review found four smaller precision-of-claim errors**, all fixed directly
   rather than left as unresolved comments: a chain digest transcribed wrong
   from the raw output, a headline row-count that was off by one against the
   falsifier table, a reproduction recipe whose `ls -S` file ordering would not
   reproduce the documented actor→file assignment (aggregates would still
   match; the specific quoted digests would not), and one broken example
   command. None of these were caught by the implementer's own pass — they
   surfaced only when review independently re-derived the numbers from the raw
   harness output on disk instead of trusting the note's own summary.

## Root Causes

- **(1)** is a genuine defect in throwaway code, caught by exactly the
  mechanism meant to catch it (the harness's own line-count correctness check,
  run before any chaos row). No process gap — this is what a smoke test is
  for, and it worked.
- **(2)** is a limitation of extending a single-actor precedent (S2) to N
  actors: S2 could only ever observe within-actor id collision, because it had
  one actor. The plan reasoned from S2's finding correctly but didn't ask
  whether that finding had a structurally adjacent N-actor form. It survived
  contact with reality only because the plan had pre-authorized a fallback for
  "if it bites" in general terms, not because the specific cross-actor shape
  was foreseen.
- **(3)** is environmental — this sandbox's process-supervision behavior
  reaping a background job started with a bare `&`, not a flaw in the
  code under test. Root cause is the harness's own process-launch style for a
  process meant to outlive the invoking shell command.
- **(4)** is the one real process gap here. The harness had a durable
  persistence path for anything derived from a SQL query or a file artifact,
  and no equivalent path for anything observed only through a live HTTP
  endpoint or ambient shell state during a run. Nothing polled `/stats` or
  `loadavg` on an interval and appended it to a results file, so the moment
  the relevant process moment passed, the only record left was memory /
  terminal scrollback — which review correctly refused to treat as EXECUTED
  evidence.
- **(5)** is exactly what commit-by-commit review with independent
  re-derivation from raw output (rather than trusting the note's own summary)
  exists to catch. Transcription and off-by-one errors are a normal cost of
  hand-copying numbers from a live run into prose; they went undetected until
  a second, independent computation caught them.

## What Worked Well

- **The plan's pre-authorized fallback.** "If it bites: cite S2's finding, do
  not re-diagnose or fix it — report the raw per-actor `events_n` order check
  as load-bearing instead for that actor" meant that when a real and larger
  version of the anticipated problem hit (6/8 actors, not a hypothetical
  edge), the implementer had a documented, in-scope path to take rather than
  stalling or improvising a workaround under time pressure.
- **The harness's own correctness check caught its own bug early.** The
  UTF-8/UTF-16 cursor bug was caught by a line-count check on the very first
  smoke run, before any of the six real runs — the expensive failure mode
  (discovering a systemic cursor bug after 902,640 rows had already been
  collected on top of it) never happened.
- **Honest reporting of what wasn't clean.** The unscripted outage and the
  non-clean `sustained-b` shipper exits were reported plainly, attributed to
  the sandbox rather than the design, and explicitly kept out of the falsifier
  table rather than folded in as if they had been designed chaos rows. This is
  what keeps the "0/0/0 dup/inversion/gap, PASS" verdict trustworthy — it is an
  honest zero, not one with a hidden asterisk.
- **Independent re-derivation at review**, from raw output on disk rather than
  the note's own summary, caught real, if small, errors that a read-through
  would have missed — the wrong digest and the off-by-one count in particular
  would otherwise have shipped as false EXECUTED claims.

## Recommended Changes

1. **Persist transient runtime observations to a results file on an interval,
   not just to a live endpoint or memory.** The two numbers that ended up
   unverifiable in this note (`queueDepth`/`queueDepthPeak`, the continuous
   loadavg range) are the only two in the whole note that don't trace to a SQL
   query or a file under `results/`. High leverage, cheap to state: add a line
   to the architect's spike-planning template so future S-series waves under
   prd-48 (there are several more) build this in from the start rather than
   discovering the gap at review. **Artifact: repo doc.** File:
   `docs/research/2026-08-24-shared-record-spike-plan.md` — add a checklist
   item, something like: "any number sourced from a live endpoint or ambient
   shell state (queue depth, loadavg, process stats) during a run must be
   polled on an interval and appended to a results file; a number that exists
   only in memory or terminal scrollback cannot be re-verified at review time
   and must be reported as such, not as EXECUTED." (Not made in this retro —
   this lane's fence is the retro file only.)

2. **When extending a single-actor precedent to N actors, explicitly ask
   whether a known single-actor defect has an N-actor analogue, not only
   whether it recurs individually.** This is what would have let the plan
   anticipate cross-actor id collision rather than only within-actor
   collision. Optional/lower leverage than (1) — it is a planning habit more
   than a mechanical check — but cheap enough to add as one line to whatever
   guidance the architect agent uses when planning a spike that extends an
   existing single-actor precedent doc.

3. **Launch a throwaway harness's long-running process with `nohup ... &` or a
   process manager, not a bare `&` inside one shell invocation**, when the
   process needs to outlive the invoking command (here, a 10-minute sustained
   run). This would plausibly have prevented the unscripted outage. Low
   leverage on its own — the harness is throwaway and outside the repo, so
   there is no repo file this changes today — worth carrying into a future
   spike-harness checklist if one gets written, not worth a standalone doc for
   this alone.

## Highest-Leverage Next Step

Add the persistence checklist item from Recommendation 1 to
`docs/research/2026-08-24-shared-record-spike-plan.md`, the architect's
spike-planning doc that future prd-48 S-series waves are planned from: any
number sourced from a live endpoint or ambient shell state during a run must
be polled on an interval and written to a results file, not only observed
live. This is the one gap in an otherwise fully re-derivable, EXECUTED-labeled
note, and with several more S-series spikes still ahead in this PRD, it is the
one most likely to recur unless the plan template says so up front.
