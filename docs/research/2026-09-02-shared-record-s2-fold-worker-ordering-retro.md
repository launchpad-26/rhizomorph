# Retro — prd48 w4: a crash between the fold worker's commit and its cursor is a tested case, not an assumed one (#205)

Lane `205-fold-worker-ordering`. Covers the whole run: the implementer's build on top of #167's
throwaway, three 30-trial sweeps plus five hand-written cursor-state probes, a session interruption
between the last sweep and the write-up, and the reviewer's independent re-derivation and two
fixes. Verify (typecheck / lint / test) is green on the final state, confirmed twice — once by the
implementer and once independently by the reviewer. The diff is two new files (the note and this
retro), so nothing else could have regressed. Written once, after that gate passed.

**Gear 3, no shift.** One new file inside the declared fence, plus this retro under a widening
recorded on the issue before the change. No migration, no new exported symbol, nothing on
`security-auditor`'s path list. The negative fence (#204's `packages/core/src/record/merge*.ts`
and `docs/record-format.md`, #172's S7 note) held and was reported as held.

## What Was Built

A throwaway chaos harness at `~/rhizomorph-spikes/fold-worker-ordering/` (outside the git tree),
**copied from #167's rather than rebuilt**, extending its `RZ_FAULT_POINT` grammar with a fifth
window `f1` between the Postgres `COMMIT` and `writeFoldCursorSync`. The load-bearing design choice
is that the mutation is **one environment variable on the ordering, not a second fault point**:
`RZ_CURSOR_BEFORE_COMMIT=1` moves the cursor persist to the other side of the commit while `f1`
stays textually between the pair, so the A/B is same driver, same schedule, same ledger, same
schema, one variable. Chosen over a second injection site because a second site would have made the
control and the mutant two different experiments, and the whole value of the mutation is that it is
the *same* experiment with the ordering flipped. The one committed artefact is the research note;
the harness is not vendored.

## Retro Summary

The task: close the gap #167's own review named — its four fault windows all sit in the HTTP request
handler, and none aimed at the fold worker's structurally identical commit→cursor ordering one layer
down. Fire a fault point there enough times to mean something, prove by mutation that the check can
fail for the reason it claims, re-sweep #167's thinnest window (`closed`, n=1 at full design), and
rule on the fold cursor's missing `fsync`.

It went well, and the result is stronger than the issue asked for. Per window, never as a total:
`f1` correct ordering **30 trials, 0 gaps**; `f1` reversed **30 trials, 15,000 lost rows in 30
contiguous runs of exactly 500** — batch size is 500, so the unit of loss is exactly the unit of
ack; `closed` at full design with fsync on **30 trials, 0 gaps**, taking #167's n=1 to n=30. The
falsifier did **not** fire — no `f1` crash under the shipped ordering stranded an acked batch — but
its second half landed anyway: a fully fsynced journal still lost 15,000 acked rows under the
mutation, so ack-after-durable-journal is under-specified as a *written build contract*. prd-48's
criterion 2 names the handler and is silent about the fold worker. That was flagged as a
recommendation and not acted on, because the PRD is outside the fence.

The single biggest strength is the mutation, and specifically that it survived an independent
reconstruction: after the databases were dropped, the reviewer rebuilt the lost set from
`run-f1-mutated/journal.ndjson` and `server.log` alone and matched the note's table exactly,
including the decisive cross-check that for 30 of 30 faults the next instance's resume offset equals
the lost record's *end* — the reversed ordering's signature and nothing else's. The biggest weakness
is that this run rediscovered, at its own cost, a harness bug that #167's retro had already
diagnosed and prescribed the exact fix for, because that recommendation was deferred out of fence and
nobody ever landed it.

## What Went Wrong

1. **The inherited spawn detector fired 15 kills for 3 programmed trials.** #167's `start_server`
   decides a spawn succeeded by checking the pid is alive at 300 ms, so it cannot distinguish
   `EADDRINUSE` from "bound, drained a backlog, fired `f1`, self-killed fast". The first mutated
   smoke run therefore fired five times the schedule. Fixed by deciding on evidence rather than
   liveness — the server prints one `server on <port>` banner from inside its `listen` callback and
   an `EADDRINUSE` crash prints none, so the driver waits for the banner count to rise. Cost: one
   smoke cycle plus a dropped database. **This was survivable for #167's claim ("nothing lost across
   all of them") and fatal for this issue's, which is a per-window count.**

2. **A check that could not fail was cited as evidence, in a note whose entire subject is the
   opposite.** §4.1 offered `duplicate n: 0` as proof that the re-fold cost nothing — but
   `schema.sql` declares `PRIMARY KEY (project_id, actor_instance, n)` and every run uses one project
   and one actor instance, so that query returns 0 whatever the fold worker does. Caught by the
   reviewer and proved by mutation, not argument: the schema was rebuilt in a scratch database and a
   duplicate insert attempted, which `events_n_pkey` rejected while the query still returned 0. The
   *mechanism* claim was right; the evidence was the wrong one, and it was replaced with the
   resume-offset evidence available in the same log. This is the repo's named second-worst defect
   shape — a test that cannot fail for the reason it claims — appearing one section above a mutation
   built specifically to prove the check that mattered *could*.

3. **The note understated its own coverage.** §9 claimed the multi-record drain step was never
   faulted under a live shipper. Its own logs said otherwise: 2 of the 30 faulting instances in
   `run-f1-control` had drained 9 and 27 records across multiple steps before being killed, both
   recovering clean. Caught by the reviewer; corrected to claim the coverage that exists and to
   narrow the residual gap to the killed step's own size — which is unrecoverable precisely because
   the whole point of the window is that its cursor never persisted.

4. **The implementer's session was killed after all three sweeps had completed but before the note
   was written**, leaving four stray `server.mjs` processes and a `shipper.mts` pair alive and the
   harness with no write-up. Recovered by resuming from the transcript rather than restarting; no
   work was lost and no sweep was re-run. Whether the strays polluted the counts was **checked rather
   than assumed**: no file in any run directory has an mtime after its own `=== DONE ===`.

5. **A leftover smoke-test server was still listening on port 5701 when run 1 started**, so run 1
   reports 31 untargeted port-clear kills against runs 2 and 3's 30. It wrote to its own since-dropped
   database and its own journal path and could not have touched run 1's data — but it perturbed a
   count the note reports, so it is stated rather than rounded away. Reusing a port a smoke run had
   used was the actual error; runs 2 and 3 took fresh ports and got exactly the 30 the schedule
   predicts.

6. **Two of the first cursor-state probes did not test the state they were named for.** The garbage
   probe and the delete probe both logged `<absent>`, because the echo pipeline could not render 64
   random bytes — so a passing probe proved nothing about the state under test. And probe 1 set
   offset 0, which is the maximal rewind and identical in effect to a cold start, so it never
   exercised a *partial* one. Self-caught by the implementer and re-run with a byte count and a
   hexdump as evidence, plus a real partial-rewind probe at a derived record boundary; the weak
   originals are not in the note's table.

7. **Of gear 3's three additional seats, only this one ran.** No `architect` was dispatched — the
   plan already existed as #167's rerun recipe plus the issue's own Definition of done, which is a
   defensible call and probably the right one. No `docs-syncer` ran either; nothing shipped falsified
   a doc, and the one documentation change the run implies (prd-48 criterion 2) was correctly flagged
   rather than made. But **neither absence was declared anywhere until this retro**, and a deliberate
   skip and a silent omission look identical afterwards.

8. **The repo's own personal-paths guard is blind to the kind of file this run produced.**
   `packages/server/src/no-personal-paths-law.test.ts` reads `git ls-files`, so it cannot see an
   untracked file. This lane's entire diff was untracked until commit, so a green pre-commit suite
   was **not** evidence that the note carried no personal paths; only a staged run is. Found by the
   reviewer, who checked the note by hand instead. Out of fence (`packages/server/`), so deliberately
   not fixed here.

## Root Causes

- **(1) is not a fresh mistake; it is an unlanded recommendation.** #167's retro named this exact
  ambiguity as its mistake 5, prescribed the exact fix (a ready marker rather than a liveness check),
  named the artefact — `docs/research/2026-08-24-shared-record-spike-plan.md` — and then closed with
  *"Not made in this retro — this lane's fence is the retro file only."* #166's retro deferred four
  recommendations into the same file with the same sentence. That file has **one commit in its
  history**, `1352ee8`, from before either retro was written. Three consecutive retros wrote
  recommendations that no issue owned, so none of them reached the next lane, and the next lane paid
  for one of them in full. The deeper cause is structural: **a retro recommendation that names an
  artefact outside the lane's fence has no mechanism behind it.** It is a paragraph, and paragraphs
  in `docs/research/` are read by people looking for findings, not by the next harness author.

- **(2) is the third occurrence of one shape on this PRD**, after #166's item 6 (47 of 48 per-actor
  checks structurally incapable of failing) and #167's review pass. The interesting part is not that
  it recurred but *where*: the same author, in the same document, built §4.2's mutation precisely
  because "what mutation would this test survive?" is the question this repo asks — and then let a
  decorative check stand one section earlier. So the cause is not ignorance of the rule. It is that
  the rule was applied to the check the run was *about* and not swept across the other three queries
  inherited from #167's set. A query copied from a prior note arrives with borrowed credibility;
  nothing in the run asked whether it could still fail *under this schema*.

- **(3) has a cause worth naming separately: "what this did not test" was written from the plan's
  intent rather than from the run's logs.** Pacing was expected to make every faulted drain step a
  single record, so the section said the multi-record case was untested — a claim about the design,
  not a reading of `drainSteps` against the next instance's resumed offset. Understating coverage is
  the safer direction to be wrong in, and it is still an inaccurate claim, and it hid real evidence
  the run had already paid for.

- **(4) and (5) are harness-lifetime and environment, not defects in the work.** The interruption
  cost almost nothing *because the harness's own conventions made the damage question checkable*:
  per-run directories, a `=== DONE ===` marker per run, distinctly-prefixed databases and a port per
  run. Had the runs shared one directory or one database, "did the strays pollute the counts?" would
  have been a judgement call instead of a one-line mtime comparison. The residual hazard is that the
  processes are named `server.mjs` and `shipper.mts` — generic enough that a broad cleanup on a box
  with two live sibling lanes is the same shared-box collision #166 and #167 both recorded.

- **(7) is a gap in what a gear declares.** The gear table says which seats a gear engages and
  requires a *shift* to be reported in one line, but says nothing about a seat deliberately not run
  within the declared gear. Because the deviation is invisible in the diff, nothing detects it after
  the fact either — unlike a fence breach or a new export.

- **(8) is a known blind spot filed in the wrong place.** The guard's own header comment already says
  it: *"`git ls-files` reads the INDEX, not the working tree ... so stage before running this."* The
  precondition is written down, in a test file, while `AGENTS.md`'s **Before you commit** section —
  the one document that tells a lane which three commands to run, and which spends four paragraphs on
  the personal-paths rule itself — never mentions staging. It is the same lesson `AGENTS.md` already
  records for #649: a guard scoped by a convention (there, a filename prefix; here, whether git has
  heard of the file) misses exactly the files that fall outside it.

## What Worked Well

- **The mutation is the strongest-evidenced thing in the run, and it was built as a mandatory step
  rather than a nice-to-have.** Thirty contiguous runs of exactly 500 missing lines, one per kill,
  with a signature identifying which kill caused which gap, is not a pass/fail — it is a
  demonstration that the check discriminates. It then survived the hardest available test of an
  EXECUTED claim: independent reconstruction from raw logs, after the databases were dropped, matching
  the published table exactly. That is the bar the rest of this repo's `[EXECUTED]` labels should be
  read against.

- **Re-putting a question that could not be answered, instead of answering a different one quietly.**
  A kill-based sweep of the fold cursor's missing `fsync` would have measured nothing — #167's own
  ablation established that a same-process `kill -9` cannot unwrite bytes already in the page cache on
  this box, so such a sweep reports the absence of a mechanism as the presence of a guarantee. The run
  replaced it with a closed question — *is every reachable post-crash cursor state safe?* — and wrote
  all five states by hand, each recovering to 1,129,197 distinct `n` and 0 gaps. **This is a reusable
  move:** when the only crash you can stage cannot produce the failure you are testing for, stop
  staging crashes and enumerate the post-crash states. The residual — whether a *host* crash could put
  the cursor ahead of the truth — is marked REASONED and left open, with what would settle it named.

- **Counts reported per window, and the non-trials named as non-trials.** 61 bind banners (30 faulting
  instances + 31 plain restarts) and 30–31 untargeted port-clear kills are real chaos and zero evidence
  for any particular window, so they were reported separately rather than folded into a clean 30. This
  is #167's 75-vs-10 lesson applied before review had to ask for it — but it was applied because the
  handoff said to, not because anything in the harness or the spike-plan doc did. See the root cause
  for (1): the one prd-48 lesson that reached this lane travelled in prose a conductor happened to
  remember.

- **Copying #167's throwaway rather than rebuilding it.** It made the run cheap, and — more
  importantly — it kept the ledger byte-identical by symlink, so every count here is comparable with
  the note this one extends. Re-copying from the live source would have picked up a larger, different
  log and quietly destroyed that comparability. The same decision imported the measurement bug in
  (1); those are two faces of one choice, and the copy was still right.

- **The falsifier not firing did not end the run.** The negative verdict was reported as a negative,
  and the finding that survived it — a fully durable journal is not sufficient as a *written* contract
  — was recorded as a recommendation against prd-48's criterion 2 and left unimplemented because the
  PRD is outside the fence. Surfaced, not absorbed.

- **Resuming an interrupted session from its transcript.** A killed session between "all measurements
  complete" and "nothing written down" is the worst possible moment to lose one, and it cost about five
  minutes instead of three sweeps.

## Recommended Changes

1. **File an issue that lands the deferred spike-harness lessons in
   `docs/research/2026-08-24-shared-record-spike-plan.md`, rather than writing them into a retro a
   fourth time.** That file is what the remaining S-series spikes (S3, S7, S8) are planned from, and it
   has not changed since before #166 and #167 were written. The four items already prescribed, plus
   the two this run adds:
   - decide a spawn succeeded by **waiting for the target's own ready banner**, never by a liveness
     check at N ms (#167 rec 1 — the one that cost this run a smoke cycle);
   - any number read from a live endpoint or ambient shell state must be **polled to a results file**,
     not observed live (#166 rec 1);
   - for every check in the verification plan, state **whether the harness's design lets it fail at
     all** (#166 rec 4 — now three occurrences, this run's §4.1 being the third);
   - **tag a throwaway's processes with a lane-unique marker** so cleanup cannot reach a sibling
     lane's (#167 rec 3);
   - **new: give each run its own directory, database and port, and write a terminal marker**, so
     "did a stray process pollute this?" is an mtime comparison rather than a judgement — this run's
     interruption was cheap only because all four held;
   - **new: a trial schedule must be paced past the producer's own runtime**, or its late trials fire
     against a server nothing is POSTing to and are counted as silent passes.

   **High leverage. Artefact: repo doc**, that file — but the change that matters is the *issue*, not
   the paragraph. Not made here; this lane's fence is the note plus this retro.

2. **Add one sentence to `AGENTS.md`'s "Before you commit": stage your changes before running the
   suite, because `no-personal-paths-law.test.ts` reads the git index and is blind to an untracked
   file.** The precondition already exists, in that test's own header comment, where no lane reading
   the runbook will find it. This run's whole diff was untracked, so its green pre-commit suite was
   vacuous for the one law most relevant to a research note full of build-area paths. **High leverage,
   one line, in this repo. Artefact: repo doc**, `AGENTS.md`. Out of this lane's fence.

3. **File a follow-up issue for the guard itself** — `packages/server/src/no-personal-paths-law.test.ts`
   should either scope by what a file *is* (working-tree files, minus ignores) or fail loudly when the
   working tree has unstaged changes, rather than passing quietly over files git has not heard of. Body
   carries `Spawned-by: #205`; `Missed-by: none` is the honest answer, since the blind spot predates
   this run and no seat in this pipeline was responsible for it. Medium leverage; recommendation 2 is
   the cheap mitigation and this is the real fix.

4. **A gear seat deliberately not run gets one line in the PR body, in the same form as a gear
   shift** — `gear 3, no architect: the plan is #167's rerun recipe plus the issue's Definition of
   done`. A skip with a reason and an omission are indistinguishable afterwards, and unlike a fence
   breach or a new export, nothing in the diff detects this one. Optional/medium leverage. **Artefact:
   the workflow runbook the handoff is written from** (`~/.claude/CLAUDE.md`, beside the gear table's
   existing "a gear change is an event" rule) — outside this repo, so a note here rather than a change.

## Highest-Leverage Next Step

**Open the issue in recommendation 1 and land those six lines in
`docs/research/2026-08-24-shared-record-spike-plan.md`.** Not because any one of them is profound —
they are all one-liners — but because this run measured what happens when they stay in retros: #167's
retro diagnosed the spawn-detector ambiguity precisely, named the fix, named this exact file, and
deferred it out of fence; #166's retro deferred four more into the same file with the same sentence;
the file has one commit in its history and it predates both. This lane then rebuilt the harness from
#167's copy and reproduced the bug at 15 kills for 3 trials. With three kill-based S-series spikes
still ahead in prd-48, the failure mode is not that the lessons are wrong or unwritten — it is that
**a recommendation with no issue behind it is not a change, and writing it a fourth time will not make
it one.**
