# prd-52 — the annotated citation: provenance is written, not inferred from a number

> **Status:** proposed — drafted 2026-09-04 against `main` at `fcbe2f1`, from the verify pass on
> prd-43 wave 7's `#261` (`.git/fix-rereview-w7/`, two independent seats). Takes one question
> prd-43 measured and did not resolve. Successor to `#261`'s mechanism, not to prd-43: it cites
> prd-43's own measurement rather than restating it, and prd-43 keeps its territory.

## Problem

This repo's tracker was deleted and restarted at `#1` on 2026-08-21. The `docs/` corpus cites both
sequences, and they overlap: the live tracker is in the high 260s and climbing daily, while
citations into the deleted tracker reach into the six hundreds. Nothing in a bare `#267` says which
tracker it means.

prd-43 measured exactly this and wrote it down — *"the two sequences overlap and no numeric
threshold separates them"* — and then wave 7 built a law on a numeric threshold anyway, tolerating
the 150 known collisions with a committed baseline of expected violations.

That baseline decays by construction. Each entry asserts that its citation still **exceeds** the
live maximum, so every time the live tracker climbs past a number the old one used, a row stops
being a violation and `main` goes red with no code change and nothing to review. The gap is now one
number. The cost is not theoretical: it is a law that reddens the trunk on merges unrelated to it,
and whose printed remedy, followed literally, silently widens the law it is protecting.

## Evidence

- **prd-43 already ruled the threshold cannot work.** `docs/prds/prd-43-the-claim-is-a-test.md`,
  *"Why `#261` is a separate issue"*: **"the two sequences overlap and no numeric threshold
  separates them."** The law filed under that paragraph is a numeric threshold.
- **It is already red, and it moved while nothing changed.** `expect(num).toBeGreaterThan(liveMax)`
  in `packages/server/src/doc-citation-law.test.ts`, *"every baseline entry is still a genuine
  violation"*. On `prd43-w7-wave` at `f6cd413`, unmodified tree, EXECUTED 2026-09-04: first `#267
  no longer exceeds the live maximum (268)`, then ninety minutes later the same assertion on
  `CHANGELOG.md` at 269. The git-derived maximum on `main` is **265** and the lowest baseline rows
  are `#267` and `#269` — so the runway is one number either way, and PRs `#267` and `#269` are
  open now.
- **The collisions are real and adjacent.** `docs/roadmap.md` cites `#267`, `#269`, `#270` and
  `#271` — all prior-tracker — in a single sentence. Live `#267` is prd-27's beacon collector;
  live `#269` is prd-43's own sweep-timeout PR. The same numbers, four words apart, meaning
  different things.
- **The remedy the law prints is wrong.** *"remove this baseline entry, `<file>` is fixed"* — it is
  not fixed. Removing the row makes the corpus permanently accept a citation that now resolves to
  an unrelated live artefact, the exact ambiguity `#66`'s note exists to warn about.
- **The surface is bounded and concentrated.** 150 `(file, number)` pairs across **45** tracked
  files, **212** occurrences. `CHANGELOG.md` and `docs/design/ui-2.0-progress.md` hold 86 of them
  (41%). Measured 2026-09-04 with the law's own `ISSUE_CITATION_RE`.
- **The standing convention rules the opposite, and is not yet landed.** `#66`'s note, in flight in
  wave 7: *"The citations themselves are left as they stand, here and everywhere else they
  appear."*

## Success

1. **A prior-tracker citation is distinguishable by reading it**, with no reference to any maximum.
   *Not met while* a tracked file the citation law sweeps carries a bare `#NNN` resolving to the
   deleted tracker.
2. **No assertion requires a citation to remain a violation.** *Not met while* any test asserts that
   a recorded entry still exceeds the live maximum — that is the decaying shape, in any spelling.
3. **`.citation-prior-tracker` does not exist.** *Not met while* a committed baseline of expected
   violations is needed to keep the suite green.
4. **A new bare citation above the live maximum still fails, and a run that could not check says
   so.** *Not met while* the law can be satisfied by annotating a genuinely live citation, or while
   an unavailable maximum produces a green run indistinguishable from a verified one.

## Non-goals

- **Rewriting history.** Citations are real provenance for work that happened; annotation marks
  them, it does not remove or renumber them.
- **The dated-artefact directories.** `docs/adr/`, `docs/review/`, `docs/prds/` stay outside the
  sweep, so their prior-tracker citations stay bare. Eight of the nine `#267`s in this repo are in
  `docs/prds/done/prd-21-scrub-bar.md` and are deliberately untouched.
- **Non-markdown sources.** TypeScript comments cite the old tracker too. Out of scope here.

**Rejected alternatives.** *A committed baseline* — what `#261` built; it is the decaying shape
Success 2 forbids, and its maintenance burden grows every time the tracker crosses a cited number.
*Headroom above the live maximum* — measured and unavailable: citations run 264, 265, 266 (live)
then 267, 269, 270 (prior) with no gap, so a margin of +1 stops flagging `#267`. *Date-scoped
predicates* — `#66`'s note offers the document's own date as the human tell, which is correct for a
reader and unusable for a per-citation check: a file's date does not travel with the citation when
the paragraph is copied. *Widening the git evidence* — clone-dependent, reading 266 in a clone
holding an unpushed branch and 252 in a fresh clone of origin.

## What already exists (do not rebuild)

- `ISSUE_CITATION_RE` and `extractIssueCitations` in `packages/server/src/doc-citation-law.test.ts`
  — the boundary-safe citation matcher, built to avoid the `#674c63` hex-colour false positive.
- `liveMaximum()` in the same file — still needed for Ruling 4's direction, not for a baseline.
- `#66`'s note in `AGENTS.md` — the human-facing explanation of the two sequences. Ruling 5 amends
  its last paragraph; the rest stands.
- `isExcludedCitingFile` and `isPinnedArtefact` — the established scope predicates. Reuse, do not
  re-derive.

## Rulings

## Ruling 1 — provenance is written at the citation, not inferred

A citation into the deleted tracker carries an explicit marker. A bare `#NNN` means **this** repo's
tracker and nothing else. The number alone stops being asked to carry information it never had.
Extends to every tracked file the citation law sweeps; the excluded directories are out of scope
per Non-goals.

## Ruling 2 — the marker is the prefix `PT#`

`PT#267`, not `#267 (prior tracker)`. `ISSUE_CITATION_RE`'s existing lookbehind
(`(?<![0-9A-Za-z#])`) already refuses a `#` preceded by an alphanumeric, so the annotated form is
invisible to the sweep **with no regex change** — verified 2026-09-04: `see PT#267 here` yields no
match, `see #267 here` yields `267`, `#674c63` still yields none. It is also one token, so it
survives a hard wrap where a trailing parenthetical does not. The readability cost is accepted;
rationale for the glyph belongs in `docs/design-notes/`, cited from the law.

## Ruling 3 — the baseline is deleted, not migrated

`.citation-prior-tracker` is removed in the same commit that lands the replacement law. Its 150
rows become 212 annotations at the source. A file recording expected violations is the mechanism
Success 2 and 3 exist to end; migrating it to a new format would keep it.

## Ruling 4 — the law keeps one direction, and skips loudly or not at all

A bare citation above the live maximum still fails: that is the only unambiguous case and it stays
guarded. But when the maximum cannot be obtained the test **skips with a stated reason** — `ctx.skip()`,
never a bare `return`. Measured on `#261`: a failing `gh` produced *13 passed, 0 skipped, no
reason*, with a genuine planted violation present. A check that cannot be made honest is not run;
it is never quietly run wrong.

## Ruling 5 — `#66`'s note is amended in the open

`#66`'s closing paragraph rules that citations are left as they stand. Ruling 1 reverses it. The
paragraph gets a dated superseding note in the wave that starts annotating — not a silent edit, and
not a contradiction left standing in two files.

## Sequencing (waves, each gated as ever)

`packages/server/src/doc-citation-law.test.ts` is prd-43 wave 7's territory while `#261` is open;
no wave of this PRD enters it until wave 0 completes. `AGENTS.md` is `#66`'s fence for the same
period.

**Wave 0 — operator act, not dispatchable.** `#261` leaves prd-43 wave 7, and prd-43's Sequencing
gains a dated `SUPERSEDED` marker pointing here. Wave 7 then holds `#66` and `#264`, which is what
prd-43 already declares. Nothing in this PRD dispatches until that amendment is on `main`.

**Wave 1 — the annotation sweep. Parallel, fenced apart:** `CHANGELOG.md` · `docs/design/` ·
`docs/user-guide/` and `docs/metamorphosis/` · `docs/roadmap.md` and the remaining top-level docs ·
`packages/**` markdown including the collector `CAPTURE.md` fixtures. Each issue annotates its own
files and nothing else; the fence is the file list, and the 45 files split cleanly because no two
groups share one. Landing order within the wave does not matter — no law reads the annotations yet.

**Wave 2 — the law follows the corpus.** One issue: the threshold comparison and the baseline
honesty check are replaced per Rulings 1 and 4, `.citation-prior-tracker` is deleted per Ruling 3,
and `AGENTS.md`'s note is amended per Ruling 5. Single issue rather than three because the law
cannot be green until the baseline is gone and the note cannot contradict the law for even one
commit.

The sweep precedes the law, inverting the usual *sweeps come last*. That rule exists so a sweep
does not re-lay ground a later wave digs; nothing digs this ground, and this is the only order in
which each wave is green the day it lands — shipping the law first would redden `main` for as long
as the sweep took.

**Unfiled work implied, described not numbered:** the excluded dated-artefact directories and the
TypeScript comments both carry prior-tracker citations and are named in Non-goals; whether either
is ever annotated is a later decision, not a wave of this PRD.

## Open questions

- **Whether `PT#` is eventually applied to the excluded directories.** A dated artefact making a
  historical claim arguably needs the marker more than a live document, not less. Open, not ruled.
- **Whether the live-maximum source moves back to git.** Ruling 4 keeps `liveMaximum()` without
  ruling on `gh`-versus-git; once no assertion requires an entry to *remain* a violation, a
  conservative lower bound may be sufficient and is reproducible against a past commit. Open, not
  ruled.
