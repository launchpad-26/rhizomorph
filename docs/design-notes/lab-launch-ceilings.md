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
