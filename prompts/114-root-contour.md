## Direction (prd7 ruling 5 — the root-mass becomes one organic contour)

The centre is currently concentric rings — the most "drawn with shapes"
thing on screen, and the one the eye rests on. Replace it with a single
smooth organic contour that **melts** as work returns home.

- **Marching squares on a ~6px grid.** Measured in research: 1.28 ms/frame
  at our scale, versus 42.8 ms for per-pixel metaballs (108.5 ms with
  SDF+smin) — those are rejected on measurement, and they would also be
  untestable. Marching squares emits a **contour polygon**, so the
  root-mass stays a typed mark the tests can query.
- The field is a sum of a few smooth falloffs: the mass itself (scaled by
  accumulated landed work — prd6 ruling 2's thickening, keep that
  encoding exactly), plus a small contribution per homeward arrival so
  the surface bulges where substance is arriving and settles back.
- **`smin` is non-associative** — sort the blend by a stable id (lane
  handle) or the geometry flaps frame to frame. Pin that with a test:
  same state, shuffled input order, identical contour.
- The breath (prd5 AMBIENT class: 4–8 s period, ≤3% amplitude) moves the
  contour, not a separate ring. Reduced motion and the pause control
  behave exactly as today.
- Smooth the contour before filling (Chaikin corner-cutting, ≤3 passes —
  Sighack's MIT write-up is portable) so the grid never shows as
  stair-steps.

Keep: the root label, the gap-honesty behaviour when the conductor is
un-instrumented (the un-instrumented floor is a LAW — it must still read
as "unknown, not zero"), and every root-related assertion from #112's
restatement.

## Reading

Inigo Quilez on smooth minimum and 2D distance functions (technique, no
licence — reimplement). Sighack's Chaikin curves (MIT). **Never vendor:**
jasonwebb's repos (CC BY-NC-SA), thebookofshaders (All Rights Reserved).
Load `emil-design-eng` and `ui-ux-pro-max` ("Biomimetic / Organic 2.0"
card) and say what you took.

## Fence (may touch ONLY)

- `packages/web/src/scene/contour.ts` (new), `contour.test.ts` (new)
- `packages/web/src/scene/marks/root.ts`
- `packages/web/src/scene/marks/types.ts` (contour mark type only)
- `packages/web/src/scene/marks.test.ts` (root assertions only)
- `packages/web/src/scene/paint.ts` (contour painter only)

## Blocked by

#112, #113. **Model:** opus. **Wave:** 3.

## Definition of done

- The contour renders and melts with arrivals; order-independence pinned;
  breath/reduced-motion/pause intact; the un-instrumented floor law still
  green.
- **Frame cost measured and reported** (contour build + paint), 60fps
  preserved at 30 lanes.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
