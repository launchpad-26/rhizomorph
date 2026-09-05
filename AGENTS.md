# Working in this repo

**This file is the shared runbook.** It is tracked, and it describes how *the
repo* works — not how one person's tooling behaves. Personal agent config lives
in `CLAUDE.local.md`, which stays untracked.

If you are an agent: read this in full before your first edit. Everything below
is prescriptive. Where it says *must*, a human reviewer will hold you to it.

## Your first session in this repo

Nothing to install. `git pull` delivers this file, and `CLAUDE.md` beside it
carries the `@AGENTS.md` import — **Claude Code reads `CLAUDE.md`, not
`AGENTS.md`**, so that import is the only reason a Claude session sees these
conventions at all.

One thing to check, once:

```
/context          # confirm CLAUDE.md AND AGENTS.md both appear under Memory files
```

If `AGENTS.md` is not listed, the import did not resolve and your agent is
working without any of this. Two known causes: an external-import approval
dialog declined once (it does not re-prompt), and a worktree created before
#399.

Personal notes go in `CLAUDE.local.md` — gitignored, loads automatically after
`CLAUDE.md`, and carried into new worktrees by `.workmux.yaml`. Do not put
personal content in `CLAUDE.md`; it is tracked and shared.

---

## A note on `#NNN` citations in this file

Added 2026-09-04 (#66). This repo's tracker was deleted and rebuilt from `#1`
on 2026-08-21. Numbers this file and the wider `docs/` corpus cite for work
before that date — `#399` two paragraphs down among them — point at the
tracker that no longer exists, not this one; `gh issue view` on any of them
returns nothing.

The two sequences overlap, so no single number cleanly separates old from new
— both start at 1. This repo's own sequence is in the low hundreds and climbs
daily; citations into the old tracker found in this corpus reach into the six
hundreds. Neither figure is written here on purpose: a stated maximum is stale
the moment the next issue is filed, and `packages/server/src/doc-citation-law.test.ts`
derives the live one from the tracker rather than from prose. So:

- a citation **above** the current live maximum can only be prior-tracker —
  this repo hasn't reached that number yet;
- a citation **at or below** it is ambiguous from the number alone; check the
  citing text's own date instead — anything from before 2026-08-21 predates
  this tracker regardless of what number it names;
- issues and PRs did not survive the deletion, but commits did. Cite a SHA,
  not an issue number, in anything written from here on.

The citations themselves are left as they stand, here and everywhere else
they appear: they are real provenance for work that happened, just not in a
tracker this repo still has.

## The working agreement

Adopted 2026-08-11 (#399), from measurement over the 45 PRs merged 08-09 → 08-11:

| | |
|---|---|
| Median open → **first review** | **20.9 h** |
| Median first review → merge | 4.8 h |
| **Queue share of cycle time** | **81%** |
| PRs closing exactly one issue | 34 of 45 |

The queue is a **fixed per-PR toll**. About 21 hours of waiting attaches to a PR
regardless of what is in it: `#275` (98 lines) waited 62 h, `#396` (1,235 lines)
merged in 0.5 h. PR *size* therefore cannot predict cycle time — the dominant
term is per-PR, not per-line.

Two consequences, and they are the whole agreement:

1. **Bundle.** Four issues in four PRs pay the toll four times; four issues in
   one PR pay it once. Package work by wave (below), not one issue at a time.
2. **A reviewer who cannot fix is a reviewer who stalls.** The reviewer of the
   day verifies, fixes what is small, and lands it — see [Review](#review).

Bundling only works if the bundle stays readable. That is what the commit rule
below is for: **the PR is the unit of queueing, the commit is the unit of
review.**

---

## Issues and the project board

Use `scripts/dev/issues.sh` rather than raw `gh` calls — the board carries two
fields that are easy to get wrong by hand.

```
scripts/dev/issues.sh list                    # open issues: WHEN / PRIO / TYPE / STATUS
scripts/dev/issues.sh show     <n>            # one issue: body, comments, and its board row
scripts/dev/issues.sh when     <n>... now|soon|later
scripts/dev/issues.sh priority <n>... urgent|high|medium|low
scripts/dev/issues.sh type     <n>... bug|feature|task
scripts/dev/issues.sh status   <n>... backlog|ready|in-progress|in-review|done
scripts/dev/issues.sh batch                   # '<issue> <when> <status> [priority] [type]' lines on stdin
scripts/dev/issues.sh close    <n> "reason"   # a reason is required
scripts/dev/issues.sh orphans                 # open issues off the board, or with no milestone
scripts/dev/issues.sh ids                     # field/option ids, for debugging
```

The four setters take **one or more issues, with the value last** —
`when 548 549 550 now`, never `when now 548 549`. Which argument is which is
checked rather than assumed (`split_targets` in `scripts/dev/issues.sh`): every
issue argument must be a bare number and the value must not be, so a transposed
call dies with "the value goes last, not first" instead of quietly writing
Timeline `548` onto an issue called `now`.

For a whole groomed wave, `batch` is the bulk path: it resolves the board and the
field ids **once** rather than per field per issue, does every read before the
first write (a truncated board aborts with nothing written), and one bad line
does not abandon the rest — the failures are re-listed at the end with a non-zero
exit.

`show` renders one issue's body, comments and board row in a single command.
`#362` recorded it failing through `gh`'s default issue view, which still asks
for `repository.issue.projectCards` (Projects classic); `cmd_show` passes an
explicit `--json` field list, so the query never mentions Projects classic, and
it matches the board row on the `#<n>` token rather than a fixed column that
"In progress" shifted by one.

Four things the script exists to hide, each of which cost a wrong guess once:

- **Timeline is a multi-select**, so its value goes through
  `multiSelectOptionIds` (a list). Sending the single-select shape fails with
  `argumentNotAccepted`.
- **`gh project item-list --format json` never returns multi-select values** —
  only `status`. Reading Timeline requires GraphQL.
- **Issue type (Bug/Feature/Task) is an org-level type, not a label.** It is set
  through the `updateIssue` mutation; `gh issue edit` will not do it.
- **Priority is an org-level *issue field*, not a project field and not a
  label.** The board's `Priority` column is derived from it and is read-only
  through the project API — writing there fails with "Only custom fields can be
  updated". It goes through `setIssueFieldValue`.

There are no `bug` / `enhancement` labels on issues that have a type — the type
carries it. Labels are for cross-cutting concerns the type cannot express:
`security`, `lab`, `documentation`, `tidy up`, `good first issue`.

### Naming

```
prd<NN> w<N>: <what becomes true>
```

- `prd<NN>` — the milestone the issue belongs to, matching its PRD.
- `w<N>` — the **wave**: the dependency layer within that PRD.
- The claim is present tense and states the new fact, not the activity —
  *"the retarget says what it cost"*, not *"add cost reporting to retarget"*.

Work outside a PRD uses `<area>: <what becomes true>`, e.g.
`workmux collector: listByHandle keys on basename(path)`.

Every issue must carry a milestone. `scripts/dev/issues.sh orphans` finds the
ones that do not — and finds the ones missing from the board, which is a
different fact and is reported on its own line. An issue with no milestone
belongs to no programme and appears in no burndown.

**That sentence was false from the day it was written until 2026-09-02.**
`cmd_orphans` compared open issues against board membership and never read
`milestone`, so running the named check answered a different question and then
printed a success message — the rule read as enforced while nothing enforced
it, and four issues had drifted milestone-less by the time anyone counted. The
command now does what this paragraph always claimed. Kept as a note because the
failure is the interesting part: a wrong pointer to a real command is worse
than no pointer, since it reports success.

**The one carve-out: `charter-laws`.** Every milestone this repo had was a
`prd<NN>` until 2026-09-02, which put the rule above in direct collision with the
naming convention above it: work outside a PRD is a named, legitimate category,
and there was nowhere for such an issue to be milestoned. Both rules could not
hold. `charter-laws` is where that squeeze resolves — the milestone for an issue
that **enforces a rule the design charter already states**, where the PRD that
set the rule has shipped and no live PRD claims the charter section it sits in.

Reach for it only when all three hold, and prefer a PRD when any does not. If a
live PRD owns the territory the issue is that PRD's, however awkward the fit; if
the work needs a ruling made or a new value decided, it wants a PRD of its own,
and small PRDs are ordinary: prd-49 holds a single issue and prd-50 was written
for one orphaned residual. `charter-laws` is not the escape from writing one.

`#39` is the case that opened it, and it is worth reading before reusing the
milestone: charter law 9's greyscale rule is attributed to prd-03, which has
shipped; the cap restating it sits in `docs/design/charter.md`'s §4 colour
through-line, which no live PRD claims (prd-30 is the nearest, and its status
line puts its authority at §6 and disclaims §8); and the issue's own Definition
of done says the value decision belongs in `docs/design-notes/` rather than a
PRD — so a PRD
written to give it a milestone would have contradicted the issue it was homing.
Law 9 is also the only law in the charter's table recorded as having no automated
test, so this milestone is deliberately not a programme and holds one issue. If
it ever holds a wave, that is the signal it has become a PRD and should be
written as one.

### Waves and the bundle unit

A **wave** is a set of issues that can all be built at once. Wave *N+1* may
depend on wave *N*; nothing within a wave depends on anything else in it.

> **One PR = one (milestone, wave).**

- **Never bundle across waves.** If B needs A's code to exist, they are a stack,
  not a bundle, and the stack is what the agreement is trying to avoid — resolve
  it by making them the same wave, or ship the wave in order.
- **Never bundle across a live fence.** If another lane holds a file you would
  touch, that issue belongs to a later bundle. Check before you start.
- **A bundle is not a grab-bag.** Unrelated code in one diff is what makes a
  large PR unreviewable — not its size.

Every issue declares the files it may touch (its **fence**). The gate audits it.
Widening a fence is legitimate and common; record it **on the PR before making
the change**, never after.

The gate audits a fence at *landing*, which is late: the one check that catches a
bad fence before anyone is dispatched onto it is
`scripts/fence-lint.sh <issue-number>...`, run over the whole wave. Three checks,
each learned from a real failure: a **vague** fence — one that delegates the
boundary to the worker ("touch the minimum shared surface", "if needed") — hard
fails, because the worker then edits a shared file nobody fenced and the landing
gate rejects work that was actually correct; an **overlap**, two issues claiming
the same path, hard fails, because it is a rebase conflict already scheduled; and
a **gap**, a coupling point listed in `.swarm/coupling.txt` that no fence owns,
warns, since whether any issue in this wave can reach it is a judgement call.

### What the fields mean

`Status` is where the work **is** (Backlog → Ready → In progress → In review →
Done). `Timeline` is when it should **happen**:

- **Now** — actively costing time or trust.
- **Soon** — real, evidenced pain that is not bleeding today.
- **Later** — correctly parked: gated on a ruling, large, or needs a human act.

`Priority` (Urgent / High / Medium / Low) is severity *within* a timeline — the
vocabulary is defined at org level and shared across every repo in the org, so
don't invent a parallel P0/P1/P2 scheme beside it.

All three are needed. Status alone collapses "do this next" and "correctly
parked" into one Backlog column; Timeline alone says nothing about what is in
flight; Priority alone says nothing about when.

**Assign an issue to yourself when you move it to In progress.** An unassigned
issue disappears from every assignee-filtered view of the board, so unassigned
in-progress work reads as nobody's.

### Closing an issue

Always close with a reason — the script enforces it. State what fixed it (with
the commit), or what supersedes it. An issue closed silently is a fact nobody
can recover later.

---

## Branches, commits and PRs

**Branch:** `prd<NN>-w<N>-<slug>` for a bundle, `<issue>-<slug>` for a single.

**One commit per issue.** The commit is the unit of review, so it must stand
alone: message, rationale, and the whole change for that one issue.

```
<type>(<scope>): <what becomes true>   (#<issue>)
```

`type` ∈ `feat` `fix` `test` `docs` `chore` `refactor` `perf`. A commit that
needs "and" in its subject is two commits.

**PR body must carry:**

- `Closes #a` / `Closes #b` — one line per issue in the bundle, all same wave.
- **What is the sibling case?** Nearly every real defect this repo has found is
  *a fix that correctly handles the case its author considered and misses a
  structurally identical sibling* — a seal released on a failed write but not on
  a throwing subscriber; a guarded collector-error report beside an unguarded
  snapshot-save one screen away.
- **What mutation would this test survive?** The second-worst defect shape here
  is *a test that cannot fail for the reason it claims* — `TTL - 1` and `TTL + 1`
  assertions that pass at any TTL; a test passing `refreshMs` explicitly, so it
  never exercised the default it existed to protect.
- Any **fence widening**, recorded before the change.

Both questions are cheap to answer and would have caught most of what review
caught, at authoring time.

### Opening a PR — two conditions, and no gate you run yourself is either of them

A PR is opened, undrafted or merged only when **both** are true. They are separate
conditions and each has been broken on its own:

1. **Every commit in the range has been read by an independent review pass** — the
   `verify` seats, recorded in the ledger. Check it rather than remembering it:

   ```
   ~/.claude/skills/verify/scripts/verify-ledger.sh check --strict --range <base>..<branch>
   ```

2. **The operator has asked for this specific PR, in this session.** "Do it", "go
   ahead" or "carry on" said about something else earlier is not that instruction, and
   a clean verdict is a reason to *report*, not to act.

**A green suite is not condition 1.** Neither is a clean fence audit, a passing
`lane-precommit.sh --repair`, or a certified mutation. Those validate an artefact;
only the ledger records that the review *happened*. That distinction is the whole
rule: every other gate in this toolchain checks a thing, and the two steps with no
artefact — running the review, and asking — are the two that go missing.

**`--strict` is not decoration.** A bare `check` exits 0 on a `FORCED` row, and a
forced row is a reason typed by whoever wants the PR opened. Measured 2026-09-05 on the wave-7
PR (number 284, written without the usual hash on purpose: it had not merged, so the
citation law correctly reads a hash-prefixed 284 as above the derived ceiling, and
this sentence would otherwise redden the very law the PR was landing): two commits
were recorded with `record --force`, after which the ledger,
`pr-open.sh` and the `pr-approval-guard` hook *all* reported the range verified —
three independent-looking layers reading one exit status the same session had just
written. A guard whose evidence the guarded party can author is not a guard. The
honest escape is `pr-open.sh --unverified "<why>"`, which writes the gap into the PR
body where a reviewer sees it.

**This paragraph is not the enforcement, and must not be relied on as it.** The rule
already existed in three places on 2026-09-04 — this file, the
`pr-is-a-wave-verified-first` memory, and `verify/SKILL.md` §9 — and three PRs were
opened against it in one session anyway. What enforces it is a `PreToolUse` hook that
fires on the tool call regardless of what the session concludes. If you are reading
this and the hook did not fire, that is a defect in the hook worth reporting, not
permission to proceed on the strength of having read the paragraph.

---

## Review

### If you are reviewing

**Fix what you find.** If the fix is smaller than the comment explaining it,
write the fix. The mandate is to empty the queue, not to annotate it.

- **Review commit by commit**, not as one diff. That is what the commit rule
  buys you.
- **Verify before you assert.** Label every finding you post `EXECUTED` (you ran
  it and read the exit status) or `REASONED` (you argued it from the code with
  nothing run). Never let the credibility of the executed ones carry the
  reasoned ones. The strongest form is a **mutation**: break the thing
  deliberately and show the test that should have caught it staying green.
- **Automated review is a finding generator, not a reviewer.** Model seats under
  a refute-first mandate will manufacture a finding rather than return nothing.
  Measured here: two batches returned 7/7 and 5/5 request-changes; on
  verification that became 3 approve / 4 changes. Two blocking findings
  collapsed outright — one computed `notchCount(512, 960)` against a test
  rendering `end={500}`, and one held a PR to a criterion the issue never set.
  **A unanimous verdict is the tell.** Nothing from a seat may be posted
  unverified.
- **A green bar is not evidence a gate ran.** Run `gh pr checks <N>` and confirm
  each expected job actually executed.
- **Never review your own fix into main.** The reviewer fixes, but a second pair
  of eyes still lands anything non-trivial. The point is removing the *wait*,
  not removing the *check*.

### If you are the author

Every finding gets an answer before the PR leaves draft: **fixed** (name the
sha) or **rebutted** with evidence. Unanswered findings flip the default to
do-not-approve.

---

## Before you commit

Run, in your own worktree: `npm run typecheck`, `npm run lint`, and
`VITEST_MAX_WORKERS=6 npm test`. That is the whole of what a lane runs. Do
**not** run `scripts/gate.sh` — see below for what it actually does.

**Nothing you commit may name a real machine or a real person's home.** This
repo is public, and the line at the top of this file is the whole rule: a
tracked file says how *the repo* works, not how one contributor's laptop is laid
out. Paths, OS usernames, hostnames and session ids off your own machine are all
"how your tooling behaves".

Reach for an obviously synthetic placeholder — `/home/operator`,
`/Users/operator`, `HOST-REDACTED` — fake enough that no later reader mistakes
it for captured truth. Where a directory already has a stricter local convention
(`/repo`, `/repo-wt/<lane>` in the collector fixtures), use that: it is what
lets those directories ban `/home/` outright rather than keep an allowlist of
approved home directories.

**A capture is not exempt — it is the main source.** Verification-by-capture is
the merge gate (prd-26 ruling 3) and it emits your paths by construction. The
`CAPTURE.md` beside each fixture set is the recipe, and sanitising is a step in
it: substitute *after* the capture and *before* the commit, move the test's
expected values in the same edit, and re-run the suite to prove the fixture
still exercises what it claims. A capture whose test still expects the old bytes
has stopped being evidence.

Two failures worth knowing, because both actually happened (#649):

- **a path and its encoding are one edit.** `C:\Users\x\repo` and the slug
  `C--Users-x-repo` are the same fact written twice; changing one leaves a test
  that passes while no longer testing the encoding. Re-derive the second rather
  than retyping it.
- **a guard scoped by a naming convention misses the files that predate it.**
  The fixture-hygiene law read `startsWith('claude-code-')`, so it never saw
  three older captures sitting in the same directory — and asserted, truthfully
  and uselessly, that no fixture carried a home path. Scope a guard by what a
  file *is*, not by what it is called.

## Landing — the operator's step, and nobody else's

`scripts/gate.sh <handle> <fence-regex> [load-batches]` is **not a pre-push
check**. Running it *is* the landing. It blocks rather than reports —
`rebase → base-ancestor assert → fence audit → commits exist → nothing stranded →
NUL-byte guard → suite → typecheck`, every check exiting non-zero on failure —
and then, once green, it merges the branch into local `main`, runs `npm install`
and `npm run build` against the merged result, and finishes by pushing that
merged `main` to `origin`.

Exactly one step in that sequence is deliberately non-fatal: **the final push**.
Every earlier check exits non-zero on failure — but *what* a failure holds moves
with the merge. A check that fails **before** the merge holds the merge: nothing
landed and the lane still has the work. The two that run **after** it
(`npm install`, `npm run build`) hold the *push*: local `main` already carries
the merge and the lane's branch and worktree are already gone, so recovery there
is to fix forward on `main`, never to go back to the lane. The gate says which
side of the merge it failed on, and that sentence is the one to read first.

The push alone is allowed to fail loudly and let the landing stand anyway,
because an offline operator must still be able to land — a merge that cannot
reach `origin` yet is still a merge, and refusing to keep it on `main` locally
would throw away real work over a network problem rather than a bad change.
That exemption belongs to the push, and only the push; no other step in the
script inherits it. Do not read it as license to treat the rest of the gate as
advisory too.

That last third used to be missing from this section, which described the
command under a heading that read as "the thing you run before pushing". On
2026-08-12 a lane followed that reading, ran the gate, and came within a stale
local checkout of pushing unreviewed work to `origin/main` — the push was
rejected only because `main` happened to be 13 commits behind (#408). The lane
was not being careless; it was doing what this file said.

So: the operator runs it. A lane never does, and never needs to — the three
commands above are what a lane's work is gated on, and the operator's review is
what everything else is gated on.

### A green gate on a branch whose base is not `main` has landed nothing

The gate merges into **local `main`** and pushes that. Point the same machinery
at an integration branch and every check still passes, the branch still merges,
the issues still close — and `origin/main` never hears about it.

That is not hypothetical either. prd-44's waves 1 and 2 were built, reviewed and
merged through four PRs whose base was a branch called `prd44`, which never had
a PR of its own. Five commits sat there for two days while `main` moved 40
commits past them; four issues were closed with comments that said, accurately,
*"landed in PR #96, merged into prd44"*. Nothing was mis-recorded and nothing was
lost — the milestone simply read as done while none of it was on `main`. It was
recovered by cherry-picking all five onto current `main` (#128), which applied
clean, but two days of queue had been paid for nothing.

Two habits are enough to prevent it, and both are cheap:

- **A PR's base is `main` unless you can name the PR that will merge its base.**
  An integration branch is legitimate — it is how a bundle gets assembled — but
  it is a stage, not a destination, and the PR that lands it is what makes it
  one.
- **Close an issue against a commit on `main`, not against a merge.** "Merged
  into `<branch>`" is the honest wording for what happened, and it is also the
  tell: if a closure comment cannot name `main`, the work is still in flight.
  `git merge-base --is-ancestor <branch> origin/main` answers it in one command.

The third argument is the one this section used not to name. `[load-batches]` is
a batch count, and the script's own comment calls it **mandatory for anything
touching tests** (the `Load gate:` comment in `scripts/gate.sh`) — a suite green
8/8 quietly has failed 67% at 4x concurrency. Given one, the gate runs the suite
four times at once per batch with each run's worker pool bounded
(`--maxWorkers=5`, so the probe measures the suite and not the scheduler), and
then runs the timing tests **alone, serially, once** — the only condition under
which a wall-clock assertion means anything at all. The timing set is derived
rather than listed: a file opts in with a `// @gate-timing` marker or a
`*.bench.test.ts` name (#209), and a pass that matches zero files fails loudly,
because the failure it exists to prevent is a renamed
timing test dropping out of the serial pass and running under load with nothing
going red. Omit the argument on a branch that touched tests and none of
that runs; the landing is green on the friendlier condition.

CI runs `build`, `test`, `typecheck`, `lint`, a packaging guard, and a boot smoke
across ubuntu + macOS, at the current node and the declared minimum (the
macOS × min-node leg is excluded — `macos-latest` bills 10x). A **second job**,
`pack-smoke` in `.github/workflows/ci.yml`, packs the tarball, installs it into
a project that has never heard of this checkout, and runs the CLI from those
installed files, on the full 3×2 grid — ubuntu, macOS and Windows, both
node legs, no exclude (#211). So the checklist to compare `gh pr checks <N>`
against is three jobs long and ten legs wide, not one job — the third is the
single-leg `windows-suite` job in `.github/workflows/windows-suite.yml`
(#212, below). The macOS leg is the one that carries signal for path-shape
bugs — `os.tmpdir()` is a symlink there (`/var` → `/private/var`) and is not
on Linux, so a raw-vs-canonical path comparison passes vacuously on ubuntu and
fails only on macOS.

`Build` runs **before** `Test`, and a red `Test` does **not** cost you the rest of
the leg. `Typecheck` and `Lint` are gated on `if: "!cancelled()"`; the packaging
guard and the boot smoke on `if: "!cancelled() && steps.build.outcome ==
'success'"`. So a failing suite still leaves four gates' worth of evidence
behind it, and the two that need a real `dist/` are held back only when `Build`
itself went red.

`always()` was considered and rejected deliberately — the workflow says why
beside the packaging guard: the guard flags only *unexpected* files and so
passes vacuously over an empty `dist/`, while the boot smoke's bin falls back to
running TS source when `dist` is absent. On a Build-red leg `always()` would
report both green having verified nothing built. Read a step's own `if:` before
concluding it did or did not run, and check `gh run list --branch main` before
assuming a gate has been enforcing anything.

**Cite CI by job and step name, never by line number.** Both citations this
section used to carry had rotted: `pack-smoke` was named 31 lines off, and the
`Build` one was wrong and then drifted back into correctness when an unrelated
PR moved the file — the worse failure, because spot-checking it says "fine".
It is the lesson `.swarm/coupling.txt` already records for `scripts/gate.sh`: a
registry entry pinned to a number for a file that moves is a registry entry that
rots by construction. `packages/server/src/runbook-delivery-law.test.ts` now
holds this paragraph to the workflow it describes.

CI is 3.5–4 minutes, against a 21-hour queue. **It is not the bottleneck — do
not optimise it for throughput.** The valuable CI direction is coverage, not
speed. Since #211 (prd-25 wave 2) `pack-smoke` runs a `windows-latest` leg at
both node legs, so a built clone's boot on native Windows is witnessed on every
push — the `pathToFileURL` fix in `packages/server/bin/rhizomorph.mjs` had no
CI witness before it. `build-test-boot` still has no Windows leg. The suite's
known native failures live in `.windows-known-failures`, which
`.github/workflows/windows-suite.yml` enforces per file on every push (#212,
prd-25 wave 3): a failure outside the list is red, a listed file that passes
is a removal candidate, and every entry names its cause class. Promotion onto
`build-test-boot` is a separate decision made with both Windows jobs' measured
cost. The only other Windows runner in `.github/workflows/` is the
installer-packaging leg in `desktop.yml`, which packages the shell and runs no
suite.

---

## Where a decision goes

- **`docs/adr/`** — architecture decision records. Structure, contracts, formats,
  where authority lives. The test: if you can't name a rejected alternative and
  say why, it isn't an ADR. Read `docs/adr/README.md` before writing one; the log
  is append-only, so a changed mind gets a new record that supersedes the old.
- **`docs/design-notes/`** — rationale for a value, formula, or visual form. Why
  `TUFT_WASH` is 0.16, not which path the architecture took. Cited directly from
  code comments.
- **`docs/prds/`** — product scope and behaviour. A PRD *ruling* dies with its
  PRD; an ADR outlives it. When a ruling is architectural, link to the ADR rather
  than restating it.

Record rulings on the issue and fence widenings on the PR, **before** the change.
The repo's own history is why findings are checkable later.

---

## Reviews

`docs/review/` holds multi-strategy code reviews with a consolidated work list in
its `README.md`. They are dated artefacts describing the tree at a specific
commit — read them for findings, not as current state.

---

## Measuring whether this is working

```
scripts/dev/metrics.sh [days]
```

Prints queue vs work time, issues per PR, and gate events per issue. The
baseline to beat is at the top of this file. If the queue share is still ~80% in
a week, bundling is not being applied — check issues-per-PR first.
