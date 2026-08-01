## Direction (prd7 rulings 3 + 4 — the form keystone)

**Stop stroking lines; start filling ribbons.** Everything else follows.

### The ribbon

A thread stops being a stroked centre-line and becomes a **closed polygon
whose width varies along its length**, built with `perfect-freehand`
(MIT). Probed in our stack before this was written: a 24-point spine
yields an 88-point closed outline, byte-identical across calls, and 30
ribbons cost **0.172 ms/frame** — ~1% of budget.

- Feed our EXISTING width encoding in as per-point `pressure` with
  `simulatePressure: false`. The encoding does not change; only its
  expression does.
- Smooth the spine with `d3-shape`'s centripetal Catmull-Rom
  (`curveCatmullRom.alpha(0.5)`) — it **interpolates** the waypoints, so
  encoded positions stay exact (curveBasis does not; do not use it).
- Ribbons are geometry, not pixels: the outline lives on the mark, so the
  display list stays queryable (ruling 1's `structuredClone` guard from
  #112 must keep passing).

### Fewer shapes (the substitution table)

Each substitution spends **zero new objects** — the meaning moves into
the ribbon's own form. Roles keep their semantic names from #112; only
the drawing changes:

| meaning | was | becomes |
|---|---|---|
| expensive | 3 chevrons | asymmetric taper on the tip |
| severed | 2 cut strokes | a width pinch that closes to nothing |
| rank enclosure | cartouche ring | midpoint-displaced blob behind the label |
| done | seal bar | hue-only knot (no new geometry) |
| a commit | dot + wake | a travelling width swell along the ribbon |
| progress | arc | ribbon length itself |

`summons` (the raised hand) is the one place a legible glyph may survive
if form cannot carry it — if you keep it, say why in your report; the
fleet table is the legend, so the bar is high.

### Bounded uniqueness (ruling 4 — the channel table is law)

Variation comes from `simplex-noise` (MIT) seeded by a hash of the lane
handle (cyrb128 → mulberry32 → `createNoise2D`). Probed: a fresh instance
reproduces the same samples, so **replay stays identical**. NEVER
`Math.random`, never a time seed.

| channel | permission |
|---|---|
| position along life (radial) | **LOCKED** — it is the lifecycle encoding |
| hue | **LOCKED** — it is state |
| encoded width (work size) | **LOCKED** as the baseline… |
| …width jitter | ±10%, low-frequency only |
| sideways wander (normal) | ≤ ~0.3× lane spacing |
| curl phase / filament habit | free |

Pin the table as exported constants with tests: a lane's encoded facts
must be recoverable from its geometry despite the wander.

### What stays true

Canvas 2D. No shadowBlur. The prd5 motion budget (three classes, cap of
5), the pause control, `prefers-reduced-motion`, CALM_FLOOR/ALARM_FLOOR
and every law #112 restated. **60fps must survive** — measure and report
frame cost at 30 lanes.

## Reading (technique only — LICENCE TRAPS)

inconvergent's "Hyphae"/"Differential Line" (read, do not vendor —
archived Python), Tyler Hobbs' "Flow Fields" (no licence — reimplement,
never copy), Sighack's Chaikin curves (MIT, portable). **Never vendor:**
jasonwebb's growth repos are CC BY-NC-SA (non-commercial),
thebookofshaders' repo is All Rights Reserved, p5.js is LGPL. Growth
algorithms (space colonization, differential growth, Physarum) may only
author geometry OFFLINE on topology change — never live per frame.

Load `emil-design-eng`, `frontend-design`, and `ui-ux-pro-max` (its
"Biomimetic / Organic 2.0" card is your checklist). Say in your report
that you did, and what you took.

## Fence (may touch ONLY)

- `packages/web/src/scene/ribbon.ts` (new), `ribbon.test.ts` (new)
- `packages/web/src/scene/variation.ts` (new), `variation.test.ts` (new)
- `packages/web/src/scene/marks/{thread,node,light,types}.ts`
- `packages/web/src/scene/marks.test.ts`
- `packages/web/src/scene/paint.ts`
- `packages/web/src/scene/geometry.ts`, `geometry.test.ts`
- `packages/web/package.json` (perfect-freehand, simplex-noise, d3-shape)

Do NOT touch `marks/root.ts` — #114 owns the root-mass.

## Blocked by

#112 (semantic roles). **Model:** opus. **Wave:** 2 (keystone).

## Definition of done

- Ribbons render; the substitution table is implemented; the channel
  table is exported and pinned; determinism proven (same state → same
  geometry, twice, and across a fresh noise instance).
- Every law from #112 still green, unweakened.
- **Frame cost measured and reported** at 30 lanes (must stay ≤ ~4 ms of
  a 16.7 ms budget); bundle delta reported.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
