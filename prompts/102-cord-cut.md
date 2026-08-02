## Direction (prd5 ruling 3 — the cord-cut, our novel piece)

**Nobody has built this.** Every graph tool restyles finished nodes and
leaves them attached; the Rhizomorph cuts the cord. Operator ruling:
build direct (no spike), staged retirement, **persistent scar with a
hide-finished toggle**.

**The three stages (~1.4 s total, structural motion class — #101's
constants and spring are landed; use them):**
1. **Tension release** (~150 ms): the thread's taper slackens — the
   line's curve loosens perceptibly at the root end.
2. **Retract** (~800 ms): the thread detaches at the root-mass and
   springs back toward its lane node — critically damped (ζ=1.0, ZERO
   bounce; use scene/spring.ts), the freed end tracing the thread's own
   path. The lane node drifts outward slightly toward the rim.
3. **Settle to scar** (~450 ms): what remains is a small desaturated
   mark near the rim — the lane's glyph + name at reduced ink, its
   figure (output tokens) kept. Recognisably PAST-tense: no pulse, no
   heat, never again part of the living network.

**Laws:**
- Scars are VISIBLE BY DEFAULT. A **hide-finished toggle** in the scene
  chrome hides/shows them (persisted pref, same mechanism as panel
  prefs). Hidden ≠ gone: the fleet table and replay still carry them.
- **Never fade to nothing** — invisible completion is indistinguishable
  from a bug (research law).
- The cut fires ONCE per lane, on the transition into DONE (or parked)
  — replay of history must not re-fire cuts for lanes already done at
  scrub time (the news-vs-history tag exists for exactly this).
- Cuts respect the structural concurrency cap (≤2 at once, stagger the
  rest); a wave of simultaneous landings queues its cuts.
- Reduced motion: no travel — the thread swaps to its severed/scar state
  in place; the pause control freezes mid-cut cleanly.

Read the staged-retirement pattern + prior-art reasoning in
docs/research/2026-08-01-obs-prd5-interaction-idioms.md §3 and
-motion-language.md §2. Load `emil-design-eng` AND `frontend-design`
before styling the scar; say so in your report. This is the piece the
whole prd exists for — polish it like it.

## Fence (may touch ONLY)

- `packages/web/src/scene/retire.ts` (new), `retire.test.ts` (new)
- `packages/web/src/scene/geometry.ts`, `geometry.test.ts`
- `packages/web/src/scene/marks/thread.ts`, `marks/node.ts`
- `packages/web/src/scene/marks.test.ts`
- `packages/web/src/scene/settle.ts`, `settle.test.ts`
- `packages/web/src/scene/resolve.ts`, `resolve.test.ts`
- `packages/web/src/scene/SceneView.tsx`, `SceneView.test.tsx` (toggle chrome ONLY)
- `packages/web/src/scene/index.tsx` (pref plumb ONLY)
- `packages/web/src/app/panelPrefs.ts`, `panelPrefs.test.ts` (the persisted pref)

## Blocked by

#100 (camera owns SceneView until it lands), #101 (spring.ts + motion
constants + structural cap). **Model:** opus. **Wave:** 3.

## Definition of done

- Tests: the three stages produce the right mark sequence on the display
  list (per-stage roles/inks queryable, no screenshots); cut fires once
  and never on history/replay; concurrency cap + stagger; scar persists
  with figure and never fully fades; toggle hides/shows + pref
  round-trips; reduced-motion swap-in-place.
- Verified in a real browser (dev server + `npx playwright` or
  description of manual check): a lane finishing LIVE visibly cuts and
  scars. Describe what it looks like.
- Root `npm test` + `npm run typecheck` green.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`), 12/12 green; out-of-fence failures verbatim.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments.** Never
  push, never merge, never switch branches.
- Build for a stranger's machine. `BLOCKED: <need>` if stuck.
