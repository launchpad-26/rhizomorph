## Direction (prd5 ruling 4 — the motion budget becomes law)

The scene gets "a little more animation" the lawful way: a three-class
motion budget pinned as tests, the way CALM_FLOOR pinned brightness.
Numbers come from the graded research
(docs/research/2026-08-01-obs-prd5-motion-language.md); the operator
blessed them as rulings.

**The three classes (export the constants; tests read them):**
- `AMBIENT`: period 4–8 s, amplitude ≤3% — the root-mass breath and any
  new idle life must be ignorable. Must respect the pause control.
- `EVENT`: pulse 400–600 ms; flare 150 ms in / 500 ms out; **hard cap 5
  concurrent event animations** — above the cap, coalesce into ONE
  aggregate pulse carrying a count. This extends the existing law
  "traffic is coalesced, never invented" to motion itself. (Basis:
  the 4–5 object human tracking limit.)
- `STRUCTURAL`: ~800 ms, critically damped, ≤2 concurrent, 60–90 ms
  stagger when several lanes reflow.

**The spring is hand-rolled** — `packages/web/src/scene/spring.ts`
(new): the closed-form critically-damped step (position+velocity in,
dt-independent). Pin the stability law the research measured: naive
semi-implicit Euler DIVERGES on long frames (dt=1/10 → −5.2e8 in 20
steps); your closed-form step must be stable at dt=2 s, and k=170/c≈26
must settle within ~833 ms with zero overshoot — those are the test
assertions. No animation libraries (all DOM-bound; rejected in the
vehicles note).

**The pause control (WCAG 2.2.2 is Level A — production-blocking):** a
small affordance in the scene chrome that freezes ambient + event motion
(structural settles then stops); state visible ("MOTION PAUSED"),
keyboard reachable. `prefers-reduced-motion` continues to degrade as
today: keep colour/opacity, drop travel and scale — reconcile the
existing per-mark degradations with the new classes.

**Scene-side amber aging hook (ruling 5, scene half):** alarm marks may
intensify with the summons's age within the EVENT/alarm class (slower,
brighter pulse as age grows — never faster/frantic). Read the lane's
existing age evidence; #103 owns the strip side. Keep it subtle; the
cap and the ladder still rule.

Load `emil-design-eng` before making easing/duration choices; say so in
your report.

## Fence (may touch ONLY)

- `packages/web/src/scene/spring.ts` (new), `spring.test.ts` (new)
- `packages/web/src/scene/motion.ts` (new — the class constants), `motion.test.ts` (new)
- `packages/web/src/scene/pulses.ts`, `pulses.test.ts`
- `packages/web/src/scene/marks/frame.ts`, `marks/light.ts`, `marks/node.ts`
- `packages/web/src/scene/marks.test.ts`
- `packages/web/src/scene/SceneView.tsx`, `SceneView.test.tsx` (pause control + wiring ONLY — the camera landed in #100; do not rework it)
- `packages/web/src/scene/index.tsx` (pause state plumb ONLY)

## Blocked by

#100 (SceneView/index are its fence until it lands). **Model:** opus.
**Wave:** 2.

## Definition of done

- Law tests: cap-of-5 (6th concurrent event coalesces, count carried);
  ambient amplitude ≤3%; structural concurrency ≤2 with stagger; spring
  stability (dt=2 s) + settle-time (~833 ms, no overshoot); pause
  freezes ambient+event; reduced-motion table holds; alarm aging
  monotone and capped.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
