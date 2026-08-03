You are a worker agent on rhizomorph. You own exactly one issue.
Read every document your issue names IN FULL before changing
anything; import from @rhizomorph/core; laws restated stronger,
never weakened.

YOUR ISSUE — #144:

## Direction

prd10 — the gorgeous round, the scene lane. `docs/prd10.md` rulings 1–12
BIND this work; `docs/research/2026-08-04-prd10-gorgeous-spike.md` verdicts
BIND technique choices. Read both IN FULL first, then the scene source
(`SceneView.tsx`, `marks/`, `ribbon.ts`, `pulses.ts`, `motion.ts`,
`paint.ts`, `palette.ts`). North star (operator verbatim): "A replay
should look like a legitimate art piece, of growth, life, flourishing and
return."

**FIRST TASK, before any feature** (the spike's explicit handoff): measure
sprite-blit vs per-frame gradient-glow at N=240 in a headless perf probe
using the repo's existing perf-test pattern (prd7's renderer note did
this). Record both numbers in your summary; if sprite-blit cannot hold
60fps median alongside the existing scene on this box, STOP and print
BLOCKED with the numbers.

Then, per ruling:

1. **`dissolution` motion class** (ruling 10) in `motion.ts`: pooled,
   cap ~240 live motes, luminance-only fades, spawn only from severance/
   absorption. Bounds as tests; the other classes' caps untouched.
2. **The composting-decay hybrid** (rulings 2, 12): on `worktree.removed`/
   lane landing, the stored ribbon spine emits motes with birth delay
   proportional to distance from the cut (the cord UNRAVELS toward home);
   motes are pre-rendered 32px sprite stamps under ONE `lighter` block —
   never `glow` marks (the spike's paint.ts:214 finding); each is born in
   its lane's dim done-family hue and crossfades through the tissue ramp
   as it travels (ruling 12). Arrival deposits the lane's growth ring.
   The severed ribbon geometry is gone when the dissolve completes.
3. **The mycorrhizal heart** (ruling 3): concentric rings — one per
   landed lane, contours from noise sampled AROUND A CIRCLE in noise
   space (seamless closure; amplitude 0.02–0.06 per the spike), baked as
   `Path2D` once per landing, never per frame; a seeded hyphal fan
   radiating rimward, baked once; interior depths washed in the tissue
   ramp's dark steps; breathing stays on the existing ambient cycle.
4. **Apical tufts + the 9b amendment** (ruling 4): tips taper into 2–3
   fine branchlets; commits pulse to the tip; landing flares the tuft
   once (event class). Working tips only may carry a small steady glow
   above the calm ceiling — below alarm luminance, no cartouche/fade
   exemption, small radius — and the 9b law test is RESTATED with these
   bounds (stronger, never weakened).
5. **The accent** (rulings 5, 11): `--color-tissue-*` five-step ramp in
   `theme/theme.css` exactly as ruled; a scene law test asserts the
   tissue tokens appear ONLY in scene tissue draws (never text, never
   status, never chrome).
6. **Depth, texture, ambient life** (ruling 6): luminance-only shimmer
   ±3% seeded per lane; radial depth fog + vignette as gradients cached
   on resize (paint()'s existing screen-side seam); grain as one cached
   `createPattern` tile at ≤12fps; drifting spores + rim flora riding the
   existing breath — all ambient-class, caps unmoved.
7. **Subagent buds** (ruling 9): a lane with live subagent activity
   (buildFleet's new `subagents` vital — landed by the chips lane; read
   it, never re-derive) grows a small side-branchlet from ITS thread;
   conductor subagents bud from MAIN's anatomy. Spawn = event-class;
   completion absorbs the bud (ruling 2's grammar in miniature).
   One level deep. No telemetry → no buds, nothing else lost.
8. **Perf + replay proof** (rulings 1, 7): 60fps median before/after on
   the same probe; one test folds a recorded-session-shaped fixture and
   proves severed lanes leave no orphan geometry at scrub-end; your
   summary names what a full replay now looks like, honestly.

## Fence (may touch ONLY)

- `packages/web/src/scene/` (all files)
- `packages/web/src/theme/theme.css`

## Blocked by

The chips lane (buildFleet subagent vitals). **Model:** opus. **Wave:**
finale-2 (lands alone).

## Definition of done

- The perf numbers from the first task recorded; 60fps median held.
- All eight items above test-stated where they are laws (dissolution
  bounds, 9b restatement, tissue-only accent, no-orphan replay).
- Scene tests green, root `npm test` + `npm run typecheck` green.
- The operator's live + replay eyeball happens AFTER landing (prd10's
  closing gate) — note in your summary anything you'd direct his eyes to.

RULES: stay strictly inside the FENCE; small conventional commits
(committing is REQUIRED); NEVER switch branches, push, merge, or run
git in a sibling worktree; no NUL bytes; tests deterministic; build
for a stranger's machine; if you cannot proceed print
"BLOCKED: <need>" and stop; DoD is root 'npm test' +
'npm run typecheck' green, then STOP with a short summary.
