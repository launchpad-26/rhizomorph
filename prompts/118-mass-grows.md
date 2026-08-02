## Why (operator ruling, after looking at the running app)

With a long session finished, the scene reads as a **wreath**: a ring of
retired lanes around a large empty middle, with a small mass at the
centre. The emptiness — not the marks — is what makes the picture feel
sparse. Operator's ruling: **grow the mass with the work.**

This is not a new encoding. prd6 ruling 2 already says the root-mass
thickens with accumulated landed work; it is simply far too weak to read.
After 38 landings and 2.5M output tokens the centre is still a small
blob, so the fact it is meant to express is invisible.

## Direction

- Drive the mass's scale from accumulated landed work **much harder**, on
  the absolute-with-a-cap discipline prd6 ruling 1 established for seeds
  (log against a fixed reference, hard ceiling — nothing balloons past
  it, and the same session always draws the same size).
- Express the ceiling **relative to the scene**, not in pixels: the mass
  must never crowd the rim or the lane labels at any zoom — cap it as a
  fraction of the distance to the retirement band, so a full centre and a
  ragged rim coexist instead of colliding.
- It must still read as the same body #117 built: translucent, layered,
  interior depth, no hard outline, core light integral to the form. Grow
  the body, do not inflate a balloon — the interior structure should gain
  detail as it grows rather than being scaled up uniformly.
- A quiet session must still look quiet. An empty fleet's mass is the
  floor, not a void: the un-instrumented floor law ("unknown, not zero")
  stands unchanged.

## What may NOT change

Every law in `marks.test.ts` / `contour.test.ts`: determinism (same state
→ same picture), the AMBIENT breath ≤3%, reduced-motion, the pause
control, the un-instrumented floor, canvas 2D, no shadowBlur. 60fps at 30
lanes — report frame cost before/after, since the contour walk already
doubled in #117 (1.8 → 3.5 ms) and a larger field costs more.

## Method

Load `emil-design-eng` and `ui-ux-pro-max` ("Biomimetic / Organic 2.0").
**Look at your work**: a server runs at 127.0.0.1:4400 against this repo,
`npx playwright` is cached. Take 2x crops of the whole scene at a small
fleet AND at this session's 38-lane history, and put what you saw in your
report — the point of this issue is a composition, and a composition can
only be judged by looking at it.

## Fence (may touch ONLY)

- `packages/web/src/scene/contour.ts`, `contour.test.ts`
- `packages/web/src/scene/marks/root.ts`
- `packages/web/src/scene/marks.test.ts` (root assertions only)
- `packages/web/src/scene/geometry.ts`, `geometry.test.ts` (ONLY if the cap must know the retirement radius)

## Blocked by

#117 (landed). **Model:** opus. **Wave:** composition.

## Definition of done

- The centre of a long session visibly holds the frame; before/after 2x
  crops described in the report.
- New law pinned: mass scale is monotone in accumulated landed work,
  absolute (unchanged by a sibling's growth), capped, and the cap is
  expressed against the scene's own geometry.
- Root `npm test` + `npm run typecheck` green; 3x4 load runs 12/12.
- Frame cost reported; 60fps preserved.

## RULES

- Work ONLY in this worktree. Never run git elsewhere.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
