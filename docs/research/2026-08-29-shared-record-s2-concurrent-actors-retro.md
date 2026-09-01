# Retro — prd48 w2: two shippers writing at once lose and reorder nothing (#166)

Lane `166-concurrent-shippers`. Covers the full run: architect's plan, the
implementer's build and six runs, the reviewer's independent re-derivation,
this session's follow-up fixes to the four items review flagged but could not
itself verify or fix, and a second pass after PR review by the conductor
found two further issues (the outage's real cause, and two of the three
per-actor checks being structurally incapable of failing) — see items 3 and 6
below, added on that second pass. Verify (typecheck/lint/test) is green on
the final state — the diff is two new files (the note and this retro), so
nothing else could have regressed.

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
into one server lose or reorder anything. The answer is PASS, stated now to
the precision the evidence actually supports: this design is lossless (zero
gaps, all 48 chain digests close) under five deliberately adversarial
interleavings plus one real shared-box outage; per-actor ordering is
guaranteed by the design's construction (one shipper in flight at a time, one
FIFO drain loop) rather than demonstrated by these runs, and the one
actor-check that had any genuine path to fail an ordering assertion held.

It went well overall, but two things this note first got wrong both survived
past this session's own read and needed the conductor's PR review to catch:
a wrong cause named for the mid-run outage (attributed to sandbox process
supervision; actually a sibling lane's accidental kill), and a headline that
read 47 of 48 structurally-guaranteed non-failures as if they were 48
independent demonstrations. Both are corrected in this revision — see items 3
and 6 below. Set against that: the plan was precise enough that a real,
unanticipated finding (id collisions blocking the primary per-actor order
check on most of the real data) degraded gracefully into the plan's own
pre-authorized fallback instead of stalling the spike or getting smoothed
over; the one implementation bug the harness hit was caught by the harness's
own correctness check before any chaos row ran; and the note's habit of
reporting what wasn't clean, rather than hiding it, is exactly what made both
late-caught issues fixable instead of buried.

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

3. **An unscripted ~2–3 minute server outage mid-run, and a wrong first
   attribution for it.** The server process died with no trace in its own
   log. The note's first draft attributed this to sandbox process
   supervision reaping a bare `node server.mjs &`. That attribution was
   wrong, and PR review by the conductor caught it: the sibling lane for
   issue #167, sharing the same box, recorded in its own note killing a
   concurrent sibling lane's server process by accident during a broad
   `ps`/`lsof`-based cleanup, naming this exact port (5561) and this exact
   build area. The outage was a real shared-box collision between two
   sibling spikes, not an artefact of this harness's own process-launch
   style. It still directly explains two things that would otherwise have
   looked anomalous: `sustained-b`'s eight shippers all exiting with `code:
   null` instead of a clean exit, and `mixed-j`'s wall time running long
   against its expected baseline — that part of the analysis was right; only
   the cause named for it was not.

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

6. **Two of the note's three per-actor checks were headlined as demonstrated
   results when most of their coverage was actually guaranteed by the
   harness's own construction — the exact "test that cannot fail for the
   reason it claims" shape this repo names by name.** Caught by the
   conductor on PR review, not by the implementer, the first review pass, or
   this session's own read of the note. `events_n`'s primary key
   `(project, actor_instance, n)` with `ON CONFLICT ... DO NOTHING` makes
   `dup_count = 0` a database-constraint fact in every run, chaotic or not —
   not a result any chaos row could have failed. `shipper.mjs` awaits each
   POST before forming its next batch (one batch in flight per actor, ever)
   and `server.mjs` drains with a single FIFO loop, so per-actor
   `n`-vs-`serial` monotonicity is guaranteed by construction for any actor
   never killed mid-flight — of 48 actor-checks, exactly one (actor-5, row
   `kill-i`) ever had a genuine path to an inversion. The headline read "zero
   duplicates, zero reorders... across every one of 48 actor-checks" as if
   all 48 were independent demonstrations, when 47 of the 48 reorder checks,
   and all 48 dup checks, could only ever have reported zero. The gap check
   and the chain-digest closure were the two checks actually doing
   run-dependent work, and they were correctly reported as such — the defect
   was in what the surrounding prose implied about the other two, not in the
   SQL or the numbers themselves.

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
- **(3)** is environmental — a real collision between two sibling lanes'
  spikes sharing one box, not a flaw in the code under test. The wrong
  *first* attribution (sandbox process supervision) was a reasoning gap: the
  actual evidence available at the time (no error trace, a bare `&`-launched
  process, timing consistent with a shell exit) was also consistent with an
  external kill, and nothing in the note's first draft checked for one
  before naming a cause. The correct root cause only became checkable once a
  second document — the sibling #167 lane's own note — existed to compare
  against; this lane could not have ruled it out unilaterally at the time it
  wrote the note, since the two lanes' spikes ran concurrently and neither
  had visibility into the other's actions as they happened.
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
- **(6)** is a gap in what "verify the numbers" covered. Both the reviewer's
  independent re-derivation and this session's own read confirmed every
  number in the note was real and reproducible — and stopped there. Neither
  asked the structurally different question "given this schema and this
  drain-loop design, could this check have returned anything else?" That
  question requires reading the harness's own source for what it structurally
  permits, not just re-running its queries against what it happened to
  produce — a check that cannot fail is not caught by checking that its
  output is accurate, only by asking whether its output could ever have been
  different.

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
- **Honest reporting of what wasn't clean, even though the first cause named
  for it was wrong.** The unscripted outage and the non-clean `sustained-b`
  shipper exits were reported plainly rather than hidden or folded into the
  falsifier table as if they had been designed chaos rows — that instinct
  was right, and it is what made the wrong attribution fixable at review
  (fully described, so a reader with more information — the sibling #167
  lane's own note — could correct it) rather than buried where nobody would
  think to check it.
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

3. **Before naming a cause for an anomaly on a shared box, check whether a
   concurrent sibling lane could be the cause, not only the harness's own
   process-launch style.** Item 3's wrong first attribution would have been
   caught earlier by a habit as cheap as `ps`/`lsof` on the claimed port
   before writing the "sandbox artefact" sentence, or by explicitly noting
   in the note that the cause was unconfirmed pending what sibling lanes
   report. The actual fix here cost nothing but a later correction; the
   leverage is in not shipping a wrong causal claim as EXECUTED-confidence
   prose in the first place. Worth one line in a future spike-harness
   checklist: "an anomaly on a shared box gets a hedge until a concurrent
   sibling lane's own note is checked or ruled out, not a confident cause."

4. **Ask "could this check return anything else?" for every per-actor
   assertion before calling it a demonstrated result**, not only "does this
   check's output match what the harness produced." Recommendation 1's
   persistence checklist and this one are the same shape: both are about
   what a spike-planning template should ask for up front so review is
   checking claims against a stated design intent, rather than discovering
   after the fact that a check was decorative. **Artifact: repo doc.** Same
   file as Recommendation 1, `docs/research/2026-08-24-shared-record-spike-plan.md`
   — add alongside the persistence checklist item: "for each per-actor or
   per-row check in the verification plan, state whether the harness's own
   design lets it fail at all, and for which cases; a check with no failure
   path is reported as a construction guarantee, not a demonstrated result."

## Highest-Leverage Next Step

Add both the persistence checklist item (Recommendation 1) and the
failure-path checklist item (Recommendation 4) to
`docs/research/2026-08-24-shared-record-spike-plan.md`, the architect's
spike-planning doc that future prd-48 S-series waves are planned from — they
are the same shape of fix (state up front what a check can and cannot show,
rather than discovering the gap at review) and belong together in one pass
over that doc: any number sourced from a live endpoint or ambient shell state
during a run must be polled on an interval and written to a results file, not
only observed live; and for each per-actor or per-row check in the
verification plan, state whether the harness's own design lets it fail at
all. Both gaps reached a committed PR before being caught (one by review, one
by the conductor at PR review, one full round later) in an otherwise
fully re-derivable note, and with several more S-series spikes still ahead in
this PRD, both are the kind of gap most likely to recur unless the plan
template says so up front.
