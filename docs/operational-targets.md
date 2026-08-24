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
| Refusal records | **unbounded, on purpose — `MAX_REFUSALS` is `null`.** The retention seam is named here rather than decided: prd-19 leaves the number open, so a figure picked now would be a magic one. What makes unbounded defensible is upstream of the fold — the receiver throttles a refusal to at most one per offender per minute, so this slice grows with wall-clock minutes of a standing fault, not with the export volume of a misconfigured fleet, which is precisely the flood `MAX_ERRORS` above exists to cap. The drop branch stays reachable — a test drives a cap of three through `refusalStateWith`'s parameter — so whoever sets the constant inherits the position-index rebuild already exercised rather than dead. | `core/src/state.ts` (`MAX_REFUSALS`, `refusalStateWith`); `state.test.ts` pins the `null` ("names its retention seam rather than deciding it") and drives the cap separately |
| Telemetry / trace lookup tables | die with the array they index — `WeakMap`-keyed by identity, detached on take | `core/src/reduce.ts` (`UsageIndex` #179, `TraceIndex` #184, `CommitIndex` #342) |
| Fold projections (`byTrace`, `bySession`, `commits.bySha`/`order`) | memoized once per array identity, garbage-collected with it | `core/src/state.ts` (`traceStateOf`, `commitsStateOf`) |
| Collector subprocess work per tick | bounded per ADR | `docs/adr/0013-collector-ticks-are-bounded.md`; budget rationale in `docs/design-notes/collector-tick-budget.md` |
| Server in-memory event buffer | **no bound today**, and the asymmetry is the point: `session-recorder.ts:36`'s buffer is emptied only by `openSession()`, while the browser's fold of the same data caps itself at `MAX_EVENTS` in the first row above. One side has ruled and the other has not — and it is not free to close, because `/api/stream`'s replay contract and the exporter both assume the whole session is in memory, and each of sixteen `eventsSoFar()` callers copies the array whole. | `server/src/recorder/session-recorder.ts`; `REASONED` (not a measured leak) in `docs/review/2026-08-24-performance.md` §5; owned by prd-44 ruling 4, wave 2 (#37) |
| The recordings directory on disk | **no bound today.** Nothing prunes it — 37 files and 39 MB across repo slugs on one box already — and `/api/lane-index`'s cost is a function of that pile, so it grows for as long as the tool is used. The retention *answer* is booked as an operator act (prd-44 wave 0), never a default the code picks; enforcing it is the wave that follows. | `docs/review/2026-08-24-performance.md` §1; owned by prd-44 wave 3 (#38) |
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

## Frame time and collector work — measured 2026-08-24

Two of the three targets this page used to list as unmeasured now have numbers,
and they came from a dated artefact rather than a hope:
`docs/review/2026-08-24-performance.md`, executed on one box (macOS, Node 24,
this repo's own worktree and its own session directory). It carries the caveat
`scene/perf.test.ts` already carries, and it applies to both rows below:
absolute ms move with the box's load, so **ratios are the claim**. The
collector-tick *bound* is still ADR-0013's, which is a ceiling; the row below is
the measurement of typical cost sitting beside it. They are different claims,
which is why the retention table's `Collector subprocess work per tick` row
stays exactly as it reads.

| target | measured | evidence, with its caveats |
|---|---|---|
| Max UI frame time | 4.0 ms median at 30 living lanes (331 marks, 24% of budget); 10.8 ms at +100 retired (65%); **18.5 ms at +200 retired — 111%**, of which `buildFrame` is 14.9 ms; 17.1 ms at the 180-thread model floor (103%), of which `sceneMarks` is 15.0 ms. Worst-case frames reach 42–86 ms. | §6, running the repo's own `web/src/scene/perf.test.ts` against the 16.67 ms budget. Two honesty notes travel with the figures: `buildFrame` is CPU tessellation measured under jsdom, so a real frame is this *plus* GPU upload and draw; and `hideFinished` already reads 11.3 ms with 200 retired hidden, so the over-budget cell is a default-quality question rather than a wall. The 180-thread cell is prd-33 ruling 13's *declared* 30 fps size reproduced, not a defect — only the retired-lane axis is open work, and it is prd-44 ruling 5's. |
| Max collector work per poll | **306.7 / 289.8 / 343.4 ms** for a sequential tick against the six real collectors, real `exec`. Per-collector: `workmux` 230.2 ms on two subprocesses (**75% of the tick**), `git` 46.0 ms on four, `pi` 13.9, `sessionlog` 10.7, `tmux` 5.9, `judge` 0.0. | §4. Polling the six concurrently read 1.3× / 0.6× / 1.4× — no reliable win, and the hypothesis that the six-in-series loop was the headline cost is recorded as refuted rather than dropped. The measured box had 1 worktree, 2 branches and 0 tmux panes, so the per-entity loops that scale with the swarm did not appear in this figure at all; a proxy of that shape (20 spawns) read 282.4 ms sequential against 94.7 ms concurrent, **3.0×**, and the six-lane tick cost is `REASONED`, not run. |

## Time-to-first-dashboard — not yet measured

The third target still has no number, and none appears here until one is taken:
time `npm start` from process spawn to the first frame the browser paints, on a
cold page cache, and cite the run the way the cold-replay table above cites its
bench file. Two things to hold it honest when somebody does. Take it against a
repo with real history and real worktrees rather than an empty one: the first
poll tick is on that path and it is the row above, ~300 ms on a box with one
worktree and no panes. And measure the *dashboard*, not `/recordings` or a run
view — §1 of the same review measured `/api/lane-index` at **281 ms per
request**, starving the event loop while it runs, but both its call sites mount
on those two pages rather than on the balcony, so folding that cost into this
target would publish a number for a page nobody opened.
