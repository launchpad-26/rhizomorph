# What "this exclusion is doing real work" may assert

**Decided 2026-09-17 (#583).** Cited from the excluded-directory guard in
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

- `liveMaximum()` climbs with **every merged PR**. It is derived from
  `Merge pull request #N` subjects on `origin/main` since the tracker reset.
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

**And it is permanent, not a blip.** Every future merge raises the ceiling further above
579, so the old assertion could never be true again without someone writing a new review
document citing a number higher than the live tracker — which is itself the violation the
law exists to prevent.

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
   no longer wired still fails.

Together: deleting the entry would widen the swept set. That is the durable half of the
original question, and both halves fail for reasons that do not move on their own.

The guard deliberately does **not** assert that a violation is currently absorbed. The
detector's own non-vacuity is already proven against a rigged in-memory corpus in the
`ceilingViolationsIn` test, which supplies its own input and so cannot rot.

## Falsifier

If an exclusion is ever added for a directory that the sweep does not reach — excluded for
some reason other than "the sweep would otherwise take it" — then clause 1 fails a correct
exclusion, and this note is what gets amended, not the guard. No such exclusion exists
today; all three are directories the `*.md` sweep reaches.

## What this note does not decide

Whether the three-digit numbers in `docs/research/` that clause 1's predecessor counted as
citations are citations at all. Several exceed the ceiling by thousands and look like line
numbers or colour values rather than issue references, which means the old guard may have
been passing there for a reason nobody intended. Out of scope for #583 and recorded so the
next reader does not mistake it for settled.
