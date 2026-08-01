## Direction (prd5 ruling 2 — the camera keystone)

The scene becomes navigable: drag to pan, zoom at the cursor, and always
a one-keystroke way home. Adopt the PROVEN vehicles — this was probed
live, not guessed (docs/research/2026-08-01-obs-prd5-implementation-vehicles.md):

- **d3-zoom + d3-selection + d3-interpolate** (ISC, ≤23 kB gz worst case
  vs our 61.8 kB bundle; expect less after tree-shaking — report the real
  delta). d3-zoom drives a canvas 2D transform headlessly in jsdom —
  which means **camera laws are pinned in ordinary vitest tests**. One
  harness fact from the probe: tests must expose `global.SVGElement`
  (vitest's jsdom env does this already; a hand-rolled harness must).
- Render loop applies `ctx.setTransform(t.k, 0, 0, t.k, t.x, t.y)` before
  painting marks; chrome (gap voice, gutter text) stays unscaled.
- **zoom-to-fit** drives `interpolateZoom` (van Wijk arc + its suggested
  duration) from the scene's existing rAF loop — do NOT pull in
  d3-transition.

**Gestures (the Figma-consensus bundle):** drag = pan; Ctrl/Cmd+wheel =
zoom at the CURSOR (pass the pointer as focal point — d3 defaults to
center and that is the classic mistake); pinch arrives as ctrlKey wheel;
middle-mouse and Space+drag also pan. Drag must not steal click-select
on lane nodes — steal React Flow's Figma-preset resolution (read
xyflow, MIT, for the pattern; cite what you took).

**Affordances:** keys `1` zoom-to-fit, `0` reset, `+`/`-` step zoom; two
small on-canvas buttons (fit / reset) in the scene chrome; an
auto-appearing **Recenter** button when the content is fully out of
view. `scaleExtent` bounded (suggest [0.4, 6]); `translateExtent`
generous — if hard bounds feel wrong at hero size, say so in your report
rather than inventing rubber-banding.

**Law interactions:** the camera transform must compose with hover
hit-testing (`laneAt` works in world coordinates), label-policy hover,
selection clicks, and reduced-motion (fit animation degrades to a jump).
The sr-only SceneSummary is camera-independent — leave it.

Load the `emil-design-eng` skill before styling the affordances; note in
your report that you did.

## Fence (may touch ONLY)

- `packages/web/src/scene/camera.ts` (new), `camera.test.ts` (new)
- `packages/web/src/scene/SceneView.tsx`, `SceneView.test.tsx`
- `packages/web/src/scene/index.tsx`
- `packages/web/src/scene/paint.ts`
- `packages/web/src/scene/geometry.ts` (ONLY if hit-testing needs a
  world-coordinate helper; minimal)
- `packages/web/package.json` (the three d3 deps)

Root package-lock.json is landing mechanics — do NOT commit it; the
conductor syncs it at the gate.

## Blocked by

Nothing. **Model:** opus. **Wave:** 1 (keystone).

## Definition of done

- Camera-law tests in jsdom: zoom-at-pointer keeps the focal point
  fixed; scaleExtent clamps; fit computes the correct transform for a
  known layout; reset returns to identity; hit-testing correct under a
  non-identity transform; reduced-motion fit jumps.
- Gestures + affordances work in a real browser (you may verify with
  `npx playwright` against a dev server — describe what you saw).
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures reported
  verbatim, files untouched.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
