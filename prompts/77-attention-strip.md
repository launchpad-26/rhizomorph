You are a worker agent building The Rhizomorph (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #77 (77. Attention strip + alarm ladder chrome + tab signals (rulings 5, 8, 14))

## Direction

The first-second answer to "anything need me?". Thin, always-present top
bar, single source of truth for tab signals, reading ONLY the keystone's
fleet object.

- **Calm state:** `ALL CLEAR` **with evidence** — `N lanes · M branches ·
  K files checked · collisions 0` (never bare reassurance; the evidence
  line exists only at CALM — the ladder floor in the model guarantees it,
  you render what it says).
- **Otherwise:** `N NEED ATTENTION` + named chips: lane + WHY (the
  evidence string from the detector — `no events — flatline 6m`, `hand
  raised — waiting on you 12s`) + how long. Worst rung first. Cap at 4
  chips + `+N` counter (C's triage rule). Click a chip → selects that lane
  (keystone's selection context) — the scene spotlights and the drawer
  (wave 3) will open from the same selection.
- **One attention pulse** when an item ARRIVES, then steady (ruling 10;
  `prefers-reduced-motion` kills the pulse).
- **Tab signals** (ruling 8): at NEEDS-YOU and above, tab title flips to
  `● N need you` and the favicon takes the worst rung's hue — both driven
  off the same ladder list the strip renders (B's pattern). Restore
  cleanly when calm.
- Replay interplay: in replay mode the shell swaps this strip for the
  REPLAY banner (#83) — you render nothing in replay; the keystone's
  mode-switch already handles the slot. Do not reach into replay files.

Improve on: `spike-c-mycelium` → `packages/web/src/spike/ui/` (strip,
chips, triage cap) and B's NOTES on evidence-bearing chips. Ice-neon
register; status hues only from theme tokens.

## Fence (may touch ONLY)

- `packages/web/src/panels/attention/**` (the keystone's stub becomes yours)

## Blocked by

#75. **Model:** sonnet. **Wave:** 2.

## Definition of done

- Tests: calm evidence line; chip naming + evidence strings; worst-first
  cap + `+N`; click → selection; title/favicon flip at needs-you and
  restore at calm; reduced-motion.
- 10+ lanes of chips never wrap the strip taller than its docked height.
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
