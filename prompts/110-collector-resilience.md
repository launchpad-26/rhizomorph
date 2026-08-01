## What was found (conductor verification at the prd6 close)

The provenance bar reads:

```
TMUX COLLECTOR DISABLED — Command failed: tmux list-panes -a -F
#{pane_id} #{session_name} … — run: observatory doctor
```

…while that exact command succeeds:

```
$ tmux list-panes -a -F '#{pane_id} #{session_name} #{window_index} …'
%0  obs 0 bash        /home/operator/worktrees-challenge bash …
%17 obs 9 observatory /home/operator/worktrees-challenge npm  …
exit=0
```

The failure was **transient** (the tmux server was churning — worker
windows being killed as lanes merged). The collector caught one failure,
disabled itself, and never tried again. Every pane-derived fact
(WAITING-vs-FROZEN inference, ATTACH identities, pane liveness) has been
silently stale ever since, for the rest of the session, recoverable only
by restarting the server.

The gap voice is doing its job — the disabled collector even escalated to
the attention strip, which is why the fleet reads "1 NEED ATTENTION" with
no lanes running. The honesty layer is right; the resilience layer is
missing.

## Direction

A collector that fails once should degrade, not die:

- **Retry with backoff.** A failing poll is retried; the collector
  disables only after N CONSECUTIVE failures (suggest 3), and the reason
  carries the count.
- **Self-heal.** A disabled collector keeps probing on a slow interval
  and RE-ENABLES on the first success, emitting an event so the
  provenance bar and the gap registry clear themselves. A monitor that
  needs a restart to notice the world recovered is not production-ready.
- **Say which state it is in.** Three honest states, not two:
  healthy / degraded-retrying (with the failure count and the last
  error) / disabled-after-N. The gap voice keeps its WHAT → WHY →
  command shape in each.
- Apply to every collector that can fail this way (tmux, workmux,
  sessionlog, otel), not just tmux — put the policy in one place they
  share rather than per-collector copies.

## Fence (may touch ONLY)

- `packages/server/src/server/collector-loader.ts` (or wherever the poll
  loop that catches these failures lives — read first, it is the shared
  seam)
- `packages/server/src/collectors/**`
- `packages/server/src/server/*.test.ts`, `packages/server/src/collectors/**/*.test.ts`
- `packages/core/src/collector.ts`, `packages/core/src/collector.test.ts` (ONLY if the state vocabulary lives there)

Do NOT touch the web package — the provenance bar and gap registry
already render whatever states they are given; if a new state needs a
web-side label, report it and leave it for a follow-up.

## Blocked by

Nothing. **Model:** sonnet. **Wave:** follow-up (resilience).

## Definition of done

- Tests: one failure does not disable (retry happens); N consecutive
  failures disable with a counted reason; a disabled collector
  re-enables on a later success and emits the recovery; the policy is
  shared, proven for at least two collectors.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches x 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
