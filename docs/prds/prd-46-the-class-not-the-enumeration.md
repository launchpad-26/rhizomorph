# prd-46 — the class, not the enumeration: a guard that lists spellings misses the next one

> **Status:** **BLESSED** — gabriel-canaan, 2026-08-25, in session. Milestone `prd46`. Drafted 2026-08-25 from the verification of PR #68 (prd-45 wave 1).
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

**Unfiled work implied, described not numbered:** declared tolerance #7's reason distinguishes
`--is-ancestor`'s exit 1 from its exit 128 only through stderr it discards; the law's two
`0444`-write assertions are false as root and go red in a root container; and `.swarm/coupling.txt`
needs an entry for the law's collection-time coupling to `gate.sh`'s text — that last one is
gitignored working state and therefore an operator act, not a lane's.

## Open questions

- **Does the structural predicate have a tolerable false-positive rate on this file?** The rule in
  ruling 1 is derived from six evasions and one live instance, not from a survey of the whole
  script. If it convicts legitimate lines faster than it catches dishonest ones it will be
  suppressed into uselessness, which is how the current enumeration got here. Open, not ruled.
- **Should the law govern any script beyond `gate.sh`?** `scripts/dev/*.sh` have the same shape and
  none of the same stakes. Open, not ruled.
