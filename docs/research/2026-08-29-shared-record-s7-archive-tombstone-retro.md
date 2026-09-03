# Retro — prd48 w4: a pruned lane reads as pruned after an archive step, unconditionally (#172)

Lane `172-archive-tombstone`. Covers the full run: the implementer's from-scratch
spike (4 scenarios, conditional PASS), the reviewer's independent re-derivation
in its own scratch dir (which added a 5th scenario and changed the verdict),
and this session's landing pass. Verify (typecheck/lint/test) is green on the
final state — the diff is one new file (the research note) plus this retro, so
nothing else could have regressed.

## What Was Built

A throwaway spike (five glue scripts, outside this git tree) proving that a
hand-written "tombstone" `manifest.json` — written at the same path/shape a
real transcript capture uses — closes S7's "silent" gap (a pruned lane with no
transcript sidecar vanishing from the lane index) with **zero code changes**
to `retention.ts`, `paths.ts`, or `lane-index.ts`. It reused S7's fabricate →
seal → archive → prune → read pipeline and the real, unmodified
`export-record`, `verifyRecord`, `retention.ts`'s plan/apply functions, and
`readLaneIndex`, adding one new step (the tombstone writer) and one new axis
of scenario (single-lane vs multi-lane, real capture vs tombstone, clean vs
corrupt). The deliverable is the note itself; no product code changed.

## Retro Summary

The task: settle whether an archive-time tombstone can make prd-44 #38's rule
("a pruned lane always reads as pruned") hold without touching the three files
S7 identified as load-bearing. The answer is a **conditional PASS**, and the
condition is more precise at the end of this run than at the start of it: the
implementer's own four scenarios supported a PASS gated on one residual gap
(tombstone-before-prune ordering); review, re-running the spike independently
rather than trusting the note, found a **second, structurally different**
residual gap the implementer's scenario set could not have surfaced — a lane
the index counts through git alone (`laneHandlesOf`) that the tombstone writer
never enumerates (`allAttributedLanes`, telemetry-only). Both gaps are named in
the final note as distinct, with distinct remedies. It went well overall: the
implementer's spike was itself well-designed (real unmodified functions, a
genuine crash simulation, explicit "what this did not test"), and review is
exactly what turned a plausible one-gap PASS into a doc that names the harder,
real problem.

## What Went Wrong

1. **The implementer's four scenarios could only ever exercise single-lane
   sessions**, so they had no way to notice that the tombstone writer and the
   lane index compute "which lanes exist" from two different, non-identical
   sources. Scenario D (no archive at all) tested the *ordering* failure mode
   the issue explicitly named; nothing in the plan asked whether the
   *lane-set* the new code enumerates actually matches the lane-set the code
   it has to compose with enumerates. This is not a scenario that was tried
   and failed — it is a scenario that was never constructed, because nothing
   in the spike's own design prompted the question.
2. **The note's original crash-degradation claim (verdict 3) over-generalized
   from the one crash shape actually tested.** Truncating a tombstone
   mid-write (unparseable) degrades safely — but the note's first draft
   didn't distinguish that from a tombstone that parses cleanly and names the
   *wrong* lane, which is a materially worse outcome (`buildLaneIndex` folds
   any lane a manifest names, with no cross-check against the log it claims
   to describe, so a bad-but-valid tombstone conjures a phantom lane into the
   index). Caught only because review built and ran that specific case rather
   than accepting "crashes degrade safely" as a single claim covering both
   failure shapes.
3. **A citation was imprecise on the first pass**: "unconditionally `rm()`s"
   overstated what `applyRetentionPlan` actually does — it does have a
   live-session guard (`retention.ts:301-304`) — and review corrected it to
   name that guard rather than deleting the caveat.
4. **The reviewer's process was interrupted mid-run** (host process exited)
   and had to be resumed via SendMessage from a saved transcript rather than
   restarted from scratch. Cost some session overhead; did not cost any
   re-verification, since the resumed run picked up from where the transcript
   left off rather than re-doing already-EXECUTED work from memory.

## Root Causes

- **(1)** is the substantive one. The spike extended S7's precedent (which
  itself only ever tested one lane per session) without asking whether the
  new code's lane-enumeration function is asserted anywhere to agree with the
  lane-enumeration function the code it composes with already uses. Two
  functions in the same codebase computing "what lanes does this session
  have" from different fact sets (`allAttributedLanes`: telemetry events with
  a `sessionId`; `laneHandlesOf`: telemetry lanes ∪ every non-main worktree's
  branch) is exactly the kind of set-mismatch a single-lane-per-session
  scenario matrix cannot expose, no matter how many single-lane scenarios it
  runs — it takes a scenario that deliberately puts one lane in each set and
  the other lane in only one of them.
- **(2)** is a claim-scoping gap, not a testing gap: the crash test that was
  run was real and correctly executed, but the prose describing its result
  claimed more than that one test could support. The general shape is the
  same one this repo already names for review to catch: a test proves what it
  actually ran, and a summary sentence is a separate claim that has to be
  checked against the narrowest thing the evidence shows, not the broadest
  thing it's consistent with.
- **(3)** is an ordinary transcription imprecision, caught by review reading
  the cited source rather than trusting the note's paraphrase of it.
- **(4)** is environmental (a host process exiting mid-run), not a defect in
  the reviewer's approach; the recovery mechanism (resuming from a saved
  transcript) worked as intended and cost time, not correctness.

## What Worked Well

- **The implementer reused S7's real, unmodified functions rather than
  reimplementing or mocking any of them** — `export-record`, `verifyRecord`,
  `readRetentionPlan`/`applyRetentionPlan`/`voiceRetentionPlan`, and
  `readLaneIndex` were all called as shipped. This is what let the spike's
  claims be independently re-run by review from scratch and get the same
  numbers, rather than review having to trust a paraphrase of what a mock
  would have done.
- **`export-record --handle` was caught before it leaked**: the first
  `export-record` call without `--handle` stamped the real OS username into a
  fabricated record, and this was noticed and corrected before anything was
  quoted into the doc — the sanitisation discipline this repo's `AGENTS.md`
  states (`/home/operator`-style placeholders, never real machine identity)
  held under an actual near-miss, not just in principle.
- **Independent re-execution at review, not just re-reading.** The reviewer
  re-ran the spike from scratch in its own scratch directory rather than
  auditing the note's prose, which is what surfaced both the ordering-vs-
  lane-coverage distinction and the crash-shape distinction — neither would
  have been visible from reading the implementer's write-up alone, since both
  the write-up and its numbers were internally consistent; the problem was in
  what scenarios existed to check, not in whether the checked ones were
  reported honestly.
- **The note keeps "what this did not test" as an explicit section**, and the
  two residual gaps (verdicts 4 and 5) are stated as genuinely distinct,
  non-overlapping-remedy findings rather than folded into one hedge — a
  reader of this note cannot walk away thinking "ordering discipline" fixes
  everything, because verdict 5 says explicitly that it doesn't.

## Recommended Changes

1. **When a spike's new code has to compose with an existing function that
   already answers a similar question, check whether the two are asserted
   anywhere to agree — and if not, build a scenario where they'd disagree.**
   This is the one general, reusable lesson here: "two ways to enumerate the
   same kind of thing exist in this codebase" is a smell worth checking for
   explicitly during spike design, not something a scenario matrix stumbles
   into by chance. High leverage for prd-48's remaining S-series waves, which
   still compose new spike code against `retention.ts`/`lane-index.ts`'s
   existing assumptions. **Artifact: repo doc.** File:
   `docs/research/2026-08-24-shared-record-spike-plan.md` — add to the "How to
   read this" checklist (alongside Question/Hypothesis/Run/Verdict
   changes if/Output/Budget): "if this spike's new code enumerates the same
   kind of entity (a lane, a session, an actor) that an existing function in
   its fence already enumerates, name both functions' source of truth and
   state whether a scenario exercises the case where they disagree — a
   set-mismatch between two 'who counts as X' computations is not found by
   any number of scenarios that only vary within one of the two sets."
2. **State a crash-degradation verdict per crash *shape*, not once for
   'crashes'.** Verdict 3 in the final note correctly splits "unparseable"
   from "parses but names the wrong thing" — worth making that split a
   standing expectation rather than something review has to catch each time.
   Medium leverage. **Artifact: repo doc.** Same file as (1), same checklist:
   "a crash/corruption scenario's verdict names the specific corrupted shape
   tested (truncated/unparseable vs valid-but-wrong-content) and does not
   generalize to 'crashes degrade safely' as a single claim unless every
   materially different corruption shape was actually tried."
3. **No change needed for the mid-run interruption-and-resume.** It cost
   session overhead but the recovery mechanism (resume from saved transcript)
   worked; nothing here indicates a repeatable process gap worth encoding.

## Highest-Leverage Next Step

Add the "two enumerations, one entity" checklist item (Recommendation 1) to
`docs/research/2026-08-24-shared-record-spike-plan.md`'s "How to read this"
section. It is the one finding here that a future S-series spike's own design
process could catch before review has to, and prd-48 has several more waves
ahead that compose new code against this same file's existing lane/session
enumerations (`allAttributedLanes`, `laneHandlesOf`, and whatever S8/S9 add) —
exactly the shape that let verdict 5 slip past the implementer's own scenario
set here.
