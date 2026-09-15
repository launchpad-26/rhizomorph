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

## The process collector's cost has a different shape, and two numbers

*Added by prd-57 wave 1 as a placeholder. Measured 2026-09-16, wave 2.*

Both ceilings above are written against a **subprocess**. The process collector
has two legs and only one of them spawns anything, so it needs both numbers and
they are a factor of thirty apart.

| leg | measured | over | how |
|---|---|---|---|
| **Linux / WSL2** | **42 ms** median (min 37, max 45, five runs) | 63 processes | `/proc` read directly — one `readdir`, then a `readlink` and two `readFile`s per candidate pid. **No subprocess at all.** |
| **Windows (native)** | **1273 ms** | 216 processes | one `powershell -Command "Get-CimInstance …"` through ADR-0004's injected `Exec` |

Measured on one machine, 2026-09-16: WSL2 Ubuntu under Windows 11, node 22.23.2
for the Linux figure; native Windows 11, node 22.23.1 for the Windows one. Both
are single-machine readings rather than a distribution, and the process counts
are stated beside them because a tick cost without one means nothing.

**What that means against the two ceilings above.**

- The Linux leg is nowhere near either. 42 ms is noise beside the 10 s tick
  budget, and it is not bounded by `COLLECTOR_EXEC_TIMEOUT_MS` at all, because
  it spawns no child. Its cost scales with *how many processes the machine is
  running*, not with how many worktrees this repo has — a shape neither existing
  constant describes.
- **The Windows leg spends a quarter of the exec ceiling on every tick.** 1273 ms
  against `COLLECTOR_EXEC_TIMEOUT_MS = 5000` is comfortable today and is the
  largest single exec this instrument performs. Nearly all of it is PowerShell's
  own start-up rather than the query: the same machine's `/proc`-equivalent work
  is two orders of magnitude cheaper.

**What has NOT been measured, said plainly rather than left to be assumed:** how
either figure moves on a machine running hundreds more processes, and whether
the Windows leg degrades linearly or worse. The tradeoff paragraph above says to
raise a budget rather than remove a watchdog if a healthy tick approaches one —
that instruction stands, and nothing here is close enough to act on yet.

**macOS is unmeasured because the leg is unbuilt.** It will spawn `ps` and
`lsof`, so expect it to sit nearer the Windows figure than the Linux one.
