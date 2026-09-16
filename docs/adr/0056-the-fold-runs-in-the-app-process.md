# ADR-0056 — the fold runs in the app process, woken by the ingest seam

**Status:** accepted (prd-51 wave 11, #564)

## Context and Problem Statement

`packages/team/src/fold/worker.ts` exports `runOnce`, a complete and heavily tested fold pass:
it reads the ingest journal from a cursor, inserts the rows in one transaction, maintains the
three projections, and persists the cursor after the commit (prd-51 ruling 4). It shipped in
#373.

**Nothing called it.** `packages/team/deploy/serve.ts` started the HTTP server and passed no
`onBatch`, so `createTeamListener`'s `notify` was the default no-op. The result was measured on
a real host by #514's machine-plane drill: two ingest batches returned `202` with incrementing
`journalSeq`, `/data/journal/ingest.log` held 572 bytes of records, and
`select count(*) from events` returned `0` and stayed there. The data was unfolded, not lost —
the journal is append-only and a drain from position 0 recovers all of it — but nothing in the
deployment would ever perform that drain.

prd-51 wave 11 also ships the three questions in a browser (#557), which read
`spend_by_project_day`, `lane_state` and `collisions` — the three projections the fold maintains
and nothing else writes. Shipped against this deployment, that viewer would have been correct,
well-tested, and permanently empty.

So: something must schedule the fold. Where it runs is the decision.

## Considered Options

1. **In-process in the `app` container**, woken by the existing `onBatch` seam, with a drain at
   boot and a re-arming safety tick.
2. **A second `compose.yml` service** running a fold loop against the same journal volume.
3. **A periodic drain only**, no wake — a timer in the app process and nothing on the hot path.

## Decision Outcome

**Option 1.**

The seam already exists and is documented for exactly this: `api/main.ts` declares `onBatch` as
*"Wakes the fold worker. Defaults to doing nothing, which is correct for a server with no worker
attached."* Wiring it costs one callback.

**Option 2 loses on the cursor, not on taste.** `fold/cursor.ts` writes the cursor
tmp-then-rename with **no lock of any kind** — no `flock`, no O_EXCL, no pid file. The file
records a low-water mark computed from a read of the journal, so two processes folding the same
journal would each compute a mark from its own read and `rename(2)` over the other's. One of
them rewinding the other is not a slow path, it is a corrupted cursor, and the deployment has no
leader election to add cheaply. prd-51's 2026-09-16 amendment rules the same way and adds a
second reason: `compose.yml` is claimed by #557 in this wave, so taking it is a rebase conflict
already scheduled.

**Option 3 loses for no saving.** It pays a tick's worth of latency on every batch to avoid
using a seam that is already built and free. The tick is worth having as a *safety net* — which
option 1 keeps — but not as the only trigger.

## Consequences

- **The fold shares the app's process and event loop.** A large drain competes with request
  handling. The boot drain in particular runs immediately after `listen`, so a server coming up
  against a long-accumulated journal is busy while it catches up.
- **`readJournal` reads the whole journal file on every pass.** The tick therefore costs more as
  the file grows, and ADR-0046 already records that growth as unbounded. This decision makes that
  cost recurring rather than hypothetical. Journal truncation or rotation is the fix, and it is
  not in this wave.
- **The single-process assumption is now load-bearing.** Scaling the `app` service to two
  replicas would corrupt the fold cursor. Whoever needs that owns leader election or a real lock
  first; `docs/team-server-runbook.md` carries the warning where an operator will meet it.
- **A fold failure is invisible to the shipper, by design.** `wake()` cannot throw into the
  ingest path, because durability is the journal's job (ruling 4) and the fold is retried. The
  operator learns about it from the log, not the client — which means fold health needs a doctor
  check, and that is #558's in wave 12.
- **The boot drain is ordered after the partition top-up** and must stay there: the fold never
  issues DDL, so a row outside every existing partition fails its insert. A refactor that moved
  the drain earlier would fail closed on the first boot of a new month.

  **The first draft of this decision defeated that ordering on its own**, and it is recorded
  because the ordering reads as safe once stated. The safety tick was armed when the worker was
  constructed, which `deploy/serve.ts` does *before* `startTeamServer` — and that call re-runs
  the migration preflight and tops up the partitions before it listens. With the default 5000 ms
  any startup slower than five seconds fired a full fold first. No refactor was required; the
  code already did it. The tick is now armed from the drain's completion path, so the first tick
  cannot precede the boot drain, and a case with a real timer holds it there.
