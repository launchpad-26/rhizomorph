# prd-60 — the law that counts its own cases: a derived set is pinned, not measured

> **Status:** **BLESSED** — ciaran-slow, 2026-09-18, in session. Milestone `prd60`.
> Written out of the sibling sweep required by #596's Definition of done, recorded
> at #602. Sequenced after prd-54 (which owns `.swarm/coupling.txt` and its law)
> and independent of prd-59 (the gate's load probe — a suite that *fails* under
> concurrency, where this is a suite that *passes* having checked less).

## Problem

A law that generates its cases from a derived list cannot tell the difference between
"every case passed" and "there were fewer cases than there should have been."

The shape is always the same. The law (a) **derives** a list — by reading source text, a
directory, a glob, or a live table; (b) drives `it.each`, `describe.each`, or a `for`-loop
of assertions over it; and (c) guards against vacuity by measuring **the source side** — a
`toBeGreaterThan(N)` floor, a count of the fixtures on the other side of the comparison, a
second derivation from the same bytes. None of those can see the derived set shrink. A name
falls out of the derivation, one case stops being generated, and the suite is green through
the loss.

The cost is not that a test fails to catch a bug. It is that **the law reports success for
work it no longer does**, and it keeps reporting it — so the next reader has a green bar and
a false inventory. This repo has already paid for it twice, in the same file class, years
apart in maintenance terms, and neither time was found by the law itself.

## Evidence

- **A guard that counts call sites cannot see a name leave the set it guards.**
  `packages/team/deploy/init.test.ts` asserted every variable `deploy/serve.ts` reads is
  forwarded to the container, guarding with `classified === occurrences`. At #584's
  verification, dropping `RZ_TEAM_JOURNAL_DIR` from a multi-name resolver while leaving both
  counts untouched left **47/47 green**. EXECUTED.
- **A count cannot see a rename either, even when nothing is lost by cardinality.**
  Fixing the above (#596, landed `83ce0e65`), a scratch `toHaveLength(15)` probe stayed
  **green** under a rename inside the resolver — a name leaves, a name arrives — while the
  pinned sorted list went **red**. Re-derived independently at verification with a set dump
  proving cardinality had not moved. EXECUTED.
- **The sharpest case has already rotted once, and the fix left the guard behind.**
  `packages/server/src/collectors/otel/harness-profiles.test.ts:69-71` guards with
  `expect(fixtureServiceNamesAndMetrics().length).toBeGreaterThan(0)` — the **fixtures**, the
  side being checked — while `:79` drives `it.each(Object.values(METRIC_PROFILES))` off the
  live table. The comment at `:72-78` records that #323's verify pass added a third profile,
  wired it into dispatch, and watched the law **stay green 7/7** because it iterated a literal
  pair. The law was moved onto the live table to fix that. The vacuity guard was not moved
  with it.
- **One law has no guard on its derived set at all.**
  `packages/web/src/theme/category.test.ts:40` derives `THEMES = themesOf(THEME)` and drives
  **two** `describe.each` blocks off it (`:90`, `:276`). `THEMES` is asserted nowhere in the
  file. Worse, `:41`'s `THEMES[0]?.tokens ?? new Map()` means an empty list degrades
  **silently** rather than throwing — so the file would not even fail by accident.
- **Self-referential guards are the most convincing and the least load-bearing.**
  `packages/core/src/eras/eras.test.ts:29` floors `ERA_CORPUS.length`, and `:37` compares the
  corpus to `ERAS` — the registry the corpus is built from. Both shrink together.
- **The class is wide, not a one-off.** #602 records **9 Tier-1** laws (derived set drives
  cases) and a **Tier-2** family of ~18 grep-sweep laws whose derived list is looped inside a
  single `it`. Tier-1 entries verified by reading the tree at `6ad1b5cf`; three were re-read
  by hand, the rest are REASONED from their quoted guards and each wants its own mutation.

## Success

1. **Every Tier-1 law's derived set is pinned, so the set shrinking reddens.**
   *Not met while* any Tier-1 law's only vacuity guard measures its source, its fixtures, or a
   second derivation from the same bytes.
2. **Each pin was chosen, not applied.** The list-versus-count decision is made per law, with
   the rejected option named in the test.
   *Not met while* any entry carries a pin whose test does not say what the alternative was and
   why it lost.
3. **Every fix carries the mutation that proves it.** A name is dropped from the derivation —
   counts untouched — and the law reddens.
   *Not met while* any entry lands on a green suite with no executed shrink mutation recorded.
4. **The Tier-2 family has a stated verdict, fixed or ruled out as a class.**
   *Not met while* Tier-2 is neither addressed nor has a written ruling saying why a source-side
   floor is sufficient for a sweep that removes no case.
5. **A reader can tell a discharged guard from an absent one.** Wherever a law is left with a
   source-side guard on purpose, the reason is in the file.
   *Not met while* any law in the inventory is left unchanged and unexplained.

## Non-goals

- **Not a blanket ban on `toBeGreaterThan`.** A floor is the right guard for a genuinely
  open-ended set; it is wrong only as the *sole* guard on a set that drives cases.
- **Not a new shared helper or test framework.** Each law's derivation has a different shape,
  and a helper that flattens them would be a second derivation nobody reads — the exact failure
  mode in `eras.test.ts`.
- **Not `.swarm/coupling.txt`'s law.** `packages/server/src/coupling-registry-law.test.ts` is
  **prd-54's territory** — that PRD names `coupling.txt` throughout and has open work (#594,
  wave 6). This PRD records the finding and refuses the file.
- **Not the gate's load probe.** A suite that reddens under concurrency is prd-59's problem.
  This PRD is the opposite failure: a suite that stays green having checked less.

**Rejected alternatives.** *One sweeping law that finds this shape automatically* — it would
have to recognise "derives a list" across regex sweeps, globs, live tables and fixture
directories, and a predicate that broad cannot be decided; a law that cannot decide its own
predicate gets weakened until it passes (the ruling #598 made for the same reason, landed
`95e8bf3c`). *Fix them all in one commit* — nine laws is nine rulings about how to pin nine
different derivations; one diff would bury each decision and make the mutations unreviewable.
*Leave Tier-2 alone silently* — its consequence genuinely is smaller, but "smaller" is a
verdict, and an unwritten verdict is indistinguishable from an oversight.

## What already exists (do not rebuild)

- **The worked example.** `packages/team/deploy/init.test.ts`'s `SERVE_READS_PINNED` (landed
  `83ce0e65`) is this PRD's pattern in full: a hand-typed sorted list, a `toEqual`, the prior
  guards retained rather than traded, and the cost of the choice written into the test as the
  feature.
- **The inventory.** #602 carries the Tier-1 table with every guard quoted, and the Tier-2
  list. Do not re-sweep; extend it.
- **The mutation shape.** Drop one name from the derivation, leave every count untouched, run
  the file. That is the only mutation that distinguishes this defect from a healthy law.

## Rulings

## Ruling 1 — a law that drives cases off a derived set pins that set

A vacuity guard that measures anything other than the derived set itself does not discharge
this. The pin may be the sorted list or the count, but it is on the **output** of the
derivation, not on its input, its fixtures, or a re-derivation.

*Why.* Every guard in the Evidence section is true, passes, and catches nothing, because each
measures a quantity that does not move when a case disappears. The only quantity that moves is
the set.

*How far it extends.* Tier-1 as inventoried at #602 — laws whose derived set generates cases.
It does not reach a derived list used only to look something up.

## Ruling 2 — the list and the count are a per-law decision, and the loser is named in the test

Neither is correct in general. A sorted-list pin catches a rename that a count cannot (#596,
EXECUTED) but must be edited deliberately on every legitimate addition; a count does not say
which name went. Whichever is chosen, the test says what the other was and why it lost.

*Why.* Nine laws is nine derivations with different growth rates. A rule that picked one for
all of them would be wrong somewhere, and the maintainer who hits that case deletes the pin
rather than arguing with a PRD.

*How far it extends.* Every entry fixed under Ruling 1. It is a documentation requirement on
the test, not a review gate.

## Ruling 3 — no entry lands without the shrink mutation executed

Planted by removing one member from the derivation with every count left untouched, and
recorded with its red.

*Why.* This is the one defect where the passing suite is the symptom. A fix asserted rather
than executed is the same claim the broken guard was already making.

*How far it extends.* Tier-1 entries. Tier-2, if fixed, inherits it; if ruled out, Ruling 4
applies instead.

## Ruling 4 — Tier-2 gets a written verdict, not silence

The grep-sweep family loops its derived list inside a single `it` and asserts `toEqual([])`,
so a shrinking list weakens the sweep without removing a case. That may be acceptable. It is
acceptable **only once written down**, in the files or in a design note, with the reason.

*Why.* "We looked and decided it was fine" and "we did not look" are indistinguishable a month
later, and this repo has the scar: a rule stated in `AGENTS.md` read as enforced for months
while `cmd_orphans` checked a different question and printed success.

*How far it extends.* The ~18 Tier-2 laws at #602. One verdict may cover all of them.

## Sequencing (waves, each gated as ever)

`packages/server/src/coupling-registry-law.test.ts` is **prd-54's territory**; no wave of this
PRD enters it, and the finding is recorded at #602 for that PRD to consume. `scripts/gate.sh`
and the suite's behaviour under concurrency are **prd-59's**; no wave here changes a timing
marker or a worker count. Every wave consumes the pattern established by `83ce0e65`
(`SERVE_READS_PINNED`) and follows it.

**Wave 1 — the Keystone.** `prd60 w1: the strongest derived-list law pins its own table`.
`packages/server/src/collectors/otel/harness-profiles.test.ts` alone. Additive, zero-claimant,
and chosen first because it is the entry that has already rotted once: its fix is the reference
every later wave cites, and its mutation is the one that proves the class is real rather than
theoretical.

**Wave 2 — Parallel, fenced apart:** `prd60 w2: the theme laws pin the set they iterate`
(`packages/web/src/theme/category.test.ts` — the entry with no guard at all, including the
silent `?? new Map()` degradation) · `prd60 w2: the contrast law stops comparing a derivation
to itself` (`packages/web/src/theme/contrast.test.ts`) · `prd60 w2: the era corpus reddens when
an era leaves it` (`packages/core/src/eras/eras.test.ts`) · `prd60 w2: the app menu pins its
routes` (`packages/app/src/host/app-menu.test.ts`).

**Wave 3 — Parallel, fenced apart:** `prd60 w3: the parser agreement law pins both its axes`
(`packages/server/src/comparisons/parser-agreement-law.test.ts`) · `prd60 w3: the lab's parser
agreement mirror pins both its axes` (`packages/web/src/lab/compare/parser-agreement-law.test.ts`)
· `prd60 w3: the tide purity law pins the module set it globs`
(`packages/web/src/tide/purity.test.ts`). Held back from wave 2 only because the two
parser-agreement files are mirrors and their rulings should be made together rather than
raced.

**Wave 4 — the verdict.** `prd60 w4: the grep-sweep family's source-side floor is ruled on, not
assumed`. Ruling 4's written outcome, and any fix it calls for. Last because it is a sweep over
~18 files, and a sweep that runs before the Tier-1 waves re-lays ground they are about to dig.

**Unfiled work implied, described not numbered:** whether the Tier-1 inventory is complete — it
was produced by one systematic sweep, three entries re-read by hand and the rest REASONED, so a
tenth entry is likelier than not; and whether `packages/app/src/host/bridge-law.test.ts`, noted
at #602 as mitigated by a cross-derivation, belongs in Tier-1 after all.

## Open questions

- **Does a pinned sorted list want a stable collation?** #596's pin is hand-sorted under default
  lexicographic order, where `_` sorts after uppercase letters — so a future `..._APPX` sorts
  before `..._APP_ID` and a maintainer adding a name in the obvious place gets a red whose diff
  shows the same elements in two orders. It still reddens and the fix is visible. Pinning a
  custom collation is a second decision. **Open, not ruled.**
- **Should a tenth entry found mid-programme join a wave or wait?** The inventory is explicitly
  incomplete. **Open, not ruled.**
- **Is `.windows-known-failures` the same shape one level up?** It is a derived-ish list whose
  membership is measured at a point in time, and a file absent from it may be absent because it
  did not exist when the list was measured — observed on `doctor.test.ts` during #592.
  **Open, not ruled.**
