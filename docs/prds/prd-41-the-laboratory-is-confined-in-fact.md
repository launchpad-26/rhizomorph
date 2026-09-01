# prd-41 — the laboratory is confined in fact: the fence prd-12 promised, enforced

> **Status:** **BLESSED** — Ciaran Slow, 2026-08-22, in session. Milestone `prd41`. Drafted the same day from the reconciled audit
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

## Open questions

- **`--ignore-scripts`, or `install: false` by default?** Ruling 1 takes the first because the CLI
  surface is a breaking-change contract. An operator may prefer the second and accept the major
  bump. Open, not ruled.
- **What is `MAX_ARMS`?** Ruling 4 requires a number and does not pick one. The lock is
  sequential, so the ceiling is about attention and spend, not concurrency. Open, not ruled.
- **Should the lab lock's ceiling be configurable?** prd-35 owns the settings surface and its
  non-negotiables list; whether a timeout belongs there is its question, not this one's. Open,
  not ruled.
