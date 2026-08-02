# Observatory prd5 — design inspiration for a human-facing, production-ready instrument

> Researched 2026-08-01 to serve one decision: **what prd5 grooms** — the
> operator's session-close direction was "drag around the scene, completed
> paths should not still be connected, a little more animation; keep the
> theming and the mycelium; not just a tool but a sleek, well formed,
> beautiful application — production ready." Claims are graded in the three
> companion notes this synthesizes; this note carries the verdict.
>
> Companions (same directory, same date, all claims sourced there):
> - `2026-08-01-obs-prd5-interaction-idioms.md` — pan/zoom/drag + lifecycle
> - `2026-08-01-obs-prd5-prior-art.md` — agent GUIs, dashboards, RTS, NASA
> - `2026-08-01-obs-prd5-motion-language.md` — motion budget + [Ran] tests

## Headline finding

No existing agent-orchestration GUI has solved glanceable fleet status —
the ingredients live in *other* fields (RTS games, observability, mission
control, canvas editors), and the Observatory is already closer than the
prior art on honesty and register. prd5 is an assembly job with one novel
piece: **nobody has built "the cord is cut" for completed work** — CI
graphs and node editors restyle finished nodes but never detach them. That
one is ours to design, and the staged-retirement pattern below is the
recommended shape.

## The steal-list (ranked, source in brackets)

1. **d3-zoom on the existing canvas 2D** — `{k,x,y}` transform,
   `scaleExtent`/`translateExtent` bounds, van Wijk smooth zoom-to-fit
   animation, all library-provided; render loop just applies the matrix.
   [interaction note §1]
2. **The Figma-consensus gesture bundle**: drag = pan, Ctrl/Cmd+wheel =
   zoom-at-cursor (pinch arrives as ctrlKey wheel), Space+drag and
   middle-mouse = pan; pass the pointer as the focal point (d3 defaults to
   center — the classic mistake). Steal React Flow's "Figma preset" for
   the drag-vs-click-select conflict. [interaction §1, §4]
3. **Fit affordances covering 90%**: `1` zoom-to-fit, `0` reset, ± keys,
   two on-canvas buttons, and FigJam's auto-appearing **"Recenter"** button
   when scrolled away from content. Defer the minimap until lane counts
   demand it. [interaction §2]
4. **SC2's idle-worker button** as the attention strip's next evolution:
   "N need you" is already there — add the *jump-to-next* hotkey that
   cycles the camera/selection through needs-you lanes. [prior-art §3]
5. **Homeworld/SupCom zoom amalgamation**: at far zoom, lanes coalesce
   into readable group glyphs instead of shrinking into noise — the
   mycelium's answer to 30+ lanes, and it composes with ruling 31's
   labels-on-hover retreat. [prior-art §3]
6. **The three-stage cord-cut** (~1.4 s, the novel piece): tension release
   → spring retract at critical damping (ζ=1.0, no bounce) → settle to a
   persistent desaturated **scar** near the rim. Never fade to nothing —
   invisible completion is indistinguishable from a bug; done work stays
   auditable (Obsidian's orphans-toggle idiom). [interaction §3, motion §2]
7. **A three-class motion budget with a hard concurrency cap**: ambient
   (4–8 s period, ≤3% amplitude, ignorable), event (pulse 400–600 ms,
   flare 150 in / 500 out, **≤5 concurrent** — Pylyshyn & Storm's object-
   tracking limit; above it, coalesce into one aggregate pulse, extending
   the existing "coalesced, never invented" law to motion), structural
   (~800 ms critically damped, ≤2 at once, 60–90 ms stagger). Measured
   spring k=170/c≈26 settles at 833 ms with zero overshoot. [motion §1]
8. **Grafana's general-to-specific hierarchy + Honeycomb's "what's
   different" drill-down** as the panel doctrine below the scene — the
   fleet table and drawer already lean this way; make it explicit.
   [prior-art §2]
9. **NASA MCC glow discipline**: the 1967 "dazzle" lesson — few glowing
   elements on dark, brightness reserved for change. Already law 9b;
   cite it as the register's pedigree in docs. [prior-art §4]
10. **k9s single-key verbs** for the keyboard tier: one-key focus, park,
    attach-copy from the fleet table. [prior-art §2]

## Implementation facts that change the build ([Ran] in the motion note)

- Naive semi-implicit Euler springs **diverge on long frames** (dt=1/10 →
  −5.2e8 in 20 steps). Use the closed-form critically-damped step (stable
  at dt=2 s) or substep ≤1/30 — a background tab's first rAF after resume
  WILL hand you a long frame.
- Math is free, draw calls are not: 30 Bézier lanes + 3000 motes cost
  0.058 ms/frame in arithmetic. Kill `shadowBlur`, batch paths, layer
  static geometry to an offscreen canvas.
- **WCAG 2.2.2 (Pause, Stop, Hide) is Level A** and an always-breathing
  canvas trips it: production-ready requires a pause control, plus the
  reduced-motion table (keep colour/opacity, drop travel/scale).

## What to avoid (each with a scar behind it in the sources)

- Graph-canvas-first *editing* layouts (LangGraph/Flowise) — we are a
  monitor, not an editor; the scene orients, panels inform.
- Transcript-as-home-surface (Devin's lesson) — conversation stays in the
  drawer, one click away.
- Bare-wheel zoom without a focal point; scroll-hijacking; passive wheel
  listeners that can't `preventDefault`.
- Perpetual force-simulation jitter (`alphaTarget > alphaMin`) — organic ≠
  restless; run Physarum-style growth offline to author geometry.
- Decorative status hues and "one view for everything" (EVE's lesson).

## Verdict — what prd5 grooms

Wave-shaped, pending the operator's rulings:

1. **Camera keystone**: d3-zoom integration + gesture bundle + fit
   affordances (steal-list 1–3). One lane, scene fence.
2. **The cord-cut**: staged retirement for DONE/parked lanes with the
   scar as persistent history (steal-list 6) — the novel design; worth an
   opus lane and a short spike-with-screenshots before the ruling.
3. **Motion budget as law**: the three classes + cap-of-5 pinned as tests
   the way CALM_FLOOR is; springs via the closed-form step; the WCAG
   pause control (steal-list 7 + implementation facts).
4. **Orientation extras**: idle-worker jump hotkey; far-zoom amalgamation
   when lane counts justify it (steal-list 4–5).
5. **Keyboard tier + panel doctrine** (steal-list 8, 10) — cheap,
   high-polish.

## Open questions (for the operator / next session)

- Lane-count design ceiling: prior art reports humans track 3–5 agents
  comfortably (Conductor); ruling 22 demands 20+ render — is far-zoom
  amalgamation the reconciliation, and at what threshold?
- Should the amber needs-you state **escalate with age** (aviation idiom)
  or stay binary per the current ladder?
- Audio pings (RTS idiom) — in scope for a monitoring tool, or never?
- The cord-cut scar: does a scar-covered rim after a long session read as
  history or as clutter? (Spike will tell.)
- Two source gaps named in the motion note: Heer & Robertson's staging
  numbers came via citing works; Apple HIG motion page wouldn't render —
  both worth one retry before pinning numbers from them.

## Sources

Carried per-claim in the three companion notes (17 + 5-primary + WCAG/MDN
sets, each with URL and access date). This note intentionally cites only
its companions.
