# prd-46 — the class, not the enumeration: a guard that lists spellings misses the next one

> **Status:** **SHIPPED** — 2026-09-02. Milestone `prd46`: nine issues, all closed; the
> closeout, including what the plan got wrong, is the last section of this document.
> Blessed by gabriel-canaan, 2026-08-25, in session. Drafted 2026-08-25 from the verification of PR #68 (prd-45 wave 1).
> Earned explicitly by **prd-45 ruling 1**, which says *"a fix that closes the enumerated set and
> not the class earns this PRD a successor"* — that condition is now met, with evidence. Stands on
> prd-39 (the gate that holds) and prd-45 (the earned verdict), whose thesis this inherits: a check
> that cannot run must say so.

## Problem

prd-45 wave 1 gave `scripts/gate.sh` a law that asserts no guard prints a verdict it did not earn.
The law works, and it holds the eight guards the issue enumerated. But **the law itself is an
enumeration**: it recognises a swallowed failure by matching one of three literal strings. A
guard written with a fourth spelling is invisible to it, and the file it governs already contains
such a guard today.

So the honesty of `gate.sh` is currently pinned by a list of ways to be dishonest, maintained by
hand, in the one script whose failure mode is silence. That is the same shape as the defect
prd-45 set out to abolish, one level up.

## Evidence

- **Six evasions pass the sweep, one is caught.** Planting a plausible new guard after
  `scripts/gate.sh:116` and running the law: `some_new_check 2>/dev/null` is caught (control,
  1 failed) — while `|| :`, `2> /dev/null`, `&>/dev/null`, `||true`, `RES=$(cmd | tail -1)` and
  `cmd || { echo "  (could not check)"; }` each leave it 45 passed. Executed by the independent
  Opus pass during verification of PR #68.
- **One of those shapes is live in the governed file right now.** `scripts/gate.sh:82` captures
  `n=$(git log --oneline main..HEAD | wc -l)` and never reads the pipeline's status. Executed
  against a repository with `.git/HEAD` removed: `fatal: not a git repository`, pipeline rc 128,
  `n=0`, and the gate holds with *"no commits on the branch (a worker may have left work
  uncommitted)"* — a fault it did not earn, sitting between two lines wave 1 fixed. The law reads
  green with it there.
- **The sweep's own non-vacuity control does not exercise the sweep.**
  `packages/server/src/gate-honesty-law.test.ts` asserts that a rigged string fails to match a
  declared needle; it never runs the sweep that the rest of the clause depends on.
- **The enumeration has already grown once under review pressure.** Round 1 of PR #68's
  verification found the sweep covered `|| true` and `|| echo` but not `2>/dev/null`; the repair
  added the third string. Adding a fourth string is the same move, and the sixth evasion above
  shows where it ends.
- **A sibling of the same class survives one screen from a wave-1 fix.** `scripts/gate.sh:69`
  reads `--name-only` line-delimited, the exact quoting defect `-z` fixed at `:104`. With an
  in-fence file named `café.ts` the audit reports a fence violation for a file entirely inside its
  fence. It fails safe — a false hold, never a false pass — which is why it is here and not a
  wave-1 blocker.

## Success

1. A newly written dishonest guard in `gate.sh` fails the law **regardless of the spelling** its
   author used. **Not met while** any of the six evasions above passes a green law.
2. `gate.sh:82`'s unchecked pipeline is either fixed or declared, and the law can see it either
   way. **Not met while** the law reads green over a producer whose status nothing reads.
3. Every clause of the law can fail for the reason it claims. **Not met while** any control
   asserts something other than the mechanism it is controlling for.
4. The tolerance list stops growing by one string per review. **Not met while** closing a newly
   found evasion requires editing a list of literals.

## Non-goals

- **Not a rewrite of `gate.sh`'s guards.** Wave 1's eight fixes stand; this is about what can
  detect the ninth.
- **Not `shellcheck`.** Named as unfiled work in prd-45 and still correct there: it cannot see a
  guard whose two paths are both syntactically valid.
- **Not the landing sequence, the fence audit's semantics, or the timing pass.** Untouched.

**Rejected alternatives.** *Add the missing spellings to the list.* It is the move that produced
this PRD — the list grew from two to three under review, and six more spellings are already known.
*Ban `2>/dev/null` and friends outright.* The file has nine legitimate uses, each with a declared
reason; a ban would be a lie with a suppression list attached. *Assert on `gate.sh`'s behaviour
instead of its text.* Attractive, and partly right, but the script's failure mode is that it
**runs to completion and prints the wrong verdict** — behavioural assertions must therefore
enumerate the fault injections, which is the same enumeration problem wearing different clothes.

## What already exists (do not rebuild)

- `packages/server/src/gate-honesty-law.test.ts` — the law, its `DECLARED_TOLERANCES` table
  (nine entries, two of them dated KNOWN GAPs), and its line-extraction helpers
  (`uniqueLineIndex`, `sliceLines`) that pull real lines out of the tracked script rather than
  reimplementing them. The extraction technique is right and stays.
- `fail()` and the `MERGED` flag in `scripts/gate.sh` — the single reporting path every guard
  routes through. Reused, never reimplemented.
- `.swarm/coupling.txt` — the registry that already records this class of cross-directory
  breakage for `packages/web/src/theme/tokens.test.ts`.

## Rulings

## Ruling 1 — the law recognises a swallowed failure by structure, not by spelling

The sweep is replaced by a **structural predicate over the script's shape**: a command
substitution or pipeline whose exit status is never read before a verdict is printed. The
reference form, from the verification that produced this PRD, is *a `$(...)` assignment whose
following line is neither `_RC=$?` nor `|| fail`* — which catches `gate.sh:82` and five of the six
known evasions in one rule.

The tolerance table stays and keeps its reasons; what changes is that an entry becomes an
exemption from a **rule**, not a member of the set being matched. A tolerance nobody can enumerate
is how prd-39's class survived (prd-45 ruling 3), and a detector nobody can generalise is how this
one did.

## Ruling 2 — every control in the law exercises the mechanism it controls for

A control that asserts something adjacent to the mechanism is decorative. Each clause's control
runs the real predicate against a rigged input and shows it firing, and against a clean input and
shows it silent. This applies to the structural predicate of ruling 1 first, because a structural
rule fails differently — and more quietly — than a string match.

## Ruling 3 — a fix's sibling is named in the same commit, or declared

Wave 1 fixed `:104`'s quoting and left `:69`'s identical defect one screen away; it fixed eight
guards and named a ninth. Naming is enough — a declared, dated gap is a fact the next reader can
act on. What is not enough is silence. Any commit under this PRD that fixes a shape states, in its
body, where else that shape lives in the file and whether it was fixed or declared.

## Sequencing (waves, each gated as ever)

`scripts/gate.sh` and `packages/server/src/gate-honesty-law.test.ts` are this PRD's territory.
`.github/workflows/ci.yml` is prd-45's and is not entered. `packages/contract/` is prd-29 wave 3's.
Every wave follows prd-45 wave 1 landing, because all of it edits what that wave wrote.

**Wave 0 — operator act, booked not skipped.** As prd-45 wave 0, and for the same reason: work
that edits `gate.sh` cannot be landed by `gate.sh`. Not dispatchable.

**Wave 1 — the Keystone, and a stack landed as ONE issue.** `prd46 w1: the honesty law
recognises a swallowed failure by structure` — the structural predicate of ruling 1 with its
controls (ruling 2), shown red against each of the six known evasions and green against the nine
declared tolerances, **plus the fix to `scripts/gate.sh:82`**.

The `:82` fix is in this issue and not a later wave, and the reason is the same one prd-45 gave
for folding its own rulings 1–3 into a single issue: ruling 1's predicate **convicts `:82`**, which
is this PRD's headline evidence, so the law cannot be green while that line stands. Landing them
apart would mean either a red wave-1 law or a tolerance entry minted only to be deleted a wave
later. That is a stack, and the wave contract allows a stack in a wave only as a single issue —
one lane, commits in order: the `:82` fix first, then the predicate that can now be green.

Success 2 is discharged here rather than in wave 2 as this document's first draft had it. Recorded
at grooming, 2026-08-25, before any issue existed.

**Wave 2 — the sibling that fails safe.** `prd46 w2: the fence audit reads paths the way the NUL
guard does` (`scripts/gate.sh:69`, `-c core.quotePath=false`). It follows wave 1 because it edits
the same file, not because it depends on the predicate. Alone in its wave for that reason: a
second lane in `gate.sh` at the same time is a rebase conflict at landing, which is exactly what
the fence rule exists to prevent.

**Waves 3-6 were this document's "unfiled work implied, described not numbered" paragraph,
and are declared here because they were filed.** Amended 2026-08-31. The paragraph named three
residuals and left them unnumbered; issues were then filed against waves 3, 4, 5 and 6, so the
tracker ran ahead of the plan of record and `scripts/dev/prd-reconcile.sh 46` reported six
UNDECLARED WAVE rows. The document is the plan, so the document moves — the waves below are the
work that was already filed, not new scope. Nothing here is groomed afresh; each names the issue
that carries it.

**Wave 3 — the prints that outrun what they established.** `prd46 w3: nothing the gate or its law
prints outruns what it established` (#73). Declared tolerance #7's reason distinguishes
`--is-ancestor`'s exit 1 from its exit 128 only through stderr it discards; the prune's success
line is printed for "the file parsed and was rewritten" rather than for a handle actually removed;
and a manifest whose shape the prune does not understand passes silently. It **absorbs wave 6**
(below) as its third instance. Follows waves 2 and 4, which between them held both of its
fenced files — `gate.sh` was wave 2's and the law file was wave 4's, and both landed together
in PR #155, so this issue's line citations must be re-derived against that result rather than
trusted.

**Wave 4 — the proofs that are false as root.** `prd46 w4: the law's unwritable-file proofs hold
as root, or say they do not` (#74, closed 2026-08-31 in PR #155). The law's two `0444`-write
assertions cannot hold against `CAP_DAC_OVERRIDE`, so they went red in a root container. Landed
as `it.skipIf(RUNNING_AS_ROOT)` with the reason in the test title — hold, or skip and say so.

**Wave 5 — the coupling the registry does not record, and the class the predicate does not
cover.** Two issues, disjoint fences, dispatchable as peers:

- `prd46 w5: the coupling registry records the law's collection-time hold on gate.sh` (#72).
  `.swarm/coupling.txt` needs an entry for the law's collection-time coupling to `gate.sh`'s text.
  **Ordinary dispatchable work.** This document previously called it an operator act rather than a
  lane's, on the ground that the file is gitignored working state. That ground is false and the
  conclusion goes with it: `.gitignore` writes `.swarm/*` and then `!.swarm/coupling.txt`, so the
  file is TRACKED. EXECUTED 2026-08-31 — `git ls-files --error-unmatch` returns it (rc 0),
  `git check-ignore` does not match it (rc 1), and it carries commit history. A lane can commit
  it, so a lane may have it. Ruled by the operator 2026-08-31, closing the contradiction #72's own
  body raised on 2026-08-26.

  One dispatch note, because no single-wave lint run can surface it: `scripts/fence-lint.sh 47 72`
  reports an OVERLAP on `.swarm/coupling.txt` across milestones. It is **historical** — #47 is
  closed and its work landed as `88c3686`, which is in that file's own history — and `fence-lint`
  reads fences, not issue state, so it will keep reporting it.
- `prd46 w5: the law's own proofs and predicate cover the class, not one spelling` (#179). Ruling
  1's predicate recognises only the bare `VAR=$(` spelling and is blind to `VAR="$(cmd)"`,
  `export VAR=$(…)`, backticks and multi-line `$( … )`; and a second proof in the same file goes
  vacuous under root instead of skipping. **Success 1 and success 3 are not met until this lands**
  — see the note below.

**Wave 6 — superseded, and kept declared because its issue is closed against it.** `prd46 w6: the
rise fixtures derive their delta from the tolerance they test` (#82, closed 2026-08-28). Merged
into wave 3 at the operator's direction as its third instance — same two files, so the two could
never have been peers. Nothing was dropped. It stays declared rather than marked with a
`SUPERSEDED` blockquote because a marker retires the wave from the declared set, and #82 is closed
*claiming* w6: retiring it here would re-report that issue as UNDECLARED, trading one drift row
for another.

**#75 — wave-less by title, absorbed by wave 3.** Amended 2026-09-02. `prd46: the manifest
prune says it pruned only when it did` (#75) was filed without a wave token, so
`scripts/dev/prd-reconcile.sh 46` reports it as a NO WAVE row: fence-lint never saw it and the
board's orphan check could not tell. It was not dropped — its subject is wave 3's second
instance (*"the prune's success line is printed for 'the file parsed and was rewritten' rather
than for a handle actually removed"*). It closed **2026-08-26 as superseded by #73**, which took
both instances of the one fact; #73 then landed in **PR #184**, wave 3's bundle, whose own
`Closes` lines are #73 and #181. #184 is where the work arrived, not where #75 closed. Declared
here rather than by retitling a closed issue, for the reason wave 6 gives above:
the issue is closed claiming no wave, and editing its title now would rewrite the record of what
was actually dispatched.

**This paragraph does not clear the row, and is not meant to.** `prd-reconcile.sh`'s NO WAVE
check reads the issue *title* for a `wN:` token and never reads this document, so #75 will keep
reporting for as long as it keeps its title — the same standing-report situation as the
`fence-lint.sh 47 72` OVERLAP in the residuals below. `EXECUTED` 2026-09-02 against the script's
own logic. What this paragraph buys is that the next reader finds the answer here instead of
re-deriving it; the alternative — retitling — trades a true row for a falsified record.

**Where this leaves the success criteria.** Every wave this document declared before today
(0, 1, 2) is complete — but success 1 (*"fails the law regardless of the spelling"*) and success 3
(*"every clause can fail for the reason it claims"*) are **not met**, and #179 is what closes both.
The milestone reads done by waves and is not done by its own definition; recorded here so nobody
closes it on the wave count alone.

## Open questions

- **Does the structural predicate have a tolerable false-positive rate on this file?** The rule in
  ruling 1 is derived from six evasions and one live instance, not from a survey of the whole
  script. If it convicts legitimate lines faster than it catches dishonest ones it will be
  suppressed into uselessness, which is how the current enumeration got here. Open, not ruled.
- **Should the law govern any script beyond `gate.sh`?** `scripts/dev/*.sh` have the same shape and
  none of the same stakes. Open, not ruled.

## The three rulings, as they landed

**Ruling 1 — the law recognises a swallowed failure by structure, not by spelling.** Landed in
wave 1 (#70) as the structural predicate, and then **widened twice more than the ruling
anticipated**. The reference form the ruling named — *a `$(...)` assignment whose following line
is neither `_RC=$?` nor `|| fail`* — turned out to recognise only the bare `VAR=$(` spelling; it
was blind to `VAR="$(cmd)"`, `export VAR=$(…)`, backticks and the multi-line `$( … )` shape.
#179 (wave 5, PR #191) closed that, and the predicate now carries a **22-row table** of
spellings with each row's disposition and the evidence for it.

Row 4 is the one worth reading. A keyword-prefixed producer (`export V=$(false)`) exits 0
because bash reports the **keyword builtin's** status, not the substitution's — so a `|| fail`
tail on such a line checks the wrong thing and can never fire. Round 1 of #179's fix treated
those lines as *checked*, which made the law **worse than before it existed**: invisible became
seen-and-excused. Caught in verification review; the landed form forces them into
`findUncheckedProducers` unconditionally.

**Ruling 2 — every control exercises the mechanism it controls for.** Landed. The non-vacuity
controls now run the real predicate against a rigged input and show it firing, and against a
clean input and show it silent, rather than asserting something adjacent.

**Ruling 3 — a fix's sibling is named in the same commit, or declared.** Held throughout, and it
is the ruling that produced the record this closeout is built from: waves 3, 4, 5 and 6 all exist
because a fix named where else its shape lived instead of stopping at the line it was given.
prd-47 later generalised it into the standing PR-body question *"what is the sibling case?"*.

## The four success criteria, assessed

1. **A dishonest guard fails the law regardless of spelling — MET**, and only after #179. This
   document's own Sequencing said so in advance (*"success 1 and success 3 are not met until this
   lands"*), which is the single best thing about how prd-46 was run: the milestone read done by
   wave count while the document said plainly that it was not.
2. **`gate.sh:82` fixed or declared — MET.** Fixed in wave 1, in the same issue as the predicate
   that convicts it, in the order the Sequencing specified.
3. **Every clause can fail for the reason it claims — MET**, likewise on #179.
4. **The tolerance list stops growing by one string per review — MET.** A tolerance is now an
   exemption from a rule rather than a member of the matched set. `EXECUTED` 2026-09-02:
   `gate-honesty-law.test.ts` runs 182 tests at ~6.5 s — 181 passing and 1 skipped by
   `it.skipIf(SYSTEM_BASH_GUARDS_EMPTY_ARRAYS)` on any host whose system bash is 4 or newer.

## The two open questions, still open

**Does the structural predicate have a tolerable false-positive rate on this file?** Still open,
and now better evidenced than when it was asked: the 22-row table records which spellings are
producers and which are excluded (row 9, `VAR="just text"`, names `gate.sh:14` as a live instance
correctly never flagged), and row 20 records two false-conviction bugs found and fixed in
verification — an unbalanced apostrophe inside a comment, and a `)` inside one. The rate has not
been surveyed across the whole script. **Open, not ruled.** Inherits to whoever governs the law
next.

**Should the law govern any script beyond `gate.sh`?** Still open. `scripts/dev/*.sh` have the
same shape and none of the same stakes, and nothing since has changed that. **Open, not ruled.**

## What the plan got wrong

**The Sequencing was written for two waves and the work needed six.** Waves 3–6 were a single
"unfiled work implied, described not numbered" paragraph; issues were filed against them anyway,
and `prd-reconcile.sh` reported six UNDECLARED WAVE rows before the 2026-08-31 amendment moved
the document to match. The amendment was the right call and is why this closeout has so little
to add — but the pattern is that **an unnumbered paragraph gets filed against**, and the plan is
then behind from the first day someone acts on it.

**Ruling 1's reference form was mistaken for the rule.** The ruling said *structure, not
spelling*, then offered one concrete shape to illustrate it — and the implementation
matched the shape rather than the class, which is precisely the failure the ruling was written
to abolish, one level further down. It took #179 and a verification round to notice. prd-47's
response to this cohort of lessons — mark every mechanism *candidate* — reads as a direct
consequence.

**A verification round made the law worse before it made it better.** #179's round 1 counted
keyword-prefixed producers as checked. A fix that converts an invisible defect into an excused
one is worse than no fix, and only a second adversarial pass caught it.

## Residuals, with owners

- **The false-positive-rate survey** (open question 1 above). Unowned, and cheap to start: the
  predicate and its table now exist to survey against.
- **Whether the law should govern `scripts/dev/*.sh`** (open question 2). Unowned.
- **`fence-lint.sh 47 72`'s historical OVERLAP on `.swarm/coupling.txt`.** Not a defect and not
  fixable by editing a fence: `fence-lint` reads fences, not issue state, and #47 is closed with
  its work in that file's history. It will keep reporting. Recorded so the next reader does not
  re-investigate it. **No owner needed.**
- **`shellcheck` over `scripts/`.** Still unfiled, still correctly out of scope here — it cannot
  see a guard whose two paths are both syntactically valid. Carried in prd-45's residuals.
