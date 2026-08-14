# Operational targets and retention bounds

> #213 (supersedes #176). Two disciplines govern this page: **every bound
> cites the code or law that enforces it**, and **no target is published
> without the measurement that produced it** — a row nobody has measured says
> so and names the command that will, rather than carrying a number somebody
> hoped for.

## Retention bounds — every surface, its bound, and what holds it

| surface | bound | held by |
|---|---|---|
| Browser event retention (the live fold) | `MAX_EVENTS`, drop-oldest | `web/src/app/streamState.ts` (`slice(-MAX_EVENTS)`); law in `streamState.test.ts` (#221 — the fold #176 found unbounded) |
| SSE reconnection replay batch | `REPLAY_BATCH_SIZE = 200` per flush, yielding between batches | `server/src/api/stream.ts`; its tests pin the batching and the no-gap handoff |
| Server recording / session-log growth | unbounded by design **within a session**; rotation is an explicit human act that closes the log with a `session.closed` line | `server/src/recorder/rotate.ts`; `recorder/namespace-law.test.ts` pins that nothing rotates without the operator |
| Collector error history in the fold | `MAX_ERRORS = 200`, drop-oldest | `core/src/state.ts`; `reduce.ts` (`collectorError`) |
| Refusal records | capped via `refusalStateWith` (`MAX_REFUSALS`), drop branch kept reachable by a test | `core/src/state.ts` |
| Telemetry / trace lookup tables | die with the array they index — `WeakMap`-keyed by identity, detached on take | `core/src/reduce.ts` (`UsageIndex` #179, `TraceIndex` #184, `CommitIndex` #342) |
| Fold projections (`byTrace`, `bySession`, `commits.bySha`/`order`) | memoized once per array identity, garbage-collected with it | `core/src/state.ts` (`traceStateOf`, `commitsStateOf`) |
| Collector subprocess work per tick | bounded per ADR | `docs/adr/0013-collector-ticks-are-bounded.md`; budget rationale in `docs/design-notes/collector-tick-budget.md` |
| Worktree / lane count | **no ceiling exists.** Not invented here: a ceiling is a product ruling (what happens to lane 21?), not a retention fact. Named so nobody reads this table as claiming it. | — |

## Cold replay (session open) — measured

`buildSessionIndex` — one fold, keyframe snapshots, one `isSorted` pass — is
what "open a recording" pays before the first frame. `[Ran]` 2026-08-12,
WSL2/Linux dev box, median of 3, via `web/src/replay/replayFold.bench.test.ts`
(the reproducible instrument; it reports these on every timing-gate run):

| session | census mix (audit's own type shares) | commit-dense (25k events, 5k commits) |
|---|---|---|
| 5,000 events | 10.2 ms | — |
| 25,000 events | 113.5 ms | 187.6 ms |
| 55,000 events | 535.3 ms | — |

The 2026-08-07 instrument read 4,425 ms at 55k and 3,768 ms for the
commit-dense shape — the mechanisms were #179, #184 and #342, each fixed and
each re-measured in that bench file and `core/src/reduce.bench.test.ts`.
Per-event cost still rises ~4.2–4.8× across 11× the events: that residual is
the immutable-append floor the purity laws price in
(`reduce.bench.test.ts`'s "#179 — the residual, named" section), not a scan.

The issue's 250k size is **not yet measured** — the bench lanes stop at 55k,
the largest real capture. Extending the lane is one constant; do it against a
real 250k recording rather than an extrapolated corpus.

## Soak — the harness exists; the numbers do not yet

Steady-state CPU at 20/100 lanes, memory growth per hour, RSS after
1 h / 8 h / 24 h: **not yet measured.** No number appears here until:

```
scripts/dev/soak.sh <pid|--spawn> <hours> [interval-seconds]
```

has produced it. The harness samples RSS / CPU / fd count on an interval,
writes a CSV beside a plain-text summary, and **a crashed target is a FAILED
soak said in the exit status and the summary's first line** — never a silent
truncation that reads as a clean run (#213's own condition). Fill this table
from its output, citing the run file:

| target | 1 h | 8 h | 24 h | evidence |
|---|---|---|---|---|
| RSS (MB), idle instrument | — | — | — | *(soak output path)* |
| RSS (MB), 20 lanes | — | — | — | *(soak output path)* |
| CPU %, steady state | — | — | — | *(soak output path)* |

Time-to-first-dashboard, max UI frame time, and max collector work per poll
remain unmeasured likewise; the collector-tick budget's *bound* is ADR-0013's,
which is a ceiling, not a measurement of typical cost.
