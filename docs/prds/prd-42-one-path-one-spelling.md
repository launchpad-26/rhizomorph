# prd-42 — one path, one spelling: a path means the same thing everywhere it is written

> **Status:** **BLESSED** — Ciaran Slow, 2026-08-22, in session. Milestone `prd42`. Drafted the same day from the reconciled audit
> at `03df141` (findings 3, 19, 20 — untracked artefact, `.gitignore`d; the sha is the anchor). Stands on `#217`/`#228`/`#299`/`#401`, whose lesson — *a duplicated path primitive gets
> hardened in one copy and keeps the hole in the other* — is this PRD's whole thesis.

## Problem

Three seams in this tree write a path twice and let the two spellings disagree.

A worktree path is encoded to a project slug by one character class and decoded by another. The
two differ by a single character — a space — and the consequence is total: for any repo whose
path contains a space, **every transcript is invisible, forever**, and the failure is
indistinguishable from an agent that never started. That is the exact failure mode prd-19 exists
to end, arriving through the door prd-19 did not check.

A tokenless route hand-rolls a containment check that the repo already has a hardened primitive
for — the primitive that exists *because* prefix comparison was found wrong three times.

And a session-moving route names a concurrency obligation and then documents that no caller
holds it.

## Evidence

- **The encoder omits a space; the decoder includes one.**
  `collectors/sessionlog/worktree-slug.ts:34` is `worktreePath.replace(/[/_.\\:]/g, '-')` — no
  space. `concierge/repos.ts:229` is `entry.replace(/[._ ]/g, '-')` — with one. Verified by
  reading both at `03df141`.
- **The direction was established by probe, not by argument.** A real `claude -p` session started
  from a directory whose name contains a space produced a slug in which the space had become a
  dash — so Claude Code's own slugger maps it, `repos.ts` is right, and the encoder is wrong.
  (Probe run by the second audit; artefacts removed.)
- **A test pins the wrong behaviour as correct.** `worktree-slug.test.ts:65-67` asserts the
  current, space-less class.
- **Eight call sites inherit it**, including `log/transcript-attribution.ts`,
  `collectors/sessionlog/collector.ts`, `concierge/paths.ts`, `lab/checkpoint.ts`,
  `lab/restore.ts` and `cli/doctor.ts` — every one of which then looks in a directory that does
  not exist.
- **A route hand-rolls containment.** `server/static.ts:119` compares
  `requested.startsWith(root + path.sep)` on a `path.resolve`d but **uncanonicalised** path, while
  `paths/containment.ts` exports `isInside`, which canonicalises both sides through
  `realpathSync.native` precisely because `#217`/`#228`/`#299` found prefix comparison wrong.
  `static.ts` does not import it.
- **`retargetSession` declares an obligation nobody holds.** `recorder/rotate.ts:245-249` states a
  second concurrent retarget is "the caller's own boundary", where `rotateSession` keeps a
  `WeakMap` in-flight guard at `:201`. `api/retarget.ts:144-237` snapshots `from`/`to` before
  `await ctx.pollLoop?.stop()` with no mutex.
- **Its reachability is low, and that is verified rather than assumed.** No caller exists in
  `packages/web`, `packages/app` or `scripts`.

## Success

1. A repo path with a space in it finds its transcripts. **Not met while** the encoder and the
   reverse walk disagree on any character, or a round trip through both is not proven by a law.
2. Containment is decided in one place. **Not met while** any route compares path prefixes
   directly instead of through `isInside`.
3. A route that moves a session refuses to overlap with itself. **Not met while** two concurrent
   retargets can both proceed, or a retarget can interleave with a rotation.
4. The slug change is stated, not slipped. **Not met while** an on-disk naming change lands
   without the PR saying so explicitly.

## Non-goals

- **Not the slug algorithm's design.** `#243` owns whether this encoding is the right one at all.
  This PRD makes the two existing halves agree; it does not redesign either.
- **No gating of `GET /*`.** `static.ts` is the tokenless bootstrap ADR-0012 depends on and
  prd-29 ruling 1 keeps tokenless forever. Fixing its containment check must not drift into
  gating its class — the temptation is real and this non-goal exists to name it.
- **Not a migration.** A spaced-path slug has never resolved, so there is nothing on disk under
  the old spelling to move.
- **Not rotation's own semantics.** prd-16 owns the recorder's session boundary; this PRD adds a
  guard around retarget, it does not change what a rotation means.

**Rejected alternatives.** *Widening the decoder to match the encoder* — it would make both sides
agree on the wrong answer, and the probe says which side is wrong. *Case-folding `isInside` on
case-insensitive filesystems* — a real question raised by the first audit and deliberately left
alone here: it changes the primitive's meaning on two platforms and deserves its own ruling rather
than riding along with a caller migration. *Queueing overlapping retargets* — a queued retarget
writes a session into a repo the operator has already moved away from; refusing is the honest
answer.

## What already exists (do not rebuild)

- `paths/containment.ts`'s `canonicalize` and `isInside` — the sanctioned primitive, with
  `#217`/`#228`/`#299`'s hardening already in it. Nothing new is written; ruling 2 adds a caller.
  Its four existing importers are `collectors/pi/collector.ts`,
  `collectors/sessionlog/process-probe.ts`, `concierge/paths.ts` and `concierge/migrate.ts` —
  **`static.ts` is not among them**, which is the defect at `:119` and not a worked example.
  (An earlier draft of this line said `static.ts` imports it, contradicting this PRD's own
  evidence four sections up.)
- `rotateSession`'s `WeakMap` in-flight guard at `recorder/rotate.ts:201` — the shape ruling 3
  copies. Both routes should share it rather than growing two.
- `worktree-slug.test.ts` — the test exists; ruling 1 corrects its expectation and adds the round
  trip it was missing.

## Rulings

## Ruling 1 — the encoder and the reverse walk are one fact, proven by round trip

`worktree-slug.ts:34`'s character class gains the space: `/[/_.\\: ]/g`.
`worktree-slug.test.ts:65-67`'s expectations move in the same edit — a path and its encoding are
one fact written twice, and changing one without the other leaves a test that passes while no
longer testing the encoding (`AGENTS.md`'s `#649` lesson, verbatim).

The law that keeps it closed is a **round trip**, not a second table: for a generated set of paths
including spaces, dots, underscores and colons, encoding then walking back must return the
original. A law asserting the class's literal contents would pass at any wrong-but-matching pair —
which is how this survived.

## Ruling 2 — containment has one implementation, and callers import it

`static.ts:119` uses `canonicalize` + `isInside`. Its test gains a symlink inside a temp `dist`
pointing outside it, expected to be refused.

This ruling extends to any future caller: a path-containment comparison written outside
`paths/containment.ts` is a defect regardless of whether it is currently exploitable. `#401`'s
lesson is that the second copy is where the next hole lives, and low exploitability today is not
the same as correctness.

## Ruling 3 — a route that moves a session holds its own boundary

The retarget route takes the same in-flight guard `rotateSession` holds, shared rather than
duplicated. An overlapping call is refused with **409** — refuse, never queue (see the rejected
alternative).

`retargetSession`'s doc comment is corrected in the same commit: it currently names an obligation
and assigns it to a caller that does not exist, which reads as a decision and is actually a gap.

## Sequencing (waves, each gated as ever)

`collectors/sessionlog/worktree-slug.ts`, `server/static.ts`, `recorder/rotate.ts` and
`api/retarget.ts` are this PRD's territory. `paths/containment.ts` is consumed, never edited.
`api/index.ts`'s route classes are prd-29's — no wave changes one. Every wave follows prd-39
wave 1.

**Wave 1 — the Keystone.** `prd42 w1: the slug round trip is a law` — the law first, red against
today's tree. Zero-claimant; it is what proves wave 2 and it is the thing that was missing when
this shipped.

**Wave 2 — parallel, fenced apart:** `prd42 w2: a path with a space finds its transcripts`
(`worktree-slug.ts` + its test) · `prd42 w2: the served page decides containment with the shared
primitive` (`server/static.ts`) · `prd42 w2: a retarget refuses to overlap itself`
(`recorder/rotate.ts` + `api/retarget.ts`). Three lanes, no shared file.

**Wave 3 — the sweep, last.** `prd42 w3: no path prefix comparison survives outside
containment.ts` — a grep law over `packages/server/src`, run after wave 2 so it does not re-lay
ground wave 2 is digging. Sweeps come last by the corpus's own rule.

**Unfiled work implied, described not numbered:** `isInside`'s behaviour on case-insensitive
filesystems is a real open question (first audit, finding B3) and is deliberately not in scope
here. The eight call sites downstream of the slug encoder were counted, not individually tested;
if any of them caches a slug across the change, it is its own issue.

## Open questions

- **Does any tracked fixture encode a slug by hand?** If one does, ruling 1's edit must move it in
  the same commit, and a fixture whose expected bytes no longer match has stopped being evidence
  (`AGENTS.md`). Not yet enumerated. Open, not ruled.
- **Should `isInside` case-fold on macOS and Windows?** It changes the primitive's meaning on two
  platforms and interacts with prd-25's Windows leg. Open, not ruled.
- **Is 409 the right refusal for an overlapping retarget, or 423?** 409 matches the repo's
  existing vocabulary; nobody has ruled on it. — ANSWERED (wave 2 as landed, 2026-08-25): **409**.
  `#14` shipped it, in five places in `api/retarget.ts` (`:136`, `:175`, `:211`, `:225`, and the
  doc comment at `:29` describing the contract); ruling 5 then adopts the same code for the
  rotation direction rather than minting a second refusal vocabulary. 423 was never implemented
  and is not proposed.

## Amendment — the residuals (verification of waves 2–3, landed 2026-08-25)

> **Blessed** — gabriel-canaan, 2026-08-25, in session. Rulings 4–6 and waves 4–7 only;
> rulings 1–3 and waves 1–3 are merged and are neither renumbered nor rewritten.

Waves 1–3 are merged: `#12`/`#13`/`#14` in PR #54, `#15`/`#45` in PR #56. Five
defects remain **inside this PRD's own territory**, every one found by the
verification passes on those waves rather than by new work. They are recorded
here, not in a successor PRD, because the thesis and the territory are
unchanged — a path still means the same thing everywhere it is written, and
these are the places it does not.

Rulings 1–3 and waves 1–3 stand exactly as written. Nothing below renumbers or
rewrites them.

**Two of this PRD's four Success criteria have live falsifiers, and it is more
honest to say so here than to let the merged waves read as delivery:**

- **Success 1 is not met.** Its falsifier is *"the encoder and the reverse walk
  disagree on any character"*. They disagree on a **colon** and a
  **backslash** (`#47`): the encoder maps both to a dash, the reverse walk has
  never handled either, so any repo path containing one mints a slug the walk
  cannot resolve. Ruling 1's round-trip law is green only because `#12`
  asserted an *honest refusal* for the colon case instead of a round trip —
  which makes the gap a tested fact rather than a closed one.
- **Success 3 is met in one direction only.** Its falsifier includes *"a
  retarget can interleave with a rotation"*. Two concurrent retargets now
  refuse (`#14`), but a **rotation** asked during a retarget is handed the
  retarget's boundary at status 200 (`#49`) — the same input class, pointed the
  other way.

## Ruling 4 — the probe decides which side is wrong, and it runs before either fix

For any character on which the encoder and the reverse walk disagree, **neither
side may be changed until a probe has established what Claude Code's own
slugger does with it.** The probe is the one this PRD already ran for the
space: create a directory whose name contains the character, start a real
session in it, read the slug that appears under the projects root, and record
the result on the issue. The code change follows from what it says, and not
before.

Why: the space was settled by exactly this method — the slug showed a dash, so
the encoder was wrong and the walk was right. That probe tested **only** the
space. For a colon and a backslash the two possibilities carry opposite fixes:
if the slugger maps them, the reverse walk is wrong and gains both characters;
if it does not, the **encoder** is wrong and must stop mapping them. Choosing
without the probe is a coin toss with a 50% chance of hardening the wrong side,
and widening the walk to match the encoder is the rejected alternative this PRD
already names: *it would make both sides agree on the wrong answer.*

Extent: covers the colon and the backslash now (`#47`), and any character later
found to disagree. It licenses no change to `isInside`, which this PRD consumes
and never edits.

## Ruling 5 — a rotation refuses a retarget's boundary; coalescing stays rotation-to-rotation

A rotation asked while a **retarget** is in flight **refuses with 409** rather
than being handed the retarget's `Rotation`. Two concurrent **rotations** still
coalesce, unchanged.

Why: rotation's coalescing rationale (`recorder/rotate.ts:203-207`) is an
argument about *two rotations* — "two operators asking at once is ONE boundary,
not two". It does not carry to a **repo move**. Handing a rotation caller a
boundary whose `closed.reason` is `'retargeted'`, opening a session in a
different repo than they asked about, at status 200, is precisely the input
class `#14` refused in the other direction: *asked to move to B, told "moved to
A", status 200.* Same defect, same answer.

Extent: the fix belongs in the shared in-flight map learning the operation
kind, or the route learning to refuse. Route classes in `api/index.ts` remain
prd-29's territory and no wave here enters them. `recorder/rotate.test.ts:466`
currently pins this behaviour under a heading that reads as endorsement; it
becomes a named hazard.

*Rejected alternative — wait for the retarget, then rotate.* It queues, and
this PRD's own rule is **refuse, never queue**. A caller who asked to rotate a
repo that is being moved out from under them wants an error, not a delayed
success against a boundary they never asked for.

## Ruling 6 — a widening on the tokenless route is pinned by a test, in the commit that widens it

Any change to what `GET /*` will serve is **stated in the PR and pinned by a
test asserting the chosen outcome**, and the assertion is expressed through the
containment layer — never by re-adding a string comparison (ruling 2 still
holds).

Why: `#13` correctly replaced `static.ts`'s prefix comparison with the shared
primitive, and in doing so moved a path that is textually outside the dist root
but resolves inside it via a symlink from **403 to 200** — a widening nobody
asked for, on a permanently tokenless route (ADR-0012, prd-29 ruling 1). The
commit does not mention it, because it was not the change being made, and
`static.test.ts:152` pins only the sibling-*directory* case. So the behaviour is
currently whatever the primitive happens to do, and a future change to
`canonicalize` could flip it in either direction in silence.

Extent: covers `#51` now and every later containment change on that route. It
deliberately does **not** decide which outcome is right — permissive may well
be the more correct reading of canonicalized containment. It rules only that
the outcome is chosen, stated, and pinned, rather than inherited.

### Sequencing amendment — waves 4–7

Territory is unchanged: `paths/containment.ts` is consumed, never edited, and
`api/index.ts`'s route classes are prd-29's. Every wave below follows waves 1–3,
which are merged.

**Wave 4 — an operator act, then two lanes.**

*The operator act, booked and not dispatchable:* the colon-and-backslash probe
ruling 4 requires. Create directories whose names contain each character, start
a real session in each, read the slug that appears under the projects root, and
record the answer on `#47`. It is not a lane's to run — `#47` says so in its own
Blocked by, and an agent cannot be handed "start a real session on a real
machine" as a fenced code change. prd-39 booked its wave 0 the same way, for the
same reason.

*The two dispatchable lanes, parallel and fenced apart:* `prd42 w4: a rotation
refuses a retarget's boundary` (`recorder/rotate.ts` + `api/rotate.ts` + their
tests) · `prd42 w4: the served page's symlink verdict is pinned`
(`server/static.ts` + its test). No shared file — `scripts/fence-lint.sh 49 51`
PASSED with zero overlaps, 2026-08-25.

**Wave 5 — the spelling, once the probe has answered.** `#47`. It cannot join
wave 4's lanes: its first requirement is the probe's answer, and until that
exists neither direction of the fix is knowable. It cannot join wave 6 either —
it claims `worktree-slug.test.ts` and `concierge/repos.test.ts`, which wave 6
also needs.

> **SUPERSEDED (2026-08-27).** Restated by the waves 5-and-6 reconciliation
> below, which is where wave 5 is now declared: same issue, `#47`, but carrying
> `#52`'s absorbed work, and no longer blocked on the probe — that answer landed.
> The reasoning here stands and is why the absorption was necessary; only the
> scope of wave 5 moved.

**Wave 6 — the law's escape hatch.** `#52`. After wave 5, not beside it: it
moves or re-authorises the round-trip law living in a file `#47` claims.

> **SUPERSEDED (2026-08-27).** `#52` was closed as superseded and absorbed into
> `#47` by the waves 5-and-6 reconciliation below; wave 6 is now `#53`. The
> paragraph stays because its reasoning — that this work and wave 5 contend for
> the same file — is what forced the absorption, and because deleting it would
> break any citation to it. Read the wave map at the end of this document for
> the current assignment.

**Wave 7 — the tidy-ups, last.** `#53`. It touches `recorder/rotate.ts`,
`server/static.ts` and `worktree-slug.test.ts` — three other issues' territory.
Sweep-shaped work comes last by the corpus's own rule, and this is sweep-shaped
even though it is small.

> **SUPERSEDED (2026-08-27).** `#53` moved to **wave 6** in the reconciliation
> below, and wave 7 is now `#120`. The sweep-comes-last reasoning here is intact
> and still governs `#53`; only its wave number changed. This paragraph is the
> one that actually misled a reader: on 2026-08-26 an agent read it, saw the
> tracker say `w6`, and "corrected" the TRACKER to match this stale half of the
> document — the edit was reverted, but the document held two live answers and
> nothing could tell them apart. That is what the marker is for.

**Waves 5, 6 and 7 are each a single issue, and that is a cost, not a
preference.** Three waves means three PRs and three payments of the ~21 h queue
toll for three small changes. They cannot be bundled as they stand: every
pairing among `#47`, `#52` and `#53` shares at least one file. The lawful way to
collapse them is to reconcile their fences — most plausibly by deciding, once,
where the round-trip law lives, which is the question `#52` exists to answer.
That reconciliation is worth doing before wave 5 is dispatched, and is recorded
here rather than discovered at landing.

**Unfiled work implied, described not numbered:** `isInside`'s behaviour on
case-insensitive filesystems (open question 2 below, still open, and
interacting with prd-25's Windows leg); the eight call sites downstream of the
slug encoder, counted but never individually tested; and the six issue
citations in this document's own Status line and Evidence — `#217`, `#228`,
`#243`, `#299`, `#401`, `#649` — which resolve to nothing in this repository
(highest real issue: `#64`). They are references to a previous incarnation of
the tracker and are filed separately rather than silently rewritten here.

## Amendment — wave 8, the three issues verification left behind (grooming, 2026-08-26)

Wave 4's verification filed `#87`, `#91` and `#92` against territory this PRD
already owns, and none carried a wave. Unsequenced, each collided with
something. Derived, not counted by eye:

```
$ scripts/fence-lint.sh 47 49 51 52 53 87 91 92 | grep -c '^  OVERLAP'
13
```

**13** overlaps across this PRD's eight then-open issues, **6** of which set one
of the three against a wave-4-to-7 issue. Both figures are measured **before the
merge recorded below**, while `#87` still fenced one file rather than `#92`'s
three. Re-run the same command after that merge and the answers are **18** and
**9**: absorbing `#92`'s fence gave `#87` `recorder/rotate.ts` and its test,
which collide with `#49` two ways, `#53` one and `#92` two. Nothing moved; the
fence did.

That is the second time this count has moved under this paragraph. An earlier
draft recorded 15, which was also true when it was measured — `#87` was leaking
a claim on `api/rotate.test.ts` out of its prose, and de-backticking that at
dispatch removed its collisions with `#49` and `#91`. **A count derived from a
mutable tracker is not self-validating; it needs the conditions it was taken
under** — and a date is not one of them, because the tracker changed twice on
2026-08-26, the second time by this amendment's own hand.

**Wave 8 — one wave, two issues, one PR, after wave 4 lands.** Parallel, fenced
apart: `prd42 w8: the rotation-entry law sees and enforces every door` (`#87`,
`recorder/namespace-law.test.ts` + `recorder/rotate.ts` + its test) ·
`prd42 w8: the shared refusal code is one compiler-bound fact` (`#91`, `api/*`).

```
$ scripts/fence-lint.sh 87 91
fence lint PASSED
```

**`#87` and `#92` are one issue, not two.** They both edit
`recorder/namespace-law.test.ts`, which makes them a stack, and the wave
contract admits a stack in a wave only as a single issue. `#87`'s fence was a
strict subset of `#92`'s, so the merged fence is exactly `#92`'s three paths.
The lint above is over `#87` and `#91` — the two issues that will actually
dispatch — rather than over the closed `#92` whose fence they now share, so it
keeps proving the wave disjoint if either fence moves again. Both issues had
already said as much in their own words — `#92`: *"Best done with #87, whose
fix subsumes the enforcement half of this one."* `#87` derives the guarded set
from the module's exports, which covers `reserveInFlightForTest` by construction
the moment wave 4 lands it. `#92` is closed as superseded rather than sequenced
behind.

**Both must follow wave 4.** Each claims a file PR #94 is actively amending,
which is a live fence, and the working agreement forbids bundling across one.

**An earlier draft of this amendment made `#87` a wave of one that ran
immediately**, on the grounds that its single fenced file is disjoint from PR
#94's six. The disjointness was true and is not the reason it was withdrawn: a
one-issue wave pays the queue's fixed per-PR toll — ~21 h median, 81% of cycle
time — for a fraction of a wave, and "it could start sooner" is not a reason
that survives the working agreement. The operator ruled it held on 2026-08-26.
Recorded rather than quietly deleted, because the fence reasoning was sound and
the scheduling conclusion drawn from it was not; a later reader tempted by the
same argument should see how it went.

Nothing above renumbers a ruling or an earlier wave. Waves 5–7 keep their order
and their open question, and wave 8 is a number nothing else has used.

## Amendment — waves 5 and 6 reconciled, three issues become two (grooming, 2026-08-26)

Sequencing above left waves 5, 6 and 7 as one issue each and said plainly that
this was **"a cost, not a preference"**, naming the way out: *"The lawful way to
collapse them is to reconcile their fences — most plausibly by deciding, once,
where the round-trip law lives, which is the question `#52` exists to answer.
That reconciliation is worth doing before wave 5 is dispatched."* Wave 5's
blocker is now discharged — `#47`'s probe is answered — so the reconciliation
came due, and this is it.

**`#47` and `#52` are one issue, not two.** They do not merely share a file;
they contradict each other. `#47` must edit the round-trip law **in place** to
invert its colon assertion, and `#52` exists to **move that same law** out of
`collectors/sessionlog/worktree-slug.test.ts`. Sequenced apart, whichever landed
second would rewrite the other's work.

Merged, they are one coherent change: move the law to `concierge/repos.test.ts`,
fix the reverse walk's class, and write the colon/backslash round trip in its
new home. `#52`'s own "cheaper lawful route" is what makes this clean rather
than convenient — clause 1 of the concierge namespace law **skips that directory
outright**, so a law living there needs no computed specifier, no `any` cast and
no hand-copied `ReverseProjectSlugResult`. That copied type is the same defect
this PRD is named for, one layer up. `#52` is closed as superseded.

**Wave 5 — one issue.** `prd42 w5: a colon and a backslash round-trip, and the
law reaches the concierge without a dodge` (`#47`).

**Wave 6 — one issue, sequential.** `prd42 w6: four tidy-ups left by wave 2`
(`#53`, formerly wave 7). It still claims
`collectors/sessionlog/worktree-slug.test.ts`, so it cannot be wave 5's peer —
and it should not be. It is sweep-shaped work across five files in four
directories, and this corpus puts sweeps last because bundling one with a
substantive change is what makes a large PR unreviewable. The split that remains
is a judgement, where the one it replaces was a fence accident.

Net: three PRs become two. The queue's fixed per-PR toll is paid twice instead
of three times, and the remaining boundary is one somebody chose.

**One correction carried out of `#52`, and then corrected again.** An earlier
revision of this amendment said `#52`'s fence claimed `.swarm/coupling.txt`,
which is gitignored working state a lane cannot commit, and that the entry was
therefore booked on `#47` as an operator act.

**That was false, and an independent verify pass caught it before this landed.**
The file is tracked: `.gitignore` excludes the directory with a star-glob and
then negates that one file, with a comment explaining that the bare directory
form would make the negation silently inert. `git check-ignore` exits 1,
`git ls-files` lists it, and it carries commit history. A lane can commit it.

So `#52`'s fence was right and needed no carve-out. `#47` claims the path
ordinarily, and the entry lands in the same commit as the change that forces
it — which is better than the carve-out was, because `#47` moves the round-trip
law into `concierge/repos.test.ts`, the exact coupling the entry describes.
Booking it as an operator act would have stripped the entry's only enforcement
off the very wave that creates the coupling.

The withdrawn claim is recorded rather than deleted for the reason `#72` gives,
having made and retracted the identical error the same day: *"a lane physically
cannot commit this" is the kind of claim that gets believed without checking.*
It was believed twice in one session, by the same author, and propagated into a
document, two issue bodies and a close comment before anyone ran
`git check-ignore`. The lint was never at fault — it checks overlap and
vagueness, and there was nothing here to catch.

Nothing above renumbers a ruling. Wave 7 becomes wave 6 because the wave it
followed no longer exists; no wave that has been dispatched or landed is
touched, and waves 1–4 and 8 keep their numbers.

## Amendment — the wave map, stated once (bookkeeping, 2026-08-27)

**This declares no new decision.** Every assignment below was already made — by
the waves 4–7 amendment, by the waves 5-and-6 reconciliation, by the wave-8
grooming, and by filing `#120`. What was missing was one place that says what
they add up to, and the absence had a measurable cost.

**The drift.** Sequencing is append-only, which is right: ruling and wave
citations must keep resolving, so a superseded paragraph is marked rather than
deleted. But nothing marked them. This document declared **wave 6 twice** (`:296`
`#52`, and `:415` `#53`) and **wave 7 twice** (`:299` `#53`, and now `#120`), with
every paragraph reading as current. Derived, not counted by eye:

```
$ grep -oE '\*\*Wave [0-9]+' docs/prds/prd-42-one-path-one-spelling.md | sort -u
  waves 0 1 2 3 4 5 6 7 8        # with 5 and 6 each declared twice
$ gh issue list --milestone prd42 --state all --json title \
    -q '.[].title' | grep -oE 'w[0-9]+' | sort -u
  w1 w2 w3 w4 w5 w6 w7 w8        # w7 appears only because #120 now exists
```

Run before `#120` was filed, that second command returned `w1 w2 w3 w4 w5 w6 w8`
— wave 7 declared by this document and claimed by nothing. That was the drift.
The commands are given rather than their output alone because the output is a
function of a mutable tracker: a count quoted without the conditions it was taken
under is not self-validating, which this PRD has already had to record twice.

**What it cost.** On 2026-08-26 an agent read the wave-7 paragraph, saw `#53`
titled `w6` on the tracker, and edited the *tracker* to match the *stale* half of
this document. The edit was reverted within the hour by the session that had done
the reconciliation. Nobody was careless: the document contained two live answers
and offered no way to tell which was current.

### Wave 7 — the reverse walk fails closed over the real grammar

**Wave 7 — fail closed over the real slug grammar.** `#120`. After wave 6, not
beside it: it rewrites `concierge/repos.ts` and five of its doc passages, and
wave 6 is sweep-shaped work across files wave 5 has just moved. This is the
declaration for wave 7; the earlier paragraph naming `#53` is superseded above.

### The wave map, as of 2026-08-27

There is deliberately **no wave 0** here. prd-42 books its operator act — the
colon-and-backslash probe — *inside* wave 4 rather than as a separate wave, which
is why the grep above starts at 1. prd-39 and prd-46 use a wave 0 for the same
kind of act; this PRD did not, and that is a difference in bookkeeping rather
than in substance.

| wave | issue | state | declared by |
|---|---|---|---|
| 1 | `#11` | merged | original Sequencing |
| 2 | `#12` `#13` `#14` | merged (PR #54) | original Sequencing |
| 3 | `#15` `#45` | merged (PR #56) | original Sequencing |
| 4 | `#49` `#51` | merged (PR #94) | waves 4–7 amendment |
| **5** | **`#47`** (absorbed `#52`) | built, PR #121 | waves 5-and-6 reconciliation |
| **6** | **`#53`** | backlog — re-groom after wave 5 lands, which moves the law it claims | waves 5-and-6 reconciliation |
| **7** | **`#120`** | backlog — the reverse walk fails closed over the real slug grammar | this amendment |
| 8 | `#87` `#91` | built, PR #117 | wave-8 amendment |

`#52` and `#92` are closed as superseded, into `#47` and `#87` respectively.
Neither holds a wave.

### Why `#120` is wave 7 and not a successor PRD

It is this PRD's own thesis in the characters this PRD did not check — the third
time that sentence has been written here, after the space and then the colon and
backslash. The territory is unchanged, so a new PRD would fragment it. It sits
after wave 6 because it rewrites `concierge/repos.ts` and five of its doc
passages, and wave 6 is sweep-shaped work across files wave 5 has just moved.

Wave 7 also has a second half that is **not** yet an issue: the encoder needs the
same grammar, plus the 200-character cap and base36 hash suffix the real slugger
applies past it. Widening the walk without the encoder makes the repo's own
encoder-minted slugs stop reversing — harmless today, since nothing composes
encoder→walk and `reverseProjectSlug` has exactly one caller, but the two sides
should agree by decision rather than by accident. `#120`'s fence deliberately
excludes `worktree-slug.ts` for that reason.

### What stops the next drift

`prd-reconcile.sh` (operator tooling, not in this repo) reads this document
against the tracker in both directions and reports a wave declared twice, a wave
no issue claims, and an issue whose wave this document never declares. It found
all three here. Run it after any amendment that moves a wave.

**Unfiled work implied, described not numbered:** the encoder half of wave 7,
above; and the six issue citations in this document's Status line and Evidence
(`#217`, `#228`, `#243`, `#299`, `#401`, `#649`) which resolve to nothing in this
repository and are still not rewritten, because they are references to a previous
incarnation of the tracker rather than errors in this text.
