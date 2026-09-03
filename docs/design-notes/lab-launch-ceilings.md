# Lab launch ceilings — why 8 arms, why 30s on the lock

Two constants in `packages/server/src/api/lab.ts` bound `POST /api/lab/launch`
(prd-41 ruling 2 and ruling 4):

- `MAX_ARMS = 8` — the most arms one launch request may dispatch. Each arm
  forks a real worktree and, with `--launch`, a real spending agent lane, so
  this is a spend ceiling in the same family as the estimate ruling 4 already
  requires an honest basis for (`estimateLaunchSpend`, this file). A launch
  panel comparing treatments — different models, different briefs — realistically
  spans a handful at a time (2–4 is the common case this file's own tests use);
  8 gives generous headroom above that without letting one click fork a lane
  count large enough that nobody is meaningfully reviewing each one before it
  spends. Raise it if a real workflow needs more, but the ceiling should stay
  small enough that an operator can look at the launch confirmation and
  actually reason about what they're about to pay for.

- `LAB_CLI_LOCK_CEILING_MS = 30_000` — how long a launch will wait for another
  launch's `runCli` call to clear before refusing rather than joining the
  queue behind it (`withLabCliLock`). The lock is already strictly
  sequential — one `rhizomorph lab fork` in flight at a time, process-wide —
  so this ceiling is about attention and spend, not concurrency: prd-12
  ruling 3 already establishes that a queue hides spend behind latency, and a
  launch an operator is actively watching should not sit silently behind
  another one for longer than it would take to notice something is wrong. A
  healthy fork is git plus a `workmux`/`tmux` dispatch — seconds, not tens of
  seconds — so 30s is "clearly wedged," in the same spirit as
  `ROUTE_EXEC_TIMEOUT_MS` (`api/doctor.ts`) and
  `COLLECTOR_EXEC_TIMEOUT_MS` (`collector-tick-budget.md`), just wider because
  this bounds a multi-step CLI invocation rather than one subprocess call.

This ceiling bounds the WAIT, not the in-flight call: the arm currently
running keeps the lock until it settles on its own, however long that takes.
Bounding the in-flight subprocess itself is `withTimeout(exec, ms)`
(`server/exec.ts`), which the other prd41 wave-2 issue wires through the four
lab modules — a different constant, a different file, a different failure
mode (a hung child process vs. an operator waiting behind someone else's
request).

Both ceilings are refusals, never queues: `MAX_ARMS` refuses before anything
is dispatched (`LaunchValidationError`, 400), and the lock ceiling refuses a
call that was still waiting for its turn (`LabCliLockCeilingError`, 503) —
neither lets a request that failed loudly still spend money quietly later.

## The exec-timeout family, and where composition breaks it

Every lab module wraps its subprocess calls with `withTimeout(exec, ms)`
(`server/exec.ts`), and `withTimeout` **always overrides** the `timeoutMs` an
incoming `options` object carries — it does not defer to one already set. That
makes composing two wraps a trap rather than a safety margin: whichever wrap
sits CLOSEST to the raw `exec` is the one a subprocess actually sees, because
its override is applied last, on the way down. An outer wrap with a wider
number does nothing once an inner one has already fixed a narrower one.

`dispatchFork` (`lab/fork.ts`) hit exactly this (PR #123 review, Blocking 1 /
`#109`): it used to wrap with `FORK_EXEC_TIMEOUT_MS` (5s) BEFORE handing that
already-wrapped `exec` down to `restoreCheckpoint` → `restoreWorkspace`, which
wraps again with `RESTORE_EXEC_TIMEOUT_MS` (120s, `restore.ts`). The 5s wrap
was closer to the raw exec, so `npm install` — the reason 120s exists at all —
ran capped at 5s in production, silently. `restore.test.ts`'s own composition
test called `restoreWorkspace` directly with an unwrapped exec, so nothing in
the suite exercised the shape that actually occurs at runtime.

The fix is not a wider number — it is not wrapping at the outer layer at all.
`dispatchFork` now hands `restoreCheckpoint` the RAW exec (`options.exec ??
realExec`), so `restoreWorkspace`'s own 120s wrap is the one that reaches the
subprocess unmolested. `FORK_EXEC_TIMEOUT_MS` (5s) still bounds the two calls
`fork.ts` makes directly — `workmux add`, `workmux path` — because nothing
downstream re-wraps those. The regression test for this class of bug has to
go through the caller that composes (`dispatchFork`), not the callee alone
(`restoreWorkspace`) — a direct call can never exercise a composition bug.

**That last sentence is about composition, and is NOT a claim that 5s is the
right number for `workmux add`.** It is not settled that it is, and the
review of PR #123 flagged it as the third member of this family without a
number to offer. There now is one: `workmux add` runs `.workmux.yaml`'s
`post_create` hooks unless given `-H` (`workmuxAddArgv`, `lab/fork.ts:184`,
does not), and in *this* repo that hook is `nvm use` followed by **`npm ci`** —
a dependency install, bounded here at 5s, which is the exact shape Blocking 1
was about. Measured 2026-09-01 on an idle machine: `npm ci` into a fresh
worktree of this repo takes **~1.6s warm** (APFS, populated npm cache), so it
fits today with roughly 3x margin; the same review measured this dependency
set at **6.9s cold**, which does not. And `post_create` is arbitrary
operator-authored shell, so no measurement of it generalises past the repo it
was taken in. Left as a stated open question rather than silently widened:
picking that ceiling is a ruling, and a ruling is not a review's to make.

`compareFork` (`lab/compare.ts`) carried the sibling defect one layer over
(same PR, Blocking 2): its single `COMPARE_EXEC_TIMEOUT_MS` (5s) bounded BOTH
the git plumbing (`countCommits`) — correctly, that's git — AND the verify
command, whose default is `npm test` and which this repo's own suite takes
~186s to run. Every real verify call was killed before finishing, and
`c07bb16`'s own test (`expect(arm.verifiedDetail).toBe('exit null')`) could
not tell "a hung command was correctly killed" from "every real command is
killed," so it passed either way. The fix splits the ceiling in two:
`COMPARE_EXEC_TIMEOUT_MS` (5s) still bounds `countCommits`'s git call;
`COMPARE_VERIFY_TIMEOUT_MS` (600_000ms / 10 min) is a new, separate ceiling
for `verifyArm` alone — the same "ceiling on operator patience, not a
performance budget" reasoning `RESTORE_EXEC_TIMEOUT_MS` already uses for a
dependency install, just wider still, because a gate command is a wider thing
to wait on than either git plumbing or an install.

Two notes on the ~186s, so a later reader does not have to re-derive it. It is
vitest's *summed* figure (tests + environment + import + setup across workers),
not the wall clock a `timeoutMs` actually bounds: re-measured 2026-09-01 on an
idle machine, `VITEST_MAX_WORKERS=6 npm test` is **39s wall** while its summed
figure is ~183s. So the ceiling is roughly 15x the observed wall clock here,
not 3x. That does not change the number — 600_000ms is a patience ceiling, and
the case for it is what a *wedged* gate costs, not what a healthy one takes —
but the wall clock this bounds is the one an arm's gate sees on a box that may
also be running the operator's own lanes, and nobody has measured *that*.
(`compareFork` itself runs its arms sequentially, so the arms do not load each
other; the load, if any, comes from outside the comparison.)

The same commit also fixed `compare.ts`'s hand-rolled failure-detail line
(`line.length > 0 ? line : \`exit ${result.code}\``) to route through
`describeExecFailure` — the fourth copy of the `exit null` bug `server/exec.ts`
already names three prior instances of (#306's git collector, #425's three
judge readers, `restore.ts`'s own npm-install line).
