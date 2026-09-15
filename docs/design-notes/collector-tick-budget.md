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

## The process collector's cost has a different shape, and no number yet

*Added by prd-57 wave 1. The figure is deliberately absent; wave 2 measures it.*

Both ceilings above are written against a **subprocess**: one bounds a child's
runtime, the other bounds the poll that waits on it. The process collector's
Linux leg spawns no child at all. It reads `/proc` directly — one `readdir`,
then a `readlink` and a `readFile` per candidate pid — so its cost is **syscall
fan-out across the whole process table**, and it scales with how many processes
the machine is running rather than with how many worktrees this repo has.

That is a shape neither constant describes, and borrowing one would be a
guess wearing a number:

- `COLLECTOR_EXEC_TIMEOUT_MS` does not apply on Linux, because there is no exec
  to cap. It **does** apply to the macOS and Windows legs, which reach the table
  through `ps`/`lsof` and `Get-CimInstance` behind ADR-0004's injected `Exec` —
  so the same collector is bounded by different constants on different platforms,
  which is worth knowing before reading a green tick on one as evidence about
  another.
- `COLLECTOR_TICK_BUDGET_MS` applies everywhere, and is the one that would catch
  a pathological table. Whether 10s is generous or tight here is unmeasured.

**What wave 2 measures, and records in place of this paragraph:** the tick's
wall-clock cost on a real machine, with the process count it was measured
against, because the second number is what makes the first mean anything. The
tradeoff paragraph above says to raise a budget rather than remove a watchdog if
a healthy tick approaches it; that instruction holds here, and a measurement is
what it is waiting on.
