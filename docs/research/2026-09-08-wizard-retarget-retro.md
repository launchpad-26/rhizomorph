# Retro — prd20 w1: the wizard switches the watched repo through the retarget route (#216)

Lane `216-wizard-retarget`, branch based on `prd20` (the milestone's integration branch, not
`main`). Covers the whole run: an implementer build that stalled mid-edit and was resumed rather
than restarted, an independent reviewer pass with two deliberate mutations, a separate test-guard
pass with two more, and a docs-syncer pass whose one non-trivial finding was caught before it
became a fence breach. Verify (typecheck / lint / test) is green on the final state, confirmed
independently by the dispatching session rather than taken on the implementer's word: 417 test
files, 7692 passed, 3 expected-fail, 6 skipped. Written once, after that gate passed.

**Gear 3, no shift.** One new exported symbol (`requestRetarget`), inside the fence the issue had
already widened before the change. No migration, no route added (the route itself, `POST
/api/retarget`, already existed and was already gated — this issue wires its one caller), nothing
on `security-auditor`'s path list. The negative fence — the other table in
`route-class-law.test.ts`, the rest of `packages/server/**`, `docs/adr/`, `docs/prds/prd-20-the-concierge.md`,
`package-lock.json` — held, and one edit that would have crossed a *different* issue's live fence
(`docs/roadmap.md`, #330, In review) was made and then reverted before commit rather than landed.

## What Was Built

A client-side mutating call (`packages/web/src/concierge/retarget.ts`) that is a same-shape sixth
sibling to five existing ones (`clone.ts`, `instrument.ts`, `rotate.ts`, `label.ts`,
`launch.ts`): narrow `fetchImpl` seam, capability-token header, JSON body, and — the one new shape
in the family — a 409 read as a *value* (`RetargetOutcome`'s `refused` branch with a typed code
union) rather than a thrown exception, because the server can correctly refuse without anything
having gone wrong. The caller is `connect/wizard.tsx`'s existing conductor step, extended with an
arm-then-act state machine identical in shape to the launch button's (`confirming` → `working` →
`done`/`failed`), so the new act is held to the same "no effect ever reaches an act" law the file
was already pinned to. Chosen over a new panel or route because the route (`POST /api/retarget`)
and its server-side validation already existed and were already gated — prd-20 ruling 5's own
2026-08-24 amendment named exactly this wiring as the piece left undone, and the plan comment on
the issue was the whole architecture, so no new design was needed, only a caller.

## Retro Summary

The task: give the setup wizard's conductor step a live path to `POST /api/retarget`, replacing a
visible sentence that told the operator the switch "is not built" with an actual switch, gated
behind an arming click, whose result panel renders the route's own account (both session ids,
lanes affected, re-issue commands) rather than a templated guess.

It went well. The build followed the issue's own line-by-line plan closely enough that no
architecture decision was needed in the lane, the sibling-case sweep the issue asked for found
real instances beyond the one it named, and three independent review passes (reviewer, test-guard,
docs-syncer) each verified their findings by mutation rather than by reading, catching zero
blocking defects between them — a genuinely clean build, not merely an unreviewed one. The
biggest actual problem was operational, not a code defect: the implementer's session stalled for
600 seconds mid-edit and was marked `failed` by the harness while 11 of 14 fenced files were
already correctly edited. The second-most interesting event was a *correct* edit made outside its
own dispatch's declared scope (docs-syncer touching `docs/roadmap.md`), caught only because a human
step checked it against the live fence list before commit.

## What Went Wrong

1. **The implementer's session stalled for 600 seconds with no progress, mid-edit on
   `wizard.test.tsx`'s conductor describe block, and the harness marked the run `failed`.** The
   work already done was correct and complete for 11 of the 14 fenced files; only
   `retarget.contract.test.ts` was entirely missing and the wizard test file was mid-edit. Nothing
   was lost, but the run's own status record says `failed` for a build that finished clean minutes
   later — the failed marker describes the stall, not the work.

2. **A required seat (`docs-syncer`) made a factually correct edit that was outside its dispatch's
   own stated scope**, and the edit happened to collide with a second lane's live, in-review fence
   (`docs/roadmap.md`, #330). The dispatching session caught it before commit by checking the
   fixed file against currently-open issues' fences — a check that is not written down anywhere as
   a required step for a "docs-syncer found something stale" finding, only performed here because
   the dispatcher happened to think to run it.

3. **Enumeration drift touched more places than the issue's own naming implied.** The issue named
   one sibling doc comment (`wizard.tsx:47`) to fix alongside the visible refusal at `:753`. In
   practice the same shape recurred four more times as *counts*, not prose — README's
   thirteen-call-sites/ten-modules pair, `route-class-law.test.ts`'s matching assertions (twice
   over, module count and call-site count), and `mutating-calls-law.test.ts`'s "exactly five"
   language — all needed to move to fourteen/eleven/six in the same commit or the suite would fail
   for a reason unrelated to the feature. None of these were missed in the end, but they are the
   kind of miss that is invisible until CI catches it, and this issue is the fourth or fifth in
   this repo's history to add a mutating call and therefore the fourth or fifth time this exact set
   of counters needed to move together.

## Root Causes

- **(1) is a harness detection problem, not a build problem.** A 600-second no-progress window is
  being read as terminal failure by whatever drives the implementer dispatch, but "no output for
  600s" and "the work is wrong" are different facts, and only one of them is true here. The
  recovery path (resume via SendMessage rather than restart) worked and cost little, but it worked
  because a human checked the partial diff before deciding to resume rather than restart — nothing
  in the process says to do that check, so the same stall next time could just as easily be
  answered by discarding 11 correct files and starting over.

- **(2) is the same shape this repo's own `AGENTS.md` names for a *fence*, applied one level
  earlier — to a dispatch's *scope* rather than the issue's own declared file list.** The fence
  rule protects against a lane editing a file it was never assigned; nothing equivalent protects
  against a required *review* seat, dispatched to check whether docs are stale, deciding on its own
  authority to also fix what it finds stale. The content was right; the authority to land it,
  unchecked against concurrently open work, was not established. It was only caught because the
  dispatching session independently re-checked against the board, which is exactly the "reviewing
  what comes back means reading the diff, not the write-up" rule already in `~/.claude/CLAUDE.md` —
  it worked here, but it worked as a manual habit, not as a step the docs-syncer dispatch itself
  required.

- **(3) is a known-recurring cost with a known fix that is not yet load-bearing.** Every one of
  these five counters exists specifically *because* a prior issue in this same family (adding the
  fourth, then the fifth mutating call) hit the identical miss and pinned an exact-count assertion
  to prevent silent drift. The assertions are doing their job — nothing shipped with a stale count
  — but the issue's own plan named only one of the five places that needed to move, and the other
  four were found by running the suite rather than by the plan enumerating them up front. The
  pattern ("adding an Nth item to an enumerated, counted family touches at minimum: the module
  itself, its sibling law file, the README prose, and the cross-check test that ties the README
  prose to the law file") is real and repeats, but it lives only in the muscle memory of whoever
  writes the plan, not in a runnable check.

## What Worked Well

- **Resuming the stalled implementer from where it left off, rather than restarting.** The
  dispatching session inspected the partial diff, confirmed 11 of 14 fenced files were already
  correct, and resumed the same agent rather than discarding the work and re-running from scratch.
  This is the right call and the retro records it because the harness's own `failed` status made
  the wrong call (discard and restart) the path of least resistance.

- **The dispatching session independently re-ran the full gate (`typecheck`, `lint`,
  `VITEST_MAX_WORKERS=6 npm test`) rather than trusting the implementer's self-report of "all
  green."** This is the rule `~/.claude/CLAUDE.md` states — a confident summary and a passing test
  file are not evidence — applied as practice rather than merely as policy, and it is what makes
  the retro's own verify numbers (417 files, 7692 passed) a fact rather than a repeated claim.

- **Two independent review passes each proved their findings by mutation rather than by
  inspection.** The reviewer introduced and reverted a no-op-body mutation and a reintroduced
  stale doc comment; test-guard separately disabled the 409-refusal value-return branch and wired
  the arm button directly to the act — all four caught by the existing suite as designed. This is
  the repo's own named standard for a finding ("what mutation would this test survive?") applied
  by the reviewers rather than merely asked of the author, and it produced a genuinely verified
  zero-defect result rather than an asserted one.

- **The sibling-case sweep found real instances beyond the one the issue named.** The issue named
  `wizard.tsx:47`'s doc comment as the sibling to `:753`'s visible refusal; the build additionally
  found and fixed the four enumeration-count sites (root cause 3) and SECURITY.md's stale "no
  caller wired to it yet" claim. Treating "what is the sibling case?" as a sweep rather than a
  single lookup is what caught the ones the plan didn't name.

- **A gear-shift-shaped judgement call was made correctly without actually shifting.** The route
  itself, `POST /api/retarget`, already existed from a prior wave; this issue only added its
  browser-side caller. A less careful read could have treated "add a new exported symbol that
  calls a server route" as gear-4-shaped (new API route); it correctly wasn't, because the route
  predates this issue and nothing in the server package changed except one test's expected-count
  table.

## Recommended Changes

1. **Give a stalled-but-partially-correct implementer run a status other than `failed`.** A run
   that stopped making progress for 600s but left correct, fenced work behind is a different event
   than a run that produced wrong output, and the two currently collapse into the same status. At
   minimum, the resuming session should record (in the retro, as done here, or in the run record
   itself) that the failed status described a stall rather than a defect — the alternative is that
   the next dispatcher, seeing `failed`, discards correct work by default. Medium leverage.
   **Artefact: the workflow runbook / harness that assigns run status** — outside this repo's own
   files, so this is a note rather than a change made here.

2. **Add one sentence to the `docs-syncer` dispatch instructions (wherever that agent's brief
   lives): a fix to a file outside the issue's own fence must be checked against currently open
   issues' fences before it is treated as safe to land, exactly as a lane checks its own negative
   fence.** This run's `docs/roadmap.md` edit was accurate and still would have collided with #330
   had the dispatching session not independently re-checked it. The check that saved this run was
   ad hoc; making it a named step turns "a human happened to think of it" into something the next
   docs-syncer dispatch does not have to rediscover the hard way. High leverage — this is the one
   real process gap this run surfaced. **Artefact: `.claude/agents/docs-syncer.md`** (or wherever
   this repo's docs-syncer brief is materialised) — add: "A finding that implies an edit outside
   your own fenced files is a finding to report, not to fix, unless you have checked it does not
   collide with another open issue's declared fence."

3. **Write down the "adding an Nth mutating call" checklist as a checklist, not as tribal
   knowledge carried in whichever issue's plan happens to enumerate it.** This is the fourth or
   fifth time a new mutating call has required the same four coordinated edits (the module, its
   sibling `mutating-calls-law.test.ts` entry, the README's stated call-site/module count, and
   `route-class-law.test.ts`'s cross-check of that same README prose), and this issue's own plan
   named only the first of those explicitly. A short checklist in `AGENTS.md` or beside
   `replay/mutating-calls-law.test.ts`'s own header comment — "adding a call here also touches:
   README's stated count, route-class-law.test.ts's EXPECTED_CALL_SITES/EXPECTED_TOTAL, and any
   sibling law file's own count-in-prose" — would move this from "the suite eventually tells you"
   to "the plan tells you up front." Medium leverage, since the suite did catch every instance this
   run. **Artefact: repo doc**, a short paragraph added to
   `packages/web/src/replay/mutating-calls-law.test.ts`'s existing module header (which already
   documents each sibling by number) or to `AGENTS.md`'s "Constraints already paid for" pattern.

## Highest-Leverage Next Step

**Add the fence-collision check to the docs-syncer dispatch brief (recommendation 2).** It is the
one finding in this run that was not caught by an automated gate, a law test, or a mutation — it
was caught because a person happened to cross-check a correct edit against the board before
commit. Every other thing that went right in this run (the resumed implementer, the verified
gate, the mutation-proved reviews, the sibling sweep) either has a rule already stating it or a
test already enforcing it. This one doesn't, and the run's own record shows exactly how close it
came to landing a real fence violation with a perfectly accurate diff.
