## Direction (prd4 ruling 3 — ruling 29 amended)

Activity state gets real, guessable color, everywhere at once — the scene
and the fleet table (the legend, graft g1) speak the same colors. A layman
reads the scene like a status board. Two replacement laws:

- **Law 9a — hue is meaning, and each hue means one thing.** Green =
  productive, amber = blocked on a human, red = dead, cyan =
  notice/anomaly, ice = structure and nothing-to-say. Red only ever means
  broken. Ladder and activity merge into one semantic scale: needs-you is
  the incandescent end of the amber family, benign waiting its muted end —
  severity told by brightness, glow and enclosure.
- **Law 9b — the brightness band + alarm grammar own attention, not hue
  exclusivity.** Full-strength rung color and alarm treatments (glow,
  cartouche, fade exemption, the band above the calm ceiling) appear only
  on alarm marks; calm marks may wear family hues below the ceiling.

**Semantic map** (new theme tokens; scene mirrors in palette.ts):
working `#40d98c` · done `#2e9d74` (same family, dimmer; hollow/seal keeps
carrying live-vs-sealed) · waiting-benign `#d9a441` · needs-you `#ffc857`
(unchanged) · broken `#ff3d68` (unchanged) · notice `#4deaff` (unchanged) ·
idle = ICE_400 · unknown = ICE_600 · root/conductor stays ice (structure,
not status — the gap-honesty rule keeps operating on brightness alone).

**Brightness budget** (the "too dark/pale" fix, pinned so it can't
regress): CALM_CEILING 0.7→0.78; RECEDE stays 0.3; new ALARM_FLOOR=0.84
(every needs-you lane's brightest mark reaches it); new CALM_FLOOR=0.15
(minimum calm-thread brightness on the calm fixture); root RESTING_FLOOR
0.2→0.35 (+core/halo lifts). threadInk: resting `mix(ICE_500, ICE_100,
freshness)`, activity tint mixed in (≈0.45 working / 0.5 waiting / 0.35
done / 0 idle-unknown), alpha `0.5 + 0.3·freshness + 0.2·heat` (done
×0.85). Needs-you core marks (knot ring, hand palm, held-dot core, orbit
core) lifted via `hotter()` to ≈0.85–0.88 luminance. Broken is EXEMPT from
ALARM_FLOOR (red pinks above ~0.71); its supremacy = spotlight + recession
(calm recedes to ≤ CALM_CEILING×RECEDE) + cartouche — state it in a
comment and pin it in a test.

**New chokepoint:** `ACTIVITY_HUE: Record<LaneActivity, Rgb>` +
`activityInk(activity, freshness, heat)` in palette.ts, consumed by
thread.ts and node.ts (`hueOf` becomes activity-aware for pathology-free
lanes) — zero magic colors in marks/* stays true. palette.ts will need
ICE_500/300/100 mirrored (with palette.test rows). Labels/figures/gap
voice brighten (~ICE_300 @ 0.85).

**Sigils/table:** additive `ACTIVITY_TEXT_CLASS` + `stateTextClass(rank,
activity)` in fleet/sigils.tsx — `RANK_TEXT_CLASS`/`RANK_GLOW_CLASS`
exports UNCHANGED (attention strip + drawer consume them via the barrel;
those files are outside your fence). Table STATE cell uses
`stateTextClass`; reconsider the blanket `opacity-60` fade now that
idle/done carry their own dimness.

**Test evolution** — keep the tests-as-laws philosophy:
- Survive: theme↔palette lockstep (add rows), ramp monotonicity + blue>red,
  white-via-ramp, non-alarm ≤ CALM_CEILING sweep, RECEDE ratio, frozen vs
  waiting three-axis separation, render-everything at 20 lanes, mono/sans,
  sigil laws.
- Rephrase: "ladder hues out of the calm ramp" → **no status hue (all six)
  is a member of the ice ramp**; "calm fleet wears no ladder hue" → **"a
  calm fleet wears no alarm ink"** (no full NEEDS_YOU/BROKEN triple, all ≤
  ceiling; activity hues lawful).
- New pins: CALM_FLOOR; ALARM_FLOOR; dominance-under-recession (frozen's
  brightest mark > CALM_CEILING×RECEDE); hue-angle semantics (working
  within 15° of done and strictly brighter; waiting-benign within 10° of
  needs-you and strictly dimmer; green family ≥30° from notice; no status
  hue within 30° of broken); guessability (a working lane's node ink is
  green-dominant on the display list); table-is-legend re-pin (calm row
  uses the ACTIVITY class, alarmed row keeps the RANK class).
- palette.test's arithmetic pins (mix/cssColour) update only if their
  inputs changed.

## Fence (may touch ONLY)

- `packages/web/src/theme/theme.css`
- `packages/web/src/scene/palette.ts`, `packages/web/src/scene/palette.test.ts`
- `packages/web/src/scene/salience.ts`
- `packages/web/src/scene/marks/thread.ts`, `marks/node.ts`, `marks/root.ts`, `marks/light.ts`, `marks/index.ts`
- `packages/web/src/scene/marks.test.ts`
- `packages/web/src/fleet/sigils.tsx`, `packages/web/src/fleet/sigils.test.tsx`
- `packages/web/src/panels/fleet/index.tsx`, `packages/web/src/panels/fleet/format.ts`, `packages/web/src/panels/fleet/index.test.tsx`

Do NOT touch scene/geometry.ts, scene/SceneView.tsx, app/**, drawer/**,
panels/attention/** — other lanes/waves own them.

## Blocked by

Nothing. **Model:** opus. **Wave:** 1 (keystone).

## Definition of done

- All surviving laws green, rephrased laws in place, all new pins present
  and passing. Root `npm test` + `npm run typecheck` green.
- Sequencing inside the lane: tokens+constants+palette laws → salience
  constants+marks laws → re-ink marks to satisfy → sigil/table class maps.
- Load evidence: 3 batches × 4 concurrent runs (`npm test --
  --maxWorkers=5`) from the worktree root, 12/12 green; out-of-fence
  failures reported verbatim, files untouched.

## RULES

- Work ONLY in this worktree. Never run git in any other worktree or the
  main checkout.
- **Committing your work is REQUIRED — commit in increments as you go.**
  Never push, never merge, never switch branches.
- Build for a stranger's machine — no user-specific paths or assumptions.
- If blocked, print `BLOCKED: <need>` and stop.
