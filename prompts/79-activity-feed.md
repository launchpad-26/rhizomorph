You are a worker agent building The Observatory (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #79 (79. Unified activity feed + provenance bar; the ticker dissolves (ruling 15))

## Direction

Two quiet surfaces.

**The feed** — the commit ticker grows into one unified activity feed:
commits, landings (worktree removed), lane starts/stops, collector
events — one quiet line each, filterable by kind and by lane (a selected
lane filters the feed via the keystone's selection context). Newest first,
bounded window, no animation beyond a new line appearing (motion is spent
by the scene, not here). Mono data, sans labels, shared formatter for
times/counts.

**The provenance bar** — the status bar evolves: ambient bottom line
naming each collector/source and its state (the existing collector-health
data), plus the gap-voice lines (ruling 12) for dead collectors — WHAT →
WHY → the command. Broken collectors ALSO escalate to the attention strip
via the fleet object's gap registry (already modelled in #75; you render
the bar, not the strip). Keep the existing mode/connection affordances
that live here today unless they moved to the shell in #75 — reconcile
minimally and say so.

**Delete `packages/web/src/panels/ticker/**`** — replaced by the feed.

Improve on: `spike-c-mycelium` → spike `ui/` provenance bar; the existing
ticker's event taps. Ice-neon register; status hues from tokens only.

## Fence (may touch ONLY)

- `packages/web/src/panels/feed/**` (the keystone's stub becomes yours)
- `packages/web/src/panels/ticker/**` (delete)
- `packages/web/src/app/StatusBar.tsx`, `packages/web/src/app/StatusBar.test.tsx`

## Blocked by

#75. **Model:** sonnet. **Wave:** 2.

## Definition of done

- Tests: feed folds all four kinds from fixture events; filter by kind;
  filter by selected lane; provenance bar states incl. gap voice for a
  dead collector; ticker gone, no dangling imports.
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @observatory/core, never redefine its types; small
conventional commits (committing is REQUIRED — review happens from your
branch); NEVER switch branches, push, merge, or run git in a sibling
worktree; no NUL bytes; tests must be deterministic (no waitFor racing
async work — stub or await the boundary; a flaky test blocks the gate);
build for a stranger's machine (no personal paths, 127.0.0.1 not [::1],
degrade loudly never silently); if you cannot proceed print "BLOCKED:
<need>" and stop; DoD is root 'npm test' + 'npm run typecheck' green,
then STOP with a short summary.
