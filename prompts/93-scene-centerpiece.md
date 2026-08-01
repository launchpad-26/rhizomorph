## Direction (prd4 ruling 2)

The screen answers "what is the fleet doing?" first. The scene becomes the
centerpiece: directly under the attention/burn dock, hero-sized
(viewport-proportional — think min-h-[55vh]-ish, judged in a real browser,
not `h-64`), bright and self-explanatory (the #92 palette landed first).
Fleet table directly below as the legend/detail; ledger + collisions +
activity row last. The drawer keeps floating.

Specifics:
- `Shell.tsx`'s curated-order doc comment (prd3 ruling 6) is amended by
  this ruling — rewrite it citing prd4 ruling 2.
- `PanelGrid.tsx`: scene block moves above fleet; the heading-order pin in
  `Shell.test.tsx:151` updates to the new sequence.
- `SceneSlot.tsx`: hero sizing; reconcile the duplicate collapse
  affordance — SceneSlot's own unpersisted `collapsed` state vs
  PanelFrame's persisted one — into ONE mechanism (prefer PanelFrame's
  persisted prefs; the scene keeps its Focus affordance).
- `SceneView.tsx`: canvas sizing/DPR must track the larger host correctly
  (it currently assumes the small box); its `text-broken` failure banner
  is lawful under the new palette — leave the message, fix only sizing.
- Panel focus (#85) must still work for every panel at the new sizes; Esc
  precedence unchanged.

## Fence (may touch ONLY)

- `packages/web/src/app/Shell.tsx`, `packages/web/src/app/Shell.test.tsx`
- `packages/web/src/app/PanelGrid.tsx`, `packages/web/src/app/PanelGrid.test.tsx`
- `packages/web/src/app/SceneSlot.tsx`
- `packages/web/src/app/panelPrefs.ts`, `packages/web/src/app/panelPrefs.test.ts`
- `packages/web/src/scene/SceneView.tsx`, `packages/web/src/scene/SceneView.test.tsx`
- `packages/web/src/App.test.tsx` (order/mount pins — minimal reconciliation)

## Blocked by

#92 (colors land first) AND #94 (shared Shell/App test-file pins —
fence-lint regroom, see issue comment). **Model:** sonnet. **Wave:** 2.

## Definition of done

- Tests: new heading order pinned; one collapse mechanism with prefs
  round-trip; focus/Esc still proven at new sizes; scene canvas fills the
  hero host (DPR-aware) with a test asserting the host-driven size.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures reported verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments as you go.**
  Never push, never merge, never switch branches.
- Build for a stranger's machine — no user-specific paths or assumptions.
- If blocked, print `BLOCKED: <need>` and stop.
