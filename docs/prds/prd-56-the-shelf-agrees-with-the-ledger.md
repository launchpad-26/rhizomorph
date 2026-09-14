# prd-56 — the shelf agrees with the ledger: a PRD's location is a status claim, and nothing checks it

> **Status:** **BLESSED** — Gabe, 2026-09-11, in session. Milestone `prd56`.
> Drafted 2026-09-10 from a finding in `#416`, which misread a complete PRD as
> live and nearly edited its prose; rulings 1 and 2's two open choices were put
> to the operator and decided before blessing. Sequenced after `#416` lands,
> because two of the files a move must update are in its fence.

## Problem

Where a PRD file sits is read as a claim about whether its rulings are live.
Nothing keeps that claim in step with the tracker, so a PRD can finish and
leave its file on the wrong shelf indefinitely — and a reader, or a sweep,
takes the shelf at its word. Five are in that state today. The same drift was
cleaned once already, at nine files, and came back within three weeks.

The cost is not tidiness. It is that a stale location makes a *finished*
ruling look open, so work gets planned against it and prose gets edited that
should have been left as a record.

## Evidence

- **Five PRDs have closed milestones and unarchived files.** `prd-25`,
  `prd-27`, `prd-43`, `prd-50`, `prd-52` — all under `docs/prds/`, all with
  `state=closed` milestones (`gh api repos/:owner/:repo/milestones?state=all`).
  Closed between 2026-09-07 and 2026-09-08.
- **A location is reasoned FROM, not just stored.** `docs/follow-up-292.md`
  argues that prd-17's ruling 3 "lives in `docs/prds/`, not `docs/prds/done/`,
  so by this repo's own convention it is a live ruling rather than an archival
  one" — and holds an open work item on that basis.
- **It already misled a live sweep.** `#416`'s enumeration classified
  `prd-43` as a current document because of its path, and a fence was widened
  to edit its prose before the milestone was checked. Both were withdrawn; the
  finding is recorded on that issue.
- **No law reads milestone state.** `doc-citation-law.test.ts`,
  `manifest-law.test.ts` and `route-class-law.test.ts` all read `docs/prds`
  and none of them mentions `milestone` (0 hits each).
- **The drift recurs.** `docs/prds/reconciliation-2026-08-22.md:16` records
  nine PRDs moved to `done/` in one batch. Three weeks later there are five.
- **A move breaks citations if done alone.** `AGENTS.md`,
  `docs/architecture.md`, `docs/roadmap.md`,
  `docs/prds/prd-30-the-open-hand.md` and `docs/prds/prd-51-the-split.md` cite
  the five paths. prd-17's own attempted move reddened the citation law for
  exactly this reason.

## Success

1. **A finished PRD's file is on the archival shelf, or says why not.**
   *Not met while* a PRD with a closed milestone sits outside
   `docs/prds/done/` with no declared reason and nothing red.
2. **Moving a PRD never leaves a dead citation.** *Not met while* the citation
   law is red after a move, or a citer still names the old path.
3. **The five adrift today are resolved.** *Not met while* any of `prd-25`,
   `prd-27`, `prd-43`, `prd-50`, `prd-52` sits under `docs/prds/` without
   either being moved or carrying a declared reason.

## Non-goals

- **Not a rule about when a PRD ships.** Closing a milestone stays the
  operator's act; this PRD only makes the file agree with it afterwards.
- **No change to append-only discipline.** A moved PRD's text is not
  rewritten, and its ruling citations must keep resolving.
- **Not a verdict on prd-17's own move.** It has a stated reason to stay
  (Evidence 2), which is precisely the case ruling 2 exists for.
- **No new directory, and no third state.** Two shelves, `docs/prds/` and
  `docs/prds/done/`; `parked/` already exists and is out of scope.

**Rejected alternatives.** *A periodic tidy* — this is the third one; the
2026-08-22 batch moved nine and five came back, so a habit is not the fix.
*Deriving liveness from the milestone at read time and leaving files
anywhere* — loses the property Evidence 2 depends on, that a reader can tell
a record from a description without the tracker. *Moving on milestone close,
automatically* — a move is a content change that must update citers, so it
cannot be a side effect of closing an issue.

## What already exists (do not rebuild)

- `packages/server/src/doc-citation-law.test.ts` — already proves every cited
  path exists, and is what goes red on an un-updated move. The new check is a
  sibling of it, not a replacement.
- `docs/prds/reconciliation-2026-08-22.md` — the precedent for a batch move,
  including its wording.
- `scripts/dev/prd-reconcile.sh` — already reads the trunk and compares a PRD
  against the tracker. It answers waves-versus-issues; location is the axis it
  does not cover.

## Rulings

## Ruling 1 — location is derived from milestone state, and a law says so

A PRD whose milestone is closed belongs under `docs/prds/done/`. The check is
a law in the suite, not a habit: it fails naming each file on the wrong shelf.
Path, filename and header conventions are all rejected as the source of
truth — they are what drifted, and a header can be left untouched when a
milestone closes, which is the same drift in a different field.

**Milestone state reaches the law through a COMMITTED MANIFEST, not a live API
call** (operator-decided 2026-09-11). The suite must run offline: this repo's
own sibling law derives tracker facts from `git log` against `origin/main`
rather than from `gh`, CI runs the suite on ten legs, and a review seat this
week could not run it at all because its sandbox denied `spawnSync` and
loopback. A law that needs a token is a law that is skipped.

The cost is named rather than hidden: **the manifest can itself go stale**, so
the drift moves up a level instead of vanishing. That is the open question
below, and it is the one thing wave 1 must not hand-wave.

**A PRD with no milestone is out of scope, not a violation** (operator-decided
2026-09-11). Exactly one is in that state and it is not obviously wrong;
convicting it would make this law's first act a false positive, which is how a
law teaches people to override it.

## Ruling 2 — a declared reason is a lawful exemption, and it lives in the file

A finished PRD may stay unarchived when its own text says why, in a form the
law reads. Without this the law would force prd-17's move against a live
argument (Evidence 2), and a law that convicts a correct state is one people
learn to override. The reason is prose the operator writes; the law only
requires that it exists and is findable.

## Ruling 3 — a move and its citers are one commit

Every citation of the old path is updated in the same commit as the move.
Never a follow-up: the citation law is red in between, and a red gate that is
someone else's follow-up is how a repo learns to ignore it.

## Sequencing (waves, each gated as ever)

`docs/prds/prd-17-complete-record.md`, `docs/roadmap.md` and
`docs/architecture.md` are `#416`'s territory until it lands; no wave here
starts before it does. Every wave consumes ruling 1's definition of "finished".

**Wave 1 — the keystone, and it is a STACK in one issue.** `prd56 w1: a
finished PRD sits on the archival shelf, and a law says so`. Ruling 1's law
would convict all five files this PRD cites as evidence, so the law and the
fix cannot be separate waves — the law could not be green the day it landed.
One issue, landed in commit order: **first** the five moves with their citers
updated in the same commit (ruling 3), **then** the law that can now be green.
Fence: the five PRD paths (ten, since a rename audits as both), their five
citers, the manifest, its generator, and the new law's file.

**Wave 2 — the exemption.** `prd56 w2: an unarchived finished PRD states its
reason, and the law reads it`. Ruling 2's form, and prd-17 as its first
subject once `#416` has landed. Separate from wave 1 because wave 1's five
have no reason to declare — they are simply on the wrong shelf.

**Wave 3 — the reader tells prose from code.** `prd56 w3: the exemption reader
tells prose from code in every Markdown context`. Added 2026-09-14, after wave 2
shipped; this section is amended rather than rewritten, and waves 1 and 2 stand
as written. Wave 2's fix re-review found four edges where ruling 2's reader
disagrees with what a person reading the rendered document sees — a fence
indented one to three spaces, an indented-code line inside a blockquote, a
continuation line carrying quoted code toward the substance threshold, and a
comment opener that is itself inside a code span. Three fail open and one fails
closed. None is reachable by any file in the tree today, which is why wave 2 was
not held for them.

It is a wave rather than an unfiled residual because ruling 2 already governs it:
the reader is required to read a reason a human can find, and these are the cases
where it does not. It is separate from wave 2 because wave 2's own review is what
discovered them — they could not have been known when it was groomed.

**They are one repair, not four.** Each is a cell of one table: which lines of a
PRD are prose, and which are code. The wave is done when a single predicate
answers that, applied to declaration and continuation lines alike — not when four
spellings are patched. A cell-by-cell fix is what this wave exists to avoid, and
the review that found them says so in terms.

**Unfiled work implied, described not numbered:** whether `docs/prds/parked/`
needs the same agreement, and whether `docs/design/` and `docs/review/` want
any location rule at all. Neither is booked; both are outside ruling 1.

## Open questions

- **What stops the manifest itself drifting?** Ruling 1 moves the trust from a
  file's path to a committed file, which can be as stale as the thing it
  replaced. The candidates: regenerate it in CI and fail if the regeneration
  would change it (catches drift within one CI cycle, needs a token in ONE job
  rather than in the suite); or a dated staleness bound that fails when the
  manifest is older than some age (offline, but bounds lateness instead of
  preventing it). Wave 1 must choose and say why. **Open, not ruled.**
- Should the law also fail an ARCHIVED PRD whose milestone is still open — the
  mirror case? No instance exists today, so ruling 1 is written one-way.
  **Open, not ruled.**
