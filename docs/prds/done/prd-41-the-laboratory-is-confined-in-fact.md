# prd-41 — the laboratory is confined in fact: the fence prd-12 promised, enforced

> **Status:** **SHIPPED** — 2026-09-02. Milestone `prd41`: seven issues, all closed, across
> three waves plus two late review defects; the closeout, including what the plan got wrong,
> is the last section of this document.
> Blessed by Ciaran Slow, 2026-08-22, in session. Drafted the same day from the reconciled audit
> at `03df141` (findings 8, 9, 10, 28 — untracked artefact, `.gitignore`d; the sha is the anchor). Successor to prd-12, whose own Outcome line says *"its fence is incomplete — see
> #234, #245"*: prd-12 is shipped and cannot take new waves, so the unfinished half lands here
> and cites its rulings rather than restating them.

## Problem

prd-12 ruling 1 amended a read-only constitution to two hands, and drew the second hand's fence
precisely: the laboratory may write **only** refs under `refs/rhizomorph/`, git objects, and
artefacts outside the watched repo. `#234` closed the shell-interpolation half of that fence and
`#245` was left open by name.

What remains open is not one hole but a posture. The lab runs the checkpointed tree's own install
hooks as the operator, outside every namespace the README enumerates. Its subprocesses have no
timeout, so one hung `npm install` wedges every later launch for the process lifetime with no
diagnostic. It replaces the whole process's stderr for the duration of a fork, silencing the
degrade voice `#239` was built to make loud. And it accepts an unbounded arm count, each arm real
money.

Each is small. Together they are the difference between a fence that is described and a fence
that holds.

## Evidence

- **The fork runs lifecycle scripts.** `lab/restore.ts:293` runs
  `npm install --no-audit --no-fund` with no `--ignore-scripts`, and `:290` reads
  `options.install ?? true` — so a `preinstall`/`postinstall`/`prepare` hook in the checkpointed
  tree executes as the operator by default, outside prd-12 ruling 1's namespaces.
- **The containment law cannot see it.** `lab/namespace-law.test.ts:519-527` calls
  `forkThreeArms({ install: false })`; only two call sites exercise `install: true`, and both stub
  `npm`. The law asserts a fence the default path never crosses under test.
- **The CLI's confinement claim is false when it prints.** `cli/index.ts:225-227` prints prd-12
  ruling 1's three namespaces on the no-`--launch` path, downstream of the install — so the tree's
  hooks have already run outside all three by the time the operator is told they cannot.
- **Every lab subprocess is untimed.** `lab/compare.ts:79`, `lab/checkpoint.ts:57`,
  `lab/fork.ts:256`, `lab/restore.ts:273` all take `options.exec ?? realExec` raw. `withTimeout`
  is wired at exactly one site in the tree: `server/poll-loop.ts:91`. `#236`'s fix landed for
  collectors and stopped there.
- **The lab lock has no ceiling.** `withLabCliLock` is a plain promise chain, so a hung
  `git worktree add` or `npm install` blocks every subsequent `POST /api/lab/launch` for the
  process lifetime — no 503, no diagnostic.
- **Process-wide stderr capture.** `api/lab.ts:484-488` replaces `process.stderr.write`, restored
  in `finally` at `:509`. The window spans the whole fork — seconds to minutes — while
  `poll-loop.ts:164`'s `console.error` degrade logging runs on a live timer, so those lines are
  misattributed into `failed.error` or discarded.
- **No arm ceiling.** `api/lab.ts:390-392` requires only a non-empty array; each entry becomes a
  real worktree, a real agent and real spend, sequentially through the lock.

## Success

1. A fork cannot execute code from the tree it restored. **Not met while** any lab install path
   runs lifecycle scripts, or the containment law's fence is asserted only on a path the default
   does not take.
2. A hung child is abandoned within a stated budget, and the lab keeps answering. **Not met while**
   any lab subprocess runs untimed, or a wedged launch makes the next request hang rather than
   refuse.
3. The degrade voice keeps its volume during a launch. **Not met while** a `console.error` raised
   outside the lab can be swallowed by a lab request.
4. A ceiling that costs money is declared, not discovered. **Not met while** an arm count is
   refused by exhaustion rather than by a stated limit and a legible reason.
5. A stated confinement is true of the run it describes. **Not met while** any surface names a
   fence that the work it is reporting on has already crossed. The defect is the untruth, not the
   ordering: `cli/index.ts:225-227` prints prd-12 ruling 1's three namespaces *after*
   `forkFromCheckpoint` has already run the checkpointed tree's install hooks outside all three,
   so it satisfies any test of print order while saying something false. An earlier draft of this
   criterion was falsified by stating confinement *before* the work finished, which the current
   code already avoids — it could not have caught this. Ruling 1 is what meets it: once the
   restore cannot execute the tree, the sentence the CLI prints becomes true where it stands.

## Non-goals

- **No new hand, and no widening of prd-12 ruling 1.** The three permitted namespaces are law and
  are not renegotiated here. This PRD makes them true, not larger.
- **Not the lab's UI.** prd-14 owns the experiment console. No wave here touches
  `packages/web/src/lab/`.
- **Not the namespace law's own scope gap.** prd-24's non-goals name `lab/compare/`'s seven
  ungoverned files; widening what a law *claims* is its work, not this PRD's.
- **Not `#205`.** The fold-order divergence stays unruled, and the lab must not assume a
  resolution — prd-14's own open questions already say so.

**Rejected alternatives.** *Flipping `install` to default `false`* — it is the safer default and a
real candidate, but the CLI surface is the breaking-change contract (`CHANGELOG:14`), so a default
flip is a major bump for a fix that `--ignore-scripts` achieves at patch level; ruling 1 takes the
narrower change and leaves the flip to an operator ruling. *Threading a per-request stderr sink
through every lab module* — `runCli` already accepts `log` and `exit`; adding a third seam is
cheaper than plumbing a fourth parameter through four modules. *Queueing over-limit arms instead of
refusing* — a queue hides spend behind latency, which prd-12 ruling 3 ("money is never hidden")
forbids.

## What already exists (do not rebuild)

- `withTimeout(exec, ms)` in `server/exec.ts` — already written, already proven at
  `poll-loop.ts:91`. The lab wires the same helper; it does not grow its own.
- `runCli`'s existing `log` and `exit` options in `api/lab.ts` — the seam ruling 3 threads the
  stderr sink through.
- `refuseFlagShaped` (`api/lab.ts:349`) and `MODEL_GRAMMAR` (`api/lab.ts:268`, with its guarded
  second copy at `lab/fork.ts:131` — the drift between them is already a law,
  `lab/model-grammar-law.test.ts`, from `#405`) — `#234`'s validation. The arm-count ceiling joins
  `api/lab.ts`'s validation block rather than inventing a second one, which is also where ruling 4
  puts `MAX_ARMS`.
- `lab/namespace-law.test.ts` — the law exists and bites; ruling 1 widens which paths it walks.

## Rulings

## Ruling 1 — a restored tree is data, never code

`lab/restore.ts:293` passes `--ignore-scripts`. A checkpoint is a snapshot of a working tree that
an agent may have authored; running its hooks is executing that agent's code as the operator, and
prd-12 ruling 1's fence says the lab writes only three namespaces — it says nothing about granting
arbitrary execution, because nobody imagined it had.

The law follows the code: `namespace-law.test.ts` gains a case calling `{ install: true }` against
a fixture whose `postinstall` attempts a write outside `refs/rhizomorph/`, and fails if it lands.
A law whose fence is only asserted on the path the default does not take is the vacuity shape
prd-24 exists for.

## Ruling 2 — every lab subprocess is bounded, and the lock refuses rather than hangs

All four lab modules take their `exec` through `withTimeout`. `withLabCliLock` gains a ceiling: a
launch waiting longer than it rejects with **503** and a diagnostic naming what it waited on.

Refuse, never queue. A queued launch is money the operator did not watch being spent, which is the
same objection prd-12 ruling 3 raises.

## Ruling 3 — a request may not silence the process

The global `process.stderr.write` override is deleted. The stderr sink threads through `runCli`'s
existing options, so a lab launch captures only its own child's output and the degrade voice keeps
its channel.

### Corrected 2026-09-01 — the mechanism is scoped capture, not deletion-plus-threading

Neither sentence above is what `#10` shipped, and PR #123's review (non-blocking finding) is right
to flag the mismatch. `api/lab.ts:579` still assigns `process.stderr.write` — it is not deleted —
and `cli/index.ts` still writes to it directly at seven call sites, never through `runCli`'s `log`
option. What actually landed: the override itself is scoped with `AsyncLocalStorage`
(`stderrCaptureScope`, `api/lab.ts:555`), so it captures a write only when that write happens
inside the current `runCli` call's own async scope, and lets everything else — including
`poll-loop.ts`'s degrade `console.error` running concurrently on its own timer — fall through to
the real stream untouched.

This PRD's premise was false: it assumed `runCli`'s `log`/`exit` options were the stderr seam to
thread through, but they were never wired to the seven direct-write call sites in `cli/index.ts`,
so "thread through `log`" was not a smaller version of the right fix — it described a seam that
doesn't reach the problem. Scoping the capture is the right call regardless: it meets success
criterion 3 (the degrade voice keeps its channel) without plumbing a fourth parameter through four
modules, which the Rejected-alternatives section above already argues against for a different
reason. Ruling 3's own two sentences above ("the global `process.stderr.write` override is
deleted", "the stderr sink threads through `runCli`'s existing options") are therefore both false
of the tree, while success criterion 3 is genuinely met — recorded here so a later reader checking
the ruling against the tree finds an explanation instead of a contradiction. This PRD has no
separate definition-of-done list; Ruling 3's two sentences are the whole of what it asked for.

## Ruling 4 — a ceiling that spends money is declared

`MAX_ARMS` is named in `api/lab.ts` beside `#234`'s validation, and an over-limit launch is
refused with **400** naming the ceiling. The number is a design-note decision, not a ruling: it
belongs beside the other spend values, with its reasoning.

## Sequencing (waves, each gated as ever)

`packages/server/src/lab/` and `api/lab.ts` are this PRD's territory. `packages/web/src/lab/` is
prd-14's; no wave enters it. `server/exec.ts` is consumed, never edited. Every wave follows
prd-39 wave 1.

**Wave 1 — the Keystone.** `prd41 w1: the containment law walks the installing path` — the law
first, red against today's tree, per prd-24's discipline. Zero-claimant, and it is what proves
wave 2.

**Wave 2 — parallel, fenced apart:** `prd41 w2: a restored tree's install runs no scripts`
(`lab/restore.ts` + `cli/index.ts`'s message order) · `prd41 w2: a lab subprocess is abandoned
within its budget` (`lab/compare.ts`, `lab/checkpoint.ts`, `lab/fork.ts`, `lab/restore.ts`) ·
`prd41 w2: a launch refuses rather than hangs behind a wedged lock` (`api/lab.ts`'s lock) ·
`prd41 w2: an arm count over the ceiling is refused by name` (`api/lab.ts`'s validation).

The last two share `api/lab.ts` and must be one issue or sequenced — `/issue-groom` will hold this
to its own fence rule, and the honest answer is that they are one lane.

**Wave 3 — after wave 2, because it changes what a failure looks like.** `prd41 w3: a lab launch
captures only its own child's stderr` (ruling 3).

**Unfiled work implied, described not numbered:** `lab/compare/`'s seven files are ungoverned by
any law (prd-24 names them). And the `install: true` call sites that stub `npm` should probably
stop stubbing it once ruling 1 lands, since the stub is what hid this.

**#109 and #196 — wave-less by title, filed by wave 3's own review.** Amended 2026-09-02. Both
were filed against this PRD's territory by the independent review of PR `#123`, and neither
carries a wave token, so `scripts/dev/prd-reconcile.sh 41` reports two NO WAVE rows: fence-lint
never saw them and the board's orphan check could not tell. They were not dropped — `#109` is
ruling 2's composition defect and `#196` its sibling one module over, and both closed in
**PR `#195`** (`d8dd1f6`). Declared here rather than by retitling two closed issues, for the
reason prd-46 gives for `#75`: the issues are closed claiming no wave, and editing their titles
now would rewrite the record of what was actually dispatched. **This paragraph does not clear the
rows, and is not meant to** — the NO WAVE check reads the issue *title* and never reads this
document, so both report for as long as they keep their titles. A standing report with its reason
recorded beats a falsified one.

## Open questions

- **`--ignore-scripts`, or `install: false` by default?** Ruling 1 takes the first because the CLI
  surface is a breaking-change contract. An operator may prefer the second and accept the major
  bump. Open, not ruled.
- **What is `MAX_ARMS`?** Ruling 4 requires a number and does not pick one. The lock is
  sequential, so the ceiling is about attention and spend, not concurrency. Open, not ruled.
- **Should the lab lock's ceiling be configurable?** prd-35 owns the settings surface and its
  non-negotiables list; whether a timeout belongs there is its question, not this one's. Open,
  not ruled.

## The four rulings, as they landed

**Ruling 1 — a restored tree is data, never code.** Landed in wave 2 (`#7`), with wave 1 (`#6`)
landing the law red against the pre-fix tree first, per prd-24's discipline.
`lab/restore.ts:310` passes `--ignore-scripts`, and `lab/namespace-law.test.ts:500` now calls
`forkThreeArms({ install: true })` — the default path. That is the whole point: the vacuity the
ruling named was *a law asserting a fence only on the path the default does not take*, and the
fix was to make the law take the default path, not to widen what the law claims.

**Ruling 2 — every lab subprocess is bounded, and the lock refuses rather than hangs.** Landed in
wave 2 (`#8`, `#9`) — all four lab modules wrap through `withTimeout`, `withLabCliLock` gained a
ceiling, and an over-waited launch refuses with **503** (`api/lab.ts:483,808`). **And then it was
found to be false in production by its own review.** `withTimeout` *always overrides* the
`timeoutMs` an incoming options object carries, so composing two wraps is a trap rather than a
safety margin: the wrap closest to the raw `exec` wins. `dispatchFork`'s 5 s wrap sat inside
`restoreWorkspace`'s 120 s one, so `npm install` — the entire reason 120 s exists — ran capped at
5 s against an install this PRD's own spike measured at ~6 s warm (`#109`). Its sibling one module
over: a single `COMPARE_EXEC_TIMEOUT_MS` bounded both git plumbing and the verify command, whose
default is `npm test`, so `compareFork` reported **every arm as failed regardless of the truth**
(`#196`). Both fixed in `d8dd1f6` (PR `#195`), and the fix was *not wrapping at the outer layer at
all*.

**Ruling 3 — a request may not silence the process.** **The verdict is met and both of the
ruling's own sentences are false of the tree**, which this document says about itself in its
2026-09-01 correction rather than leaving a later reader to find the contradiction. What landed
(`#10`) is `AsyncLocalStorage` scoping (`stderrCaptureScope`, `api/lab.ts:555`), not deletion plus
threading: the override still exists and captures a write only inside the current `runCli` call's
own async scope, letting `poll-loop.ts`'s concurrent degrade `console.error` through untouched.
The PRD's premise was simply wrong about the repo — `runCli`'s `log` option was never wired to
`cli/index.ts`'s seven direct writes, so "thread it through `log`" did not describe a smaller
version of the right fix; it described a seam that does not reach the problem.

**Ruling 4 — a ceiling that spends money is declared.** Landed (`#9`): `MAX_ARMS = 8`
(`api/lab.ts:366`), refused with **400** naming the ceiling and why each arm costs
(*"each arm forks a live, spending agent lane"*). The ruling deliberately required a number and
refused to pick one, sending the reasoning to `docs/design-notes/lab-launch-ceilings.md` — which
is where this repo puts the rationale for a value. That note now carries the whole ceiling family,
including the composition trap above, and is the durable artefact this PRD produced.

## The five success criteria, assessed

1. **A fork cannot execute code from the tree it restored — MET.** `--ignore-scripts` on the
   install, and the containment law walks the installing path.
2. **A hung child is abandoned within a stated budget, and the lab keeps answering — MET, and
   only after `#109` and `#196`.** For the fortnight between wave 2 and PR `#195` the criterion
   read as met while the production path ran at 5 s. See below for why nothing could see it.
3. **The degrade voice keeps its volume during a launch — MET**, by a mechanism this document
   did not name and has since corrected in place.
4. **A ceiling that costs money is declared, not discovered — MET.** Declared, refused before
   anything dispatches, and reasoned in a design note rather than asserted in code.
5. **A stated confinement is true of the run it describes — MET.** `cli/index.ts:225-227` is
   unchanged and is now true where it stands, which is exactly what ruling 1 promised: the fix was
   to the fact, not to the print order. This criterion is the best-written one in the document —
   it names its own earlier draft as falsified and says why the obvious test (print order) could
   never have caught the defect.

`EXECUTED` 2026-09-02, Node v22.23.2: `packages/server/src/lab/` + `api/lab.test.ts` — 8 files,
**157 passed**. `git merge-base --is-ancestor d8dd1f6 origin/main` passes, so `#109`'s and
`#196`'s fixes are on `main` and not on an integration branch.

## The three open questions, answered

**`--ignore-scripts`, or `install: false` by default?** **Still open, still unowned.** Ruling 1
took the narrower change deliberately — the CLI surface is the breaking-change contract, so a
default flip is a major bump for something `--ignore-scripts` achieves at patch level. The flip
remains the safer default and remains an operator ruling nobody has made.

**What is `MAX_ARMS`?** **Answered: 8**, with its reasoning in
`docs/design-notes/lab-launch-ceilings.md` rather than here — a launch panel comparing treatments
realistically spans 2–4, and 8 gives generous headroom without letting one click fork a lane farm.
Ruling 4 asked for a declared number and got one that can be argued with, which is the difference
between a ceiling and a limit discovered by exhaustion.

**Should the lab lock's ceiling be configurable?** **Still open, still prd-35's.** No wave here
entered the settings surface, and nothing since has taken the question.

## What the plan got wrong

**Ruling 3 was built on a premise that was false about this repo.** It named `runCli`'s `log`
option as the seam and it is not one. The document's own 2026-09-01 correction is the right
response — it records that both of the ruling's sentences are false of the tree *while the
criterion they served is genuinely met*, so a reader checking the ruling against the code finds an
explanation instead of a contradiction. That is the third instance of "a stated mechanism is not a
ruling" in this cohort, after prd-42's ruling 2 and prd-45's ruling 4, and all three predate
prd-47 writing the lesson down.

**Ruling 2 was the right verdict wired the wrong way round, and no test in the suite could see
it.** `restore.test.ts`'s own composition test called `restoreWorkspace` **directly**, with an
unwrapped exec — so it exercised a shape that never occurs at runtime and passed while the
production path was capped at 5 s. The design note states the general form: *a regression test for
a composition bug has to go through the caller that composes, not the callee alone.* This is the
"what mutation would this test survive?" question from `AGENTS.md`, and the answer here was
*any* — the test could not fail for the reason it claimed, because it never built the composition
the defect lives in.

**Two of this milestone's seven issues carry no wave.** `#109` and `#196` were filed by PR `#123`'s
review against territory this PRD already owned, and neither took a wave token — so fence-lint
never saw them and `prd-reconcile.sh` reports two standing NO WAVE rows. Declared in the
Sequencing above rather than cleared by retitling closed issues, on prd-46's `#75` reasoning.

**`#109` was closed with a comment that says "merged into prd41", not "main".** `AGENTS.md` names
that exact wording as the tell for prd-44's two-day loss, where five commits sat on an integration
branch while the milestone read as done. Checked here rather than assumed —
`git merge-base --is-ancestor d8dd1f6 origin/main` passes, the `prd41` branch reached `main`
through PR `#123`, and nothing was stranded. Recorded because the check is one command and that
wording is the only thing that prompts anyone to run it.

## Residuals, with owners

**Revisited 2026-09-02**, against `main` at `9eddf0a`. Of the four residuals recorded as
**No owner** at closeout, **two were already discharged** by work that landed after this PRD
closed, and the one residual that *had* an owner turns out to name a **shipped** PRD. The
original claims are corrected in place rather than deleted: a residual that quietly disappears
cannot be checked later, and being wrong about what is still open is the exact failure this
section exists to prevent. Nothing below amends a ruling — ownership is bookkeeping, and the
section's title always invited it.

Every status below was checked by reading the tree, not by reasoning from this document.

### Still open, and both are rulings before they can be issues

- **`FORK_EXEC_TIMEOUT_MS` — 5 s for `workmux add`.** The third member of the ceiling family,
  named by PR `#123`'s review with no number offered and still without one. `workmux add` runs
  `.workmux.yaml`'s `post_create` hooks, which in this repo means `npm ci`: measured **~1.6 s
  warm** against **6.9 s cold** for the same dependency set, so it fits today with about 3x margin
  and does not fit on a cold cache. And `post_create` is arbitrary operator-authored shell, so no
  measurement of it generalises past the repo it was taken in. The design note leaves it as a
  stated open question rather than silently widening it, on the grounds that picking that ceiling
  is a ruling and a ruling is not a review's to make.

  **Confirmed unchanged** — `fork.ts` still exports `FORK_EXEC_TIMEOUT_MS` at 5000, and its doc
  comment still names `workmux add` among the subprocesses it bounds. **Owner: an operator
  ruling, unfiled.** It cannot be an issue first, because the issue would have to choose the
  number, which is the part that is not a lane's to choose. What the ruling has to settle: whether
  `workmux add` gets a ceiling of its own — as `COMPARE_VERIFY_TIMEOUT_MS` did, splitting off from
  the 5 s git-plumbing value for exactly this reason — or whether a cold-cache `post_create` is
  accepted as out of scope and the 5 s stands with that stated.

- **The `install: false` default flip.** Open question 1. An operator ruling and a major bump.

  **Confirmed unchanged** — `restore.ts` still reads `options.install ?? true`. Ruling 1 did land
  beside it: the install is now unconditionally `--ignore-scripts`, which is what makes the flip a
  smaller question than it was at closeout — the containment argument for flipping is discharged,
  and what remains is a cost and surface question, not a safety one. **Owner: an operator ruling,
  unfiled.**

### Discharged since closeout — the claims as written are now false

- **~~`lab/compare/`'s seven files, ungoverned by any law.~~ Discharged, and the claim was wrong
  when written.** `packages/web/src/lab/no-live-fleet-law.test.ts` walks `lab/` **recursively**
  (the 2026-08-08 audit's finding #2 made it so, because a flat `readdirSync` had been seeing 5 of
  17 files and missing `branching/`, `compare/` and `launch/` outright). It reaches
  `compare/compare.ts` by name, checks every file under `compare/` against the fleet, panel and
  scene import patterns, and its own file doc records compare/ having been checked clean against
  them as a condition of that amendment. So those seven files are governed.

  What prd-24 declined was a **different law family** — contract and coverage laws, in a non-goal
  about not widening what *those* claim. This residual carried that forward as "ungoverned by any
  law", which conflated the two and overstated it. Retired.

- **~~The `install: true` call sites that stub `npm`.~~ Substantially discharged.** The one site
  where the stub actually hid the defect was the law's, and it no longer stubs: the containment
  test in `namespace-law.test.ts` runs a real `npm install` against a fixture carrying a real
  `postinstall` hook and asserts the escape target is never written — turned green by `f85ce8b`
  (`#6`), the wave this PRD's own closeout credits, and its comment now says out loud that the
  `{ install: true }` there *"is the point: the default path, which the rest of this file's
  fixtures never take."*

  The remaining `install: true` sites in `restore.test.ts` and `fork.test.ts` do still stub `npm`,
  and **that is correct rather than residual**: they assert argv (`--ignore-scripts` is passed) and
  `timeoutMs` (the call gets `RESTORE_EXEC_TIMEOUT_MS`, not the 5 s value). A real install there
  would cost seconds per case and prove nothing those assertions do not already prove. Retired as
  a residual; the unfiled note that produced it read every stub as the same stub.

### The owner that is not one

- **Whether the lock ceiling is configurable.** ~~prd-35's settings surface. **Owned by a PRD, not
  by an issue.**~~ **Its owner is shipped.** `prd-35`'s Outcome line reads *"shipped"*, and a
  shipped PRD cannot take new waves — the convention this document's own header applies to prd-12
  ("prd-12 is shipped and cannot take new waves, so the unfinished half lands here"), and that
  prd-43's header states directly: *a shipped PRD cannot be edited in place*. So this residual has
  been homeless since prd-35 closed, while reading as owned. **No owner.** It needs a live
  settings PRD to adopt it, or an explicit parking; naming which is an operator act, not a
  lane's.

### Found while revisiting — filed as `#235`

- **The lab law's file count is a floor, and its own comment says it is not.**
  `no-live-fleet-law.test.ts`'s coverage assertion is
  `expect(sourceFiles().length).toBeGreaterThanOrEqual(17)`, while the comment directly above it
  says the 17 is *"pinned exactly, not a loose lower bound: headroom here would defeat the
  point"*, and explains that slack would forgive exactly the shallow-walk defect the law was
  amended to catch. The comment describes an assertion the code does not make.

  Stated precisely, because the obvious reading of it is too strong: losing a whole subdirectory
  *is* caught, by the next test naming `branching/geometry.ts`, `compare/compare.ts` and
  `launch/launch.ts` — the "caught twice over" the comment claims. What the floor cannot catch is
  a **shrink inside a subdirectory that survives**. The count is 17 today (5 root, 2 `branching/`,
  7 `compare/`, 3 `launch/`) and the by-name test checks exactly one file per subdirectory, so
  `compare/` could drop from seven files to five with two appearing at `lab/`'s root and both
  assertions stay green while coverage of `compare/` shrank. It is the "test that cannot fail for
  the reason it claims" shape `AGENTS.md` names.

  **Corrected again while filing, and the correction is the part worth keeping:** this entry first
  ended by calling the fix "the one word the comment already assumes" — swap
  `toBeGreaterThanOrEqual` for `toBe`. That is wrong, and wrong in the direction that matters.
  Both matchers compare a single total, so `toBe(17)` survives the very mutation described above.
  What the exact matcher adds is that *growth* reddens — worth having, and the house pattern
  `route-class-law.test.ts` follows — but it does not close the hole this entry names. The
  per-subdirectory count does. A finding whose stated fix does not survive its own stated failure
  scenario is worse than no finding, and this one made that mistake twice before it was filed.

  It also has a **sibling**, found only because filing asked for one:
  `lab/launch/explicit-invocation-law.test.ts` carries the identical comment-versus-assertion pair
  one directory away — its file doc says it copies the no-live-fleet law's tactic, and it copied
  this along with it. Three other floors in the tree were checked and are honest, each pairing its
  floor with `toContain` checks or naming itself a vacuity guard.

  **Owner: `#235`** (prd43 w5 — ruling 2, a count stated in prose is derived from the thing it
  counts, with ruling 1 already making a comment prose for that purpose). Ordered behind `#220`,
  which holds all of `packages/web/src/lab/` for prd-30's sweep.
