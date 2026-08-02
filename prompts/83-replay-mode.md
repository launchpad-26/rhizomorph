You are a worker agent building The Rhizomorph (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #83 (83. Replay: full mode shift (ruling 16))

## Direction

Shown a replay mid-scrub, a first-time viewer says "this is the past"
unprompted (demo criterion 4). No new replay features — this is chrome.

- Distinct frame + tint for the whole app in replay mode: a mode-tint
  token treatment (from theme tokens; do not invent hues — this is a
  register shift, e.g. the ice world cooled/desaturated + a visible frame,
  never a status hue).
- The attention strip is replaced by a **REPLAY banner** (the keystone's
  mode-switched slot): timestamp being viewed, session identity,
  exit-to-live affordance. The banner owns the "past" statement.
- Scrubber redesigned as chrome: part of the frame, mono timestamps via
  the shared formatter, keyboard affordances kept. Same reducer, same
  panels — replay still drives everything (prd0 law).
- Reconcile the behavior-encoding tests fenced to you (banner text, mode
  badge assertions) — minimal reconciliation, on the record.

Improve on: the existing replay UI (sound since prd1) + prd3's register.

## Fence (may touch ONLY)

- `packages/web/src/replay/**`
- `packages/web/src/app/ReplayBar.tsx`
- `packages/web/src/app/ModeContext.tsx`
- `packages/web/src/app/ConnectionBadge.tsx`, `packages/web/src/app/ConnectionBadge.test.tsx`

## Blocked by

#75, #77. **Model:** sonnet. **Wave:** 3.

## Definition of done

- Tests: replay mode renders banner (not the strip) with timestamp +
  session + exit; tint/frame class applied at the shell level via the
  mode context; exit returns to live cleanly; scrubber still drives the
  fold (existing tests keep proving it).
- Root `npm test` + `npm run typecheck` green.

RULES: stay strictly inside the FENCE (other agents work in parallel);
import from @rhizomorph/core, never redefine its types; small
conventional commits (committing is REQUIRED — review happens from your
branch); NEVER switch branches, push, merge, or run git in a sibling
worktree; no NUL bytes; tests must be deterministic (no waitFor racing
async work — stub or await the boundary; a flaky test blocks the gate);
build for a stranger's machine (no personal paths, 127.0.0.1 not [::1],
degrade loudly never silently); if you cannot proceed print "BLOCKED:
<need>" and stop; DoD is root 'npm test' + 'npm run typecheck' green,
then STOP with a short summary.
