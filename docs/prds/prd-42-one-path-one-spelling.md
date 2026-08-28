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

  > **SUPERSEDED** by the wave-9-and-Success-1 amendment below (verification of
  > wave 7, 2026-08-28): `#47` and `#124` closed the gap; encoder and walk are
  > now byte-identical. Left in place, not deleted, so citations to this
  > paragraph keep resolving.
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

> **SUPERSEDED** by "Amendment — waves 5 and 6 reconciled, three issues become
> two" below (grooming,
> 2026-08-26): `#47` and `#52` merge into one issue. Left in place, not
> deleted, so citations to this paragraph keep resolving.

**Wave 6 — the law's escape hatch.** `#52`. After wave 5, not beside it: it
moves or re-authorises the round-trip law living in a file `#47` claims.

> **SUPERSEDED** by "Amendment — waves 5 and 6 reconciled, three issues become
> two" below (grooming,
> 2026-08-26): `#52` is closed as superseded by `#47`, which absorbs its work.
> Left in place, not deleted, so citations to this paragraph keep resolving.

**Wave 7 — the tidy-ups, last.** `#53`. It touches `recorder/rotate.ts`,
`server/static.ts` and `worktree-slug.test.ts` — three other issues' territory.
Sweep-shaped work comes last by the corpus's own rule, and this is sweep-shaped
even though it is small.

> **SUPERSEDED** by "Amendment — waves 5 and 6 reconciled, three issues become
> two" below (grooming, 2026-08-26): `#53` becomes wave 6 there, as that
> amendment's own text records (*"formerly wave 7"*). The number 7 is since held
> by a different, landed wave — `#120` and `#124`, merged as PR `#144` — so this
> paragraph left unmarked reads as a live claim on a number that now means
> something else. Left in place, not deleted, so citations to this paragraph
> keep resolving.

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

## Amendment — wave 9, and Success 1 closes (verification of wave 7, 2026-08-28)

> **Blessed** — gabriel-canaan, 2026-08-28, in session. Ruling 7 and wave 9 only.
> Rulings 1–6 and waves 1–8 are neither renumbered nor rewritten.

**Success 1 is now met, and this supersedes the "not met" finding at :186-192.**
That paragraph was true when written: encoder and walk disagreed on a colon and a
backslash. `#47` closed those two and `#124` closed the rest — both sides are now
byte-identical `/[^a-zA-Z0-9]/g`. The premise is no longer quoted but EXECUTED:
`grep -ao` on the shipped ELF (version **2.1.247**, the version actually read at
verification) returns

```
function B(e){return e.replace(/[^a-zA-Z0-9]/g,"-")}
function J(e){let n=B(e);if(n.length<=v)return n;return`${n.slice(0,v)}-${tn(e)}`}
function L(e){return g(k(),G(e))}          // G = override ?? J,  v = 200
```

CONTROL: the same grep with `[^a-zA-Z0-8]` returns 0 hits. `L` proves the project
directory name is the **capped** slug, so the length cap `#124` leaves
unimplemented is a real, named gap rather than a suspicion — and it fails in the
safe direction, minting a slug that resolves to nothing rather than to something
wrong (EXECUTED: a 245-character path yields a 245-character uncapped slug —
the transform is one dash per character, so length passes through, where the
shipped slugger writes `slice(0, 200)` plus a base36 hash).

**Success 3 remains as amended by ruling 5.** Nothing here touches it.

## Ruling 7 — an ambiguous slug is decided by evidence, and refused when there is none

Where two or more real paths encode to one slug, the walk **reads the answer
rather than guessing it**: the transcript under that slug records its own `cwd`
(measured on `#142`'s filing, against a real session log: 940 of 1252 records
carry a `cwd`, holding the absolute path). When that cwd is one of the
candidates, it IS the answer. When it is absent, unreadable, or names none of
them, the walk **refuses** with a reason naming every candidate.

Why: `repos.ts:188-197` already states that a silent pick would be "a wrong answer
with no sign it was ever in doubt, which is the one thing this module's whole
contract refuses to do". That promise was kept for a **tie at the longest match**
and not for candidates of different lengths, each leading somewhere real —
EXECUTED, and reachable with no punctuation this PRD widened:

```
/repo/packages/web   ─┐
                      ├─ both encode to  -repo-packages-web
/repo/packages-web   ─┘        walk returns /repo/packages-web, silently
```

**This is pre-existing, not wave 7's doing** — proven by regressing the walk to
its pre-`#120` five-character class, where the same shape answers silently too
(`/repo/a.b/c` vs `/repo/a.b-c`). What `#120` widened is the set of characters
able to REACH it, which is the "boundary moved, not only narrowed" shape this PRD
already records for `#47`. `#120`'s done-when is therefore scoped to
**same-segment** collisions, in the issue and in its commit body, rather than left
as an unmet bullet.

*Rejected alternative — keep preferring the longest.* It is the silent wrong
answer the module's own contract disowns.

*Rejected alternative — refuse without consulting the transcript.* Honest, but it
hides a path that is knowable and charges the repo picker for a case the evidence
settles. Refusal is the fallback, not the rule.

Extent: the walk only. It licenses no change to the encoder, and none to
`paths/containment.ts`, which this PRD consumes and never edits.

### Sequencing amendment — wave 7, as it actually shipped

**Wave 7 — the transform means one thing on both sides.** `#120` (the reverse
walk fails closed over the real slug grammar) and `#124` (the forward transform
mints the slug Claude Code actually mints), merged together as PR `#144`.

This is recorded because the number was previously spoken for by `#53`'s
paragraph above, which the waves-5-and-6 reconciliation had already renumbered to
wave 6 without marking the paragraph. Until that marker was added the document
declared wave 7 exactly once — accurately by count, and about the wrong issue, so
the reconciler's duplicate check could not see it. The marker and this
declaration are one edit: marking the stale paragraph alone would have left the
wave that actually landed undeclared.

### Sequencing amendment — wave 9

**Wave 9 — parallel, fenced apart, after wave 7 lands.**

- `prd42 w9: an ambiguous slug is decided by the transcript's own cwd, not by
  guessing` (`#142`) — `concierge/repos.ts`, its test, a new
  `concierge/slug-disambiguate.ts` and its test, `.swarm/coupling.txt`. The
  transcript read lands in a new named file rather than importing across the
  `log/` boundary; that widening is declared on the issue.
- `prd42 w9: the forward-transform law sees the negated-class shape` (`#143`) —
  `collectors/sessionlog/forward-transform-law.test.ts` only.

```
$ scripts/fence-lint.sh 142 143
fence lint PASSED
```

**Both follow wave 7.** Each claims a file PR `#144` is amending — a live fence,
and bundling across one is forbidden.

`#143` carries a finding worth reading before anyone starts it: **the obvious
one-line fix is a no-op.** Deleting the negated-class exclusions at
`forward-transform-law.test.ts:393`/`:401` leaves the law green *and* leaves a
verbatim copy of the canonical transform undetected, because the next guard
(`!body.includes('/')`) filters negated classes one line later. Recorded because
the wrong repair is cheap to try and looks exactly like a working one.

### A third housekeeping correction the reconciler found

`#92` sits in this milestone with no wave. It is closed as superseded by `#87`
(whose fence absorbed it) and is not dispatchable work; said here so
fence-lint's blind spot and the board's orphan check do not each report it as an
open question. The waves-5-and-6 double declarations the reconciler also found
are marked superseded in place above, at the paragraphs themselves, each
citing the amendment that supersedes it by HEADING rather than by line number —
a line citation in an append-only document is falsified by the next amendment
that inserts above it, which is what happened to this one's first revision.

Nothing above renumbers a ruling or an earlier wave. Wave 9 is a number nothing
else has used.
