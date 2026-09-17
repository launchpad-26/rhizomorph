# What "this exclusion is doing real work" may assert

**Decided 2026-09-17.** Cited from the excluded-directory guard in
`packages/server/src/doc-citation-law.test.ts`.

## The rule

**An exclusion is justified by what the excluded thing IS, not by what it currently
contains.** A guard proving an exclusion is load-bearing therefore asserts that the sweep
still *reaches* the excluded directory and that the exclusion is what *removes* it — never
that the directory currently absorbs a violation.

## Why, and it is not a preference

The citation ceiling law excludes three dated-artefact directories as *citing* sources:
`docs/research/`, `docs/review/`, `docs/prds/`. A record of what a tree looked like on a
date is not a live claim about the tree, so its `#NNN` citations are not swept.

Its vacuity guard used to assert that each of those directories would trip the detector if
scanned — `ceilingViolationsIn(...).length > 0`. That premise is not stable, because the
thing it measures against moves on its own:

- `liveMaximum()` rises whenever a **newly highest-numbered PR** merges. It is a
  `Math.max` over the `Merge pull request #N` subjects on `origin/main` since the tracker
  reset — so a later merge of a *lower*-numbered PR leaves it unchanged. It only ever
  rises, never falls.
- `docs/review/` is a dated artefact. It does **not** grow. Its highest citation is `#579`.

So the guard held only while the ceiling stayed below 579, and had to fail the moment the
tracker passed it. It did, on 2026-09-17, when **PR #582** merged. EXECUTED from inside the
law, against the same corpus, at the ceiling's value before and after that merge:

```
live=582   at574=1   at582=0
```

One violation at the old ceiling, none at the new one. Nothing about the exclusion, the
directory or the sweep changed — only the number the corpus was being compared against.
`main` went red with no commit and no edit, which is the failure mode this law's own
docblock already rejects `gh` for: *"A law that reddens on other people's activity is not a
law."* The guard had reproduced it one level up.

**And it is permanent, not a blip.** The ceiling only ever rises, so once past 579 the old
assertion could never be true again without someone writing a new review document citing a
number higher than the live tracker — which is itself the violation the law exists to
prevent.

## Why the pattern looked right when it was written

The sibling guard in the same file, for the *path*-citation law, is the same shape and is
correct: a broken path citation does not depend on a climbing number, so "would this
directory trip if scanned" has a stable answer there. The ceiling law borrowed a working
pattern into a place where its premise does not hold. That is worth naming, because the
borrowed form reads as more rigorous than what replaced it.

## What is asserted instead

Per excluded directory:

1. the sweep's **own** file pattern reaches at least one tracked file under it — so a
   renamed or deleted directory, or a sweep narrowed until it no longer sees one, still
   fails; and
2. none of those files survives into the swept set — so an exclusion that is declared but
   no longer wired still fails; and
3. the detector returns a violation for a **synthetic** entry under that prefix — a `#2`
   citation against a ceiling of `1`, which is a violation under any correct detector
   regardless of where the live ceiling has climbed to.

Clauses 1 and 2 together say deleting the entry would widen the swept set. Clause 3 exists
because they do not say everything the old form said, and an earlier draft of this note
claimed they did. **EXECUTED during review: making `ceilingViolationsIn` skip
`docs/research/` entries left clauses 1 and 2 green at 75/75, while the old form went red.**
The old form ran the detector over each excluded directory's real files, so a detector blind
to one excluded prefix reddened it; reachability never calls the detector at all.

Clause 3 restores that reach without restoring the rot, by supplying its own input and its
own ceiling instead of reading the corpus. The guard still does **not** assert that a
violation is currently absorbed — that is the property proven unstable above.

## Falsifier

If an exclusion is ever added for a directory that the sweep does not reach — excluded for
some reason other than "the sweep would otherwise take it" — then clause 1 fails a correct
exclusion, and this note is what gets amended, not the guard. No such exclusion exists
today; all three are directories the `*.md` sweep reaches.

## What this note does not decide

Whether the three-digit numbers in `docs/research/` that clause 1's predecessor counted as
citations are citations at all. Several exceed the ceiling by thousands and look like line
numbers or colour values rather than issue references, which means the old guard may have
been passing there for a reason nobody intended. Out of scope for the change that decided
this rule, and recorded so the
next reader does not mistake it for settled.

## Why this note cites no issue number

`AGENTS.md` says it plainly — *"Cite a SHA, not an issue number, in anything written from
here on"* — and the ceiling law enforces the consequence here in a way worth recording,
because it caught this note: a tracked document may not cite an issue whose number exceeds
the highest **merged PR**. A freshly filed issue always does, so no tracked doc can reference
recent work by number until enough PRs have landed to lift the ceiling past it. That is the
law behaving correctly on a citation that is neither a typo nor a prior-tracker number, and
it is why this note's provenance lives in the commit that introduced it and in the PRD.
