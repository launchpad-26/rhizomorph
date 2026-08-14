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
scripts/dev/issues.sh when     <n> now|soon|later
scripts/dev/issues.sh priority <n> urgent|high|medium|low
scripts/dev/issues.sh type     <n> bug|feature|task
scripts/dev/issues.sh status   <n> backlog|ready|in-progress|in-review|done
scripts/dev/issues.sh close    <n> "reason"   # a reason is required
scripts/dev/issues.sh orphans                 # open issues missing from the board
scripts/dev/issues.sh ids                     # field/option ids, for debugging
```

`issues.sh show` is currently broken (#362) — `gh`'s default issue view still
queries Projects classic. Use `gh issue view <n>` until that lands.

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
ones that do not.

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

## Landing — the operator's step, and nobody else's

`scripts/gate.sh <handle> <fence-regex>` is **not a pre-push check**. Running it
*is* the landing. It blocks rather than reports —
`rebase → fence audit → nothing stranded → typecheck → suite`, every check
exiting non-zero on failure — and then, once green, it **merges the branch into
local `main`** (`gate.sh:172`), runs `npm install` and `npm run build` against
the merged result, and ends with **`git push origin main`** (`gate.sh:177`).

That last third used to be missing from this section, which described the
command under a heading that read as "the thing you run before pushing". On
2026-08-12 a lane followed that reading, ran the gate, and came within a stale
local checkout of pushing unreviewed work to `origin/main` — the push was
rejected only because `main` happened to be 13 commits behind (#408). The lane
was not being careless; it was doing what this file said.

So: the operator runs it. A lane never does, and never needs to — the three
commands above are what a lane's work is gated on, and the operator's review is
what everything else is gated on.

CI runs `test`, `typecheck`, `lint`, a packaging guard, and a boot smoke across
ubuntu + macOS. The macOS leg is the one that carries signal for path-shape bugs
— `os.tmpdir()` is a symlink there (`/var` → `/private/var`) and is not on Linux,
so a raw-vs-canonical path comparison passes vacuously on ubuntu and fails only
on macOS.

If the `Test` step fails, **every later step on that leg is skipped** — typecheck,
lint, packaging and boot smoke silently do not run. A red leg is therefore worth
more than one failing test; check `gh run list --branch main` before assuming a
gate has been enforcing anything.

CI is 3.5–4 minutes, against a 21-hour queue. **It is not the bottleneck — do
not optimise it for throughput.** The valuable CI direction is coverage, not
speed: the `windows-latest` leg (prd-25) is a real gap, since a built clone
could not boot on Windows at all until `#281`.

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
