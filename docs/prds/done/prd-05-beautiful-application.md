# prd5 — a sleek, well formed, beautiful application

> **Outcome:** superseded by what actually shipped — see `docs/roadmap.md`.

prd4 made the instrument human-facing; prd5 makes it feel like a finished
product. Direction set at the prd4 close (issue #99, operator verbatim):
"drag around the scene, completed paths should not still be connected, a
little more animation; keep the theming and the mycelium; not just a
tool, but a sleek, well formed, beautiful application — production
ready." Research ran first (research → verify → build): four graded notes
in `docs/research/` — design inspiration (main), interaction idioms,
prior art, motion language — plus implementation vehicles **proven by
live probe**. Rulings from the grooming interview, operator, 2026-08-01:

## Rulings

1. **Scope: four packages + docs.** Camera keystone, cord-cut lifecycle,
   motion-budget-as-law, orientation extras. Far-zoom amalgamation is
   DEFERRED until lane counts demand it; audio pings are OUT.
2. **The camera adopts proven vehicles.** d3-zoom + d3-interpolate (ISC,
   ≤23 kB gz worst case, probed headless-on-canvas — camera laws are
   repo-testable in jsdom). The Figma-consensus gesture bundle: drag =
   pan, Ctrl/Cmd+wheel = zoom-at-cursor (pinch arrives as ctrlKey wheel),
   focal point is ALWAYS the pointer. Fit affordances: `1` zoom-to-fit,
   `0` reset, ± keys, two on-canvas buttons, and an auto-appearing
   Recenter button when scrolled away from content. No minimap yet.
3. **The cord-cut builds direct** (no spike round). Staged retirement,
   ~1.4 s: tension release → critically-damped retract (ζ=1.0, no
   bounce) → settle to a **persistent desaturated scar** near the rim.
   **Scars are visible by default, with a hide-finished toggle** to
   manage long-session clutter (operator's combined ruling). Never fade
   to nothing — invisible completion is indistinguishable from a bug.
   Done work stays auditable in the scene, the table, and replay.
4. **The motion budget is law**, pinned as tests the way CALM_FLOOR is:
   - *Ambient*: 4–8 s period, ≤3% amplitude, ignorable by design.
   - *Event*: pulse 400–600 ms; flare 150 ms in / 500 ms out; **≤5
     concurrent** (the human object-tracking limit) — above the cap,
     coalesce into one aggregate pulse. This extends the existing law
     "traffic is coalesced, never invented" to motion itself.
   - *Structural*: ~800 ms critically damped, ≤2 at once, 60–90 ms
     stagger.
   - Springs are the hand-rolled closed-form critically-damped step
     (k=170, c≈26 settles in 833 ms, zero overshoot; naive Euler
     diverges on long frames — the stability test is pinned).
   - **A pause control ships** (WCAG 2.2.2 Pause/Stop/Hide is Level A;
     an always-breathing canvas trips it). Reduced-motion keeps
     colour/opacity, drops travel and scale.
5. **Amber escalates with age.** A needs-you summons distinguishes
   "just asked" from "asked 40 minutes ago": chips gain a count-up and
   grow more insistent within the alarm motion class; the scene's alarm
   marks may intensify on the same clock. Binary rungs remain the
   severity AXIS; age modulates insistence within a rung, never
   promotes across rungs.
6. **Vehicles and taste.** No animation libraries (all DOM-bound; the
   spring is 15 tested lines). Build lanes load the installed
   `emil-design-eng` (animation decisions) and `frontend-design`
   (production register) skills and say so in their reports. xyflow
   (MIT) may be read for its drag-vs-select preset; tldraw is read-only
   (custom license) — never vendor its code.

## Implementation waves (issues #100–#105)

Wave 1: **#100** camera keystone (opus, scene) ∥ **#103** amber aging
(sonnet, attention strip) ∥ **#104** orientation extras (sonnet,
fleet/app keyboard). Wave 2, after #100: **#101** motion budget as law +
springs + pause (opus, scene). Wave 3, after #101: **#102** the cord-cut
(opus, scene — the novel piece rides on landed camera + springs).
Wave 4: **#105** docs/demo/screenshots. Conductor browser verification
per wave; gates run the bounded busy-box standard (prd3 rulings 33–34).
