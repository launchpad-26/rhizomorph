## What was found (conductor verification of #110)

#110's self-heal is real but **unreachable across a restart**, so the
symptom it was filed against is still on screen.

Reproduction, just now, on `main` with #110 landed:

1. `observatory doctor` → `[ok] tmux found on PATH`; the collector's own
   command runs clean (`tmux list-panes -a -F …` → exit 0).
2. Server killed by port listener and restarted fresh — it logs
   `resuming session 1785544862176 (21908 events recorded)`.
3. The provenance bar STILL reads
   `TMUX COLLECTOR DISABLED — Command failed: tmux list-panes …`, and the
   attention strip still counts it (`1 NEED ATTENTION` with no lanes
   running).

**Why:** collector status is folded from the session's event history,
which contains an old `collector.disabled`. The new self-heal emits
`collector.recovered` only when the IN-PROCESS collector transitions
failing → succeeding. A freshly booted collector starts healthy in
memory, so it never "recovers", never emits, and the folded state stays
disabled for the life of the session log — through every restart.

The instrument is therefore showing a stale alarm **about itself**: the
same disease as #97 (stale alarms from removed worktrees), one layer in.

## Direction

Reconcile the live collector with the state it resumed into:

- On boot (and on every successful poll), compare the collector's actual
  result with the FOLDED status for that collector. If the fold says
  degraded/disabled and the poll succeeds, emit `collector.recovered` —
  the same event #110 added, now also reachable from the resume path.
- Equally: if the fold says healthy and the collector is disabled in
  memory, the fold must learn that too (no silent healthy-looking lie).
- Keep it honest about history: recovery is a NEW event appended, never
  a rewrite of the past (this is an event-sourced instrument).
- Test it the way it failed: fold a session containing
  `collector.disabled`, boot a collector whose command succeeds, assert
  a `collector.recovered` is emitted and the derived status is healthy.
  A test that only exercises the in-process transition is what let this
  through.

## Fence (may touch ONLY)

- `packages/server/src/server/collector-loader.ts` and its tests
- `packages/server/src/collectors/**`
- `packages/server/src/server/*.test.ts`
- `packages/core/src/state.ts`, `packages/core/src/reduce.ts`, `reduce.test.ts` (only if the reconciliation needs a selector; prefer server-side)

## Blocked by

#110 (landed). **Model:** sonnet. **Wave:** follow-up (resilience, part 2).

## Definition of done

- The reproduction above no longer reproduces: with a healthy tmux, a
  resumed server clears the disabled state and the attention strip drops
  the item. Say how you verified (a live run against this repo is
  available: `npm start -- <repo> --port 4400`).
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches x 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
