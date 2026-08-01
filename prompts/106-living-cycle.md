## Direction (prd6 rulings 1–4 — the living cycle)

Four changes, one metaphor: a lane is born at the centre, grows as it
works, sends its substance home when it lands, and rests at the rim as a
seed that can grow again.

**1. Absolute seed growth (ruling 1).** `geometry.ts:343` currently sets
`sizeFrac = log1p(outputTokens) / log1p(maxOutput)` — RELATIVE, so every
lane shrinks when one whale works harder, and growth never reads. Replace
with an absolute map: log against a fixed reference (suggest ~100K output
tokens = full size) with a hard ceiling so nothing balloons, and a floor
so a fresh lane is still visible. Export the reference + ceiling as named
constants; tests read them. A lane's size must not change when a sibling
grows.

**2. Distance is the lifecycle journey (ruling 4).** Distance from the
root-mass currently encodes RECENCY (`geometry.ts:189-195`, prd3 graft
g6). Replace: distance = how far through its life the lane is — born
near the centre, travelling outward as it works, retiring at the rim
(where the cord-cut already happens, so the two now tell one story).
Choose the progress signal from what the fleet object already knows and
justify it in a comment (candidates: activity state + work done +
age-since-first-event; DONE/retiring pins at the rim). **Recency keeps
the channel it already shares — thread lightness** (`thread.ts:92-93`);
say so where you remove it from distance. **Ruling g7 is untouched:
ANGLE is identity, stable for the session, never reordered.** The glide
between radii stays lawful motion (prd5 STRUCTURAL class).

**3. Severed substance returns home (ruling 2).** Extend the cord-cut
(`retire.ts`): during the retract, the lane's substance travels DOWN the
severing thread into the root-mass — a homeward flow, not a new invented
pulse (it is the thread's own matter). The root-mass then **visibly
thickens with accumulated session work**: `marks/root.ts` grows (mass
and/or halo) as landed output accumulates — absolute scale, hard cap,
same discipline as ruling 1. This is the honest reading of a merge: the
work is now part of main. Motion classes and the concurrency cap from
prd5 #101 govern — reuse `motion.ts`/`spring.ts`, invent no new grammar.

**4. Seeds germinate (ruling 3).** A retired lane keeps its slot. If its
handle returns (a re-dispatched lane with the same handle), a new thread
grows from the EXISTING seed at its old angle rather than a stranger
appearing elsewhere. The seed's retained size (ruling 1 — scars keep
their size, overruling #102's uniformity) carries over as the starting
point.

Load `emil-design-eng` before making motion/size choices; say so in your
report.

## Fence (may touch ONLY)

- `packages/web/src/scene/geometry.ts`, `geometry.test.ts`
- `packages/web/src/scene/retire.ts`, `retire.test.ts`
- `packages/web/src/scene/marks/thread.ts`, `marks/node.ts`, `marks/root.ts`, `marks/types.ts`
- `packages/web/src/scene/marks.test.ts`
- `packages/web/src/scene/settle.ts`, `settle.test.ts`
- `packages/web/src/scene/resolve.ts`, `resolve.test.ts`

Do NOT touch SceneView.tsx / index.tsx / camera.ts — #107 owns them this
wave.

## Blocked by

Nothing. **Model:** opus. **Wave:** 1 (keystone).

## Definition of done

- Tests: a lane's size is unchanged by a sibling's growth (the
  absolute-scale law); ceiling and floor hold at 10× the reference;
  distance is monotone in lifecycle progress and pins DONE at the rim;
  angle stability (g7) still proven; homeward flow marks appear during
  the cut and are absent from history/replay; root-mass mass/halo grows
  with landed output and caps; a returning handle germinates from its
  retained seed at its old angle, retaining size; existing cord-cut,
  scar-floor, motion-cap and reduced-motion laws all still green.
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
