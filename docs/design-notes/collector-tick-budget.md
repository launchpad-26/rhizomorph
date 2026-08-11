# Collector tick budget — why 5s per exec, 10s per poll

Two constants in `packages/server/src/server/poll-loop.ts` bound a collector tick
(see [ADR-0013](../adr/0013-collector-ticks-are-bounded.md) for the decision):

- `COLLECTOR_EXEC_TIMEOUT_MS = 5000` — the ceiling on any single collector
  subprocess. Deliberately the same as the doctor route's already-reviewed
  `ROUTE_EXEC_TIMEOUT_MS`: a healthy `git`/`tmux`/`workmux` call answers in
  milliseconds, so 5s is "clearly wedged," not "slow."
- `COLLECTOR_TICK_BUDGET_MS = 10000` — the ceiling on one `collector.poll`,
  enforced in JS so it holds even when the child ignores SIGTERM or the hang is
  not in a subprocess at all. Set above the single-exec ceiling (5s) so one
  capped exec never trips it, and generous enough that a healthy multi-worktree
  git tick (a handful of fast sequential `git` calls) stays well under it, while
  still catching a genuine wedge inside roughly one poll interval.

The tradeoff: a repo with a very large number of worktrees, each incurring real
git latency, could in principle approach the tick budget on a healthy tick. At
this tool's scale — a swarm of worktrees, not thousands — that has not been
observed; if it is, raise the budget rather than remove the watchdog.
