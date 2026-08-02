You are a worker agent building The Rhizomorph (prd3: the instrument).
You own exactly one issue.

FIRST read, in order: docs/prd3.md IN FULL (all rulings, including the
laws 9-12 and the pick ruling 28-32 — they bind every surface), then
docs/architecture.md. Reference material, READ-ONLY: branch
spike-c-mycelium carries the winning spike under packages/web/src/spike/
(improve on it — never copy wholesale); branches spike-a-constellation
and spike-b-sigil-organism carry spike-artifacts/NOTES.md with the
grafted ideas (g1-g7).

YOUR ISSUE — #85 (85. Panel focus: any panel fills the view, Esc restores (ruling 6))

## Direction

Curated hierarchy + collapse stay (they exist); add FOCUS: any panel can
expand to fill the view, Esc (or an explicit control) restores the curated
order. No drag, no resize, no custom layouts (deferred, ruling 26).

- Focus is a per-panel affordance in the shared frame (`PanelFrame`),
  keyboard-reachable, one panel at a time.
- Esc precedence must be explicit and tested: an open drawer closes first,
  then selection clears, then focus exits (single keyboard spine — the
  keystone's selection context already handles its part; coordinate via
  the mode/selection contexts, do not fork a second Esc handler war).
- Collapse state (panelPrefs) and focus interact sanely: focusing a
  collapsed panel expands it for the duration; restoring returns it to its
  prior collapsed state. Prefs persist as they do today; focus itself is
  NOT persisted (a reload lands on the curated order).
- The scene, when focused, gets the full canvas (it already resizes; prove
  it doesn't distort).

## Fence (may touch ONLY)

- `packages/web/src/app/PanelFrame.tsx`, `packages/web/src/app/PanelFrame.test.tsx`
- `packages/web/src/app/PanelGrid.tsx`, `packages/web/src/app/PanelGrid.test.tsx`
- `packages/web/src/app/panelPrefs.ts`, `packages/web/src/app/panelPrefs.test.ts`
- `packages/web/src/App.test.tsx` (focus interactions surface in the shell test)

## Blocked by

#75 (owns these files in wave 1), #84 (Esc precedence with the drawer).
**Model:** sonnet. **Wave:** 3.

## Definition of done

- Tests: focus/restore per panel; Esc precedence chain (drawer → selection
  → focus); collapsed-panel focus round-trip; focus not persisted; scene
  focus resize smoke.
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
